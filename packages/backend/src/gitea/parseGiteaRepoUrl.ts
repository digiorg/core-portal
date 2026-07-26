import { InputError } from '@backstage/errors';
import type { ScmIntegrationRegistry } from '@backstage/integration';
import { parseRepoUrl } from '@backstage/plugin-scaffolder-node';

export interface GiteaDestination {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Resolves a `repoUrl` scaffolder input into a Gitea repository destination,
 * rejecting anything that isn't backed by a configured `integrations.gitea`
 * entry. Reuses Backstage's own `parseRepoUrl`, so an unconfigured host
 * fails with the same "No matching integration configuration" error the
 * platform already surfaces for GitHub today.
 */
export function parseGiteaRepoUrl(
  repoUrl: string | undefined,
  integrations: ScmIntegrationRegistry,
): GiteaDestination {
  if (!repoUrl) {
    throw new InputError(
      'The publish:gitea:pull-request action requires a repoUrl input, but none was provided',
    );
  }

  const { host, owner, repo } = parseRepoUrl(repoUrl, integrations);

  const integration = integrations.byHost(host);
  if (!integration || integration.type !== 'gitea') {
    throw new InputError(
      `Host "${host}" is not configured as a Gitea integration; add an entry under integrations.gitea`,
    );
  }

  if (!owner) {
    throw new InputError(
      `repoUrl "${repoUrl}" is missing the required "owner" query parameter`,
    );
  }
  if (!repo) {
    throw new InputError(
      `repoUrl "${repoUrl}" is missing the required "repo" query parameter`,
    );
  }

  // giteaClient splices owner/repo directly into Gitea API URL path
  // segments. Both are query-parameter values a template author controls,
  // so anything outside Gitea's own valid owner/repo charset (alphanumerics,
  // dash, underscore, dot) is rejected here -- at the input boundary --
  // rather than merely relying on downstream percent-encoding to stop a "/",
  // "..", "?" or "#" from altering the API route (Issue #285 blocker #11).
  const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
  for (const [field, value] of [
    ['owner', owner],
    ['repo', repo],
  ] as const) {
    if (!SAFE_IDENTIFIER.test(value) || value.includes('..')) {
      throw new InputError(
        `repoUrl "${repoUrl}" has a "${field}" value with characters outside Gitea's valid ${field} charset`,
      );
    }
  }

  return { host, owner, repo };
}

/**
 * Rejects absolute paths and `..` traversal segments in the repository
 * destination path, then returns a normalized relative path.
 */
export function sanitizeRepoTargetPath(targetPath: string | undefined): string {
  if (!targetPath) {
    return '';
  }
  if (targetPath.startsWith('/')) {
    throw new InputError(
      `targetPath must be a relative path, got "${targetPath}"`,
    );
  }
  const segments = targetPath.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.some(segment => segment === '..')) {
    throw new InputError(
      `targetPath must not contain ".." path traversal segments, got "${targetPath}"`,
    );
  }
  return segments.join('/');
}
