import { InputError } from '@backstage/errors';
import type { ScmIntegrationRegistry } from '@backstage/integration';
import {
  createTemplateAction,
  serializeDirectoryContents,
} from '@backstage/plugin-scaffolder-node';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import * as path from 'node:path';
import {
  changeFiles,
  compareBranches,
  createBranch,
  createPullRequest,
  findLatestPullRequestByHead,
  findOpenPullRequestByHead,
  getFileContents,
  updatePullRequest,
  type GiteaClientOptions,
  type GiteaFileChange,
  type GiteaPullRequest,
} from './giteaClient';
import { parseGiteaRepoUrl, sanitizeRepoTargetPath } from './parseGiteaRepoUrl';

export interface PublishGiteaPullRequestActionOptions {
  integrations: ScmIntegrationRegistry;
}

/**
 * Re-resolves a pull request after a conflicting write -- either
 * createPullRequest reporting a 409/422 conflict, or updatePullRequest
 * reporting a 412 (Gitea rejected a state change because the PR was merged
 * concurrently). In both cases another actor moved the PR between our last
 * read and this write, so the fix is to look at Gitea's current state again
 * rather than treat the conflict as a hard failure (Issue #285 Medium
 * blocker).
 *
 * Searches every PR state (not just open) since the conflict may have been
 * caused by a PR that has since been merged. A merged PR is only accepted as
 * success once a fresh compareBranches confirms no diff remains -- the
 * merge that caused our conflict might not be the one that resolves it. An
 * open PR is adopted directly. A closed-but-unmerged PR resolves nothing:
 * returning undefined here leaves it actionable rather than reporting false
 * success.
 */
async function resolvePullRequestAfterConflict(
  clientOptions: GiteaClientOptions,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<GiteaPullRequest | undefined> {
  const latest = await findLatestPullRequestByHead(clientOptions, owner, repo, head, base);
  if (!latest) return undefined;
  if (latest.state === 'open') return latest;
  if (latest.merged) {
    const compare = await compareBranches(clientOptions, owner, repo, base, head);
    return compare.total_commits === 0 ? latest : undefined;
  }
  return undefined;
}

/**
 * Scaffolder action that publishes generated files as a pull request against
 * a Gitea repository. Modeled on `publish:github:pull-request`'s input/output
 * shape so it is a drop-in replacement for the AppClaim GitOps delivery step,
 * but scoped down to exactly what that step needs: one commit (via Gitea's
 * batch "change files" API, `changeFiles`) of every generated manifest file
 * on a branch, and an idempotent pull request.
 *
 * The Gitea credential is read exclusively from the `integrations.gitea`
 * config entry matching the resolved host; the action never accepts or logs
 * a token supplied by a template.
 */
export function createPublishGiteaPullRequestAction(
  options: PublishGiteaPullRequestActionOptions,
) {
  const { integrations } = options;

  return createTemplateAction({
    id: 'publish:gitea:pull-request',
    schema: {
      input: {
        repoUrl: z =>
          z.string({
            description:
              'Accepts the format `gitea-host?repo=reponame&owner=owner` for a host configured under integrations.gitea',
          }),
        branchName: z =>
          z.string({ description: 'The name for the branch' }),
        targetBranchName: z =>
          z
            .string({ description: 'The base branch to open the pull request against' })
            .optional(),
        title: z => z.string({ description: 'The title of the pull request' }),
        description: z =>
          z.string({ description: 'The description of the pull request' }),
        sourcePath: z =>
          z
            .string({ description: 'Subdirectory of the workspace to copy changes from' })
            .optional(),
        targetPath: z =>
          z
            .string({ description: 'Subdirectory of the repository to write changes to' })
            .optional(),
      },
      output: {
        remoteUrl: z => z.string({ description: 'Link to the pull request in Gitea' }),
        targetBranchName: z =>
          z.string({ description: 'The base branch the pull request was opened against' }),
        pullRequestNumber: z => z.number({ description: 'The pull request number' }),
      },
    },
    async handler(ctx) {
      const {
        repoUrl,
        branchName,
        targetBranchName,
        title,
        description,
        sourcePath,
        targetPath,
      } = ctx.input;

      const destination = parseGiteaRepoUrl(repoUrl, integrations);
      const sanitizedTargetPath = sanitizeRepoTargetPath(targetPath);
      const baseBranch = targetBranchName ?? 'main';

      const giteaIntegration = integrations.gitea.byHost(destination.host);
      if (!giteaIntegration) {
        throw new InputError(
          `Host "${destination.host}" is not configured as a Gitea integration; add an entry under integrations.gitea`,
        );
      }
      const token = giteaIntegration.config.password;
      if (!token) {
        throw new InputError(
          `The Gitea integration for host "${destination.host}" has no configured token; set integrations.gitea[].password`,
        );
      }

      const clientOptions: GiteaClientOptions = {
        baseUrl: giteaIntegration.config.baseUrl ?? `https://${destination.host}`,
        token,
      };

      ctx.logger.info(
        `Publishing to ${destination.owner}/${destination.repo} on branch "${branchName}" (base "${baseBranch}")`,
      );

      await createBranch(clientOptions, destination.owner, destination.repo, branchName, baseBranch);

      const fileRoot = sourcePath
        ? resolveSafeChildPath(ctx.workspacePath, sourcePath)
        : ctx.workspacePath;
      const files = await serializeDirectoryContents(fileRoot, { gitignore: true });
      if (files.length === 0) {
        throw new InputError('No files were generated to publish; the workspace is empty');
      }

      const changes: GiteaFileChange[] = [];
      for (const file of files) {
        const repoPath = sanitizedTargetPath
          ? path.posix.join(sanitizedTargetPath, file.path)
          : file.path;
        const content = file.content.toString('base64');
        const existing = await getFileContents(
          clientOptions,
          destination.owner,
          destination.repo,
          repoPath,
          branchName,
        );
        if (existing?.content === content) {
          continue;
        }
        changes.push({ operation: 'upload', path: repoPath, content, sha: existing?.sha });
      }
      if (changes.length > 0) {
        await changeFiles(clientOptions, destination.owner, destination.repo, {
          files: changes,
          message: title,
          branch: branchName,
        });
      }

      let pullRequest: GiteaPullRequest | undefined = await findOpenPullRequestByHead(
        clientOptions,
        destination.owner,
        destination.repo,
        branchName,
        baseBranch,
      );

      if (pullRequest) {
        pullRequest = await updatePullRequest(
          clientOptions,
          destination.owner,
          destination.repo,
          pullRequest.number,
          { title, body: description },
        );
      } else if (changes.length === 0) {
        // Issue #285 blocker: nothing to commit (byte-identical content
        // resubmitted against the branch's current HEAD) and no open PR.
        // That per-file comparison only proves nothing new needs to be
        // committed to *this branch* -- it says nothing about whether the
        // branch still differs from base, so it cannot alone justify either
        // creating a PR (Gitea 422s on "no commits between head and base"
        // when it's genuinely a no-op) or declaring success (a prior PR for
        // this exact head+base may have been closed without ever merging,
        // i.e. undelivered). Resolve this with Gitea's real signals: the
        // latest pull request for this head+base pair in any state, and a
        // direct compare of base...head.
        const latestPullRequest = await findLatestPullRequestByHead(
          clientOptions,
          destination.owner,
          destination.repo,
          branchName,
          baseBranch,
        );

        // Issue #285 High: a historical PR's `merged` flag is never trusted
        // on its own -- the branch may have received commits after that
        // merge, so base...head is always compared directly first. Only
        // once that confirms no diff remains may a merged (or otherwise
        // resolved) historical PR stand in for success.
        const compare = await compareBranches(
          clientOptions,
          destination.owner,
          destination.repo,
          baseBranch,
          branchName,
        );
        const hasBaseDiff = compare.total_commits > 0;

        if (!hasBaseDiff) {
          if (!latestPullRequest) {
            throw new InputError(
              `No changes to publish for branch "${branchName}" in ${destination.owner}/${destination.repo}, ` +
                'and no existing pull request (open, merged, or closed) was found for this head and base branch',
            );
          }
          // No diff remains against base, whether because the found PR was
          // merged or because it was delivered by other means -- genuinely
          // nothing left to do.
          pullRequest = latestPullRequest;
        } else if (latestPullRequest?.merged) {
          // A real diff remains despite a merged historical PR: the branch
          // picked up commits after that merge, which the merged PR does
          // not cover. Merged PRs can never be reopened (Gitea 412s any
          // state change once HasMerged is true), so the only valid way to
          // deliver the residual diff is a fresh PR.
          pullRequest = await createPullRequest(clientOptions, destination.owner, destination.repo, {
            head: branchName,
            base: baseBranch,
            title,
            body: description,
          });
          if (!pullRequest) {
            pullRequest = await resolvePullRequestAfterConflict(
              clientOptions,
              destination.owner,
              destination.repo,
              branchName,
              baseBranch,
            );
          }
        } else if (latestPullRequest?.state === 'closed') {
          // Closed without merging: the change was rejected and never
          // delivered. A closed PR must never be reported as success --
          // reopen it so the still-pending diff is surfaced again.
          const reopened = await updatePullRequest(
            clientOptions,
            destination.owner,
            destination.repo,
            latestPullRequest.number,
            { title, body: description, state: 'open' },
          );
          // undefined means Gitea returned 412: the PR was merged
          // concurrently, between the lookup above and this PATCH landing
          // (Issue #285 Medium blocker). Re-resolve against Gitea's current
          // state instead of failing outright.
          pullRequest =
            reopened ??
            (await resolvePullRequestAfterConflict(
              clientOptions,
              destination.owner,
              destination.repo,
              branchName,
              baseBranch,
            ));
        } else {
          // No pull request exists at all for this head+base, yet the
          // branch genuinely diverges from base: it was never delivered.
          pullRequest = await createPullRequest(clientOptions, destination.owner, destination.repo, {
            head: branchName,
            base: baseBranch,
            title,
            body: description,
          });
          if (!pullRequest) {
            pullRequest = await resolvePullRequestAfterConflict(
              clientOptions,
              destination.owner,
              destination.repo,
              branchName,
              baseBranch,
            );
          }
        }
      } else {
        pullRequest = await createPullRequest(clientOptions, destination.owner, destination.repo, {
          head: branchName,
          base: baseBranch,
          title,
          body: description,
        });
        if (!pullRequest) {
          pullRequest = await resolvePullRequestAfterConflict(
            clientOptions,
            destination.owner,
            destination.repo,
            branchName,
            baseBranch,
          );
        }
      }

      if (!pullRequest) {
        throw new Error(
          `Failed to create or locate a pull request for branch "${branchName}" in ${destination.owner}/${destination.repo}`,
        );
      }

      ctx.output('remoteUrl', pullRequest.html_url);
      ctx.output('targetBranchName', pullRequest.base.ref);
      ctx.output('pullRequestNumber', pullRequest.number);
    },
  });
}
