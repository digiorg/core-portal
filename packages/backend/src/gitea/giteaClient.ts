import {
  AuthenticationError,
  ConflictError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';

/**
 * Minimal, narrowly-scoped Gitea API v1 client used by the AppClaim
 * pull-request scaffolder action. Every call is a single bounded HTTP
 * request (fixed timeout, no retry/poll loops) so failures surface
 * immediately with a classified error instead of hanging the task.
 */
export interface GiteaClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface GiteaBranch {
  name: string;
  commit: { id: string };
}

export interface GiteaFileContents {
  sha: string;
  content: string;
  encoding: string;
}

export interface GiteaPullRequest {
  number: number;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  // Present on real Gitea responses (StateType/`merged` per
  // modules/structs/pull.go at v1.26.1) but left optional here so existing
  // call sites that only care about number/html_url/head/base are unaffected.
  state?: 'open' | 'closed';
  merged?: boolean;
}

export interface GiteaCompare {
  total_commits: number;
}

class GiteaResponseError extends Error {}

async function request(
  { baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS }: GiteaClientOptions,
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
  context: string,
): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1${path}`, {
      method: init.method,
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'timed out'
        : 'network error';
    throw new GiteaResponseError(`Gitea request failed while ${context}: ${reason}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (response.status === 401) {
    throw new AuthenticationError(`Gitea authentication failed while ${context}`);
  }
  if (response.status === 403) {
    throw new NotAllowedError(`Gitea denied access while ${context}`);
  }

  return { status: response.status, body };
}

function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

// owner/repo are always percent-encoded before being spliced into a Gitea
// API URL path, even though parseGiteaRepoUrl already rejects unsafe values
// at the input boundary -- defense-in-depth against any other caller (Issue
// #285 blocker #11).
function repoBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function getBranch(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  branch: string,
): Promise<GiteaBranch | undefined> {
  const context = `reading branch "${branch}" in ${owner}/${repo}`;
  const { status, body } = await request(
    opts,
    `${repoBase(owner, repo)}/branches/${encodeURIComponent(branch)}`,
    undefined,
    context,
  );
  if (status === 200) return body;
  if (status === 404) return undefined;
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

export async function createBranch(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  newBranch: string,
  fromBranch: string,
): Promise<GiteaBranch | undefined> {
  const context = `creating branch "${newBranch}" from "${fromBranch}" in ${owner}/${repo}`;
  const { status, body } = await request(
    opts,
    `${repoBase(owner, repo)}/branches`,
    { method: 'POST', body: { new_branch_name: newBranch, old_ref_name: fromBranch } },
    context,
  );
  if (status === 201) return body;
  if (status === 409) return undefined;
  if (status === 404) {
    throw new NotFoundError(
      `Base branch "${fromBranch}" not found in ${owner}/${repo}`,
    );
  }
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

export async function getFileContents(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<GiteaFileContents | undefined> {
  const context = `reading file "${path}" in ${owner}/${repo}`;
  const { status, body } = await request(
    opts,
    `${repoBase(owner, repo)}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`,
    undefined,
    context,
  );
  if (status === 200) return body;
  if (status === 404) return undefined;
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

/**
 * Gitea's contents API is split by method, not unified behind PUT: POST
 * creates a new file (no `sha`) and PUT updates an existing one (`sha`
 * required) -- confirmed against go-gitea/gitea's
 * templates/swagger/v1_json.tmpl at tag v1.26.1 (the appVersion this
 * platform's Gitea chart actually pins, apps/platform/gitea.yaml). Method
 * selection is based purely on whether a `sha` was supplied by the caller
 * (i.e. whether `getFileContents` found an existing file first).
 */
export async function putFileContents(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  path: string,
  params: { content: string; message: string; branch: string; sha?: string },
): Promise<void> {
  const isCreate = !params.sha;
  const context = `${isCreate ? 'creating' : 'updating'} file "${path}" on branch "${params.branch}" in ${owner}/${repo}`;
  const { status } = await request(
    opts,
    `${repoBase(owner, repo)}/contents/${encodeRepoPath(path)}`,
    { method: isCreate ? 'POST' : 'PUT', body: params },
    context,
  );
  if (status === 200 || status === 201) return;
  if (status === 409 || status === 422) {
    throw new ConflictError(
      `Conflicting ${isCreate ? 'creation' : 'update'} of "${path}" on branch "${params.branch}" in ${owner}/${repo}`,
    );
  }
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

export interface GiteaFileChange {
  operation: 'upload' | 'delete';
  path: string;
  content?: string;
  sha?: string;
}

/**
 * Commits every file change in one request -- Gitea's batch "change files"
 * endpoint (`POST /repos/{owner}/{repo}/contents`, confirmed against
 * templates/swagger/v1_json.tmpl at tag v1.26.1: `ChangeFilesOptions` /
 * `ChangeFileOperation`), so publishing N generated manifest files produces
 * exactly one commit instead of N (Issue #285 blocker #11: true one-commit
 * semantics, not merely a docs correction). `operation: "upload"` creates or
 * updates a file in the same call, so callers don't need to pre-classify
 * create vs. update per file the way the single-file putFileContents does.
 */
export async function changeFiles(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  params: { files: GiteaFileChange[]; message: string; branch: string },
): Promise<void> {
  const context = `committing ${params.files.length} file(s) on branch "${params.branch}" in ${owner}/${repo}`;
  const { status } = await request(
    opts,
    `${repoBase(owner, repo)}/contents`,
    { method: 'POST', body: params },
    context,
  );
  if (status === 201) return;
  if (status === 409 || status === 422) {
    throw new ConflictError(`Conflicting batch commit while ${context}`);
  }
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

const PULL_REQUEST_PAGE_SIZE = 50;
// Bounded, not unlimited: a runaway/misbehaving Gitea instance returning an
// endless stream of full pages must still fail closed rather than looping
// forever.
const MAX_PULL_REQUEST_PAGES = 20;

/**
 * Finds an open pull request matching both the given head AND base branch
 * (Issue #285 blocker #11: matching only head previously let an unrelated PR
 * from the same branch into a different base be mistaken for this one), by
 * paginating through every open PR rather than only the first 50 (Gitea's
 * default/previous page size here) -- a repository with more than 50 open
 * PRs would previously miss a genuine match past the first page.
 */
export async function findOpenPullRequestByHead(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<GiteaPullRequest | undefined> {
  for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
    const context = `listing open pull requests (page ${page}) in ${owner}/${repo}`;
    const { status, body } = await request(
      opts,
      `${repoBase(owner, repo)}/pulls?state=open&limit=${PULL_REQUEST_PAGE_SIZE}&page=${page}`,
      undefined,
      context,
    );
    if (status !== 200) {
      throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
    }
    const pulls: GiteaPullRequest[] = Array.isArray(body) ? body : [];
    const match = pulls.find(pr => pr.head?.ref === head && pr.base?.ref === base);
    if (match) return match;
    if (pulls.length < PULL_REQUEST_PAGE_SIZE) return undefined;
  }
  return undefined;
}

/**
 * Finds the most recent pull request matching both head AND base branch in
 * ANY state (open, merged, or closed), by paginating through every PR
 * (`state=all`, `base_branch` filter, `sort=recentupdate`) rather than
 * stopping at the first match -- since results are ordered by recent update
 * rather than PR number, the highest-numbered (truly latest) match may
 * appear on a later page than an earlier, lower-numbered one. Used to
 * recover idempotently when there is no diff to publish and no open PR
 * (Issue #285 blocker): the previously delivered PR for this exact head+base
 * pair, however it was resolved, is still the right thing to report back.
 */
export async function findLatestPullRequestByHead(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<GiteaPullRequest | undefined> {
  let best: GiteaPullRequest | undefined;
  for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
    const context = `listing pull requests in any state (page ${page}) in ${owner}/${repo}`;
    const { status, body } = await request(
      opts,
      `${repoBase(owner, repo)}/pulls?state=all&base_branch=${encodeURIComponent(base)}&sort=recentupdate&limit=${PULL_REQUEST_PAGE_SIZE}&page=${page}`,
      undefined,
      context,
    );
    if (status !== 200) {
      throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
    }
    const pulls: GiteaPullRequest[] = Array.isArray(body) ? body : [];
    for (const pr of pulls) {
      if (pr.head?.ref === head && pr.base?.ref === base) {
        if (!best || pr.number > best.number) {
          best = pr;
        }
      }
    }
    if (pulls.length < PULL_REQUEST_PAGE_SIZE) return best;
  }
  return best;
}

/**
 * Compares base...head via Gitea's compare endpoint (Issue #285 blocker:
 * matching each generated file's content against the branch's current HEAD
 * only proves nothing new needs to be committed to that branch -- it says
 * nothing about whether the branch as a whole still differs from base, e.g.
 * a previously rejected/closed-unmerged PR for the exact same content).
 * `total_commits` is the authoritative signal for that: confirmed against
 * go-gitea/gitea v1.26.1's routers/api/v1/repo/compare.go (`CompareDiff`,
 * `GET /repos/{owner}/{repo}/compare/{basehead}`), modules/structs
 * /repo_compare.go (`Compare.TotalCommits`), and routers/common/compare.go's
 * `ParseCompareRouterParam`, which tries the "..." separator
 * (`{base}...{head}`) before falling back to "..".
 */
export async function compareBranches(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<GiteaCompare> {
  const context = `comparing "${base}...${head}" in ${owner}/${repo}`;
  const { status, body } = await request(
    opts,
    `${repoBase(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    undefined,
    context,
  );
  if (status === 200) return body;
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

export async function createPullRequest(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  params: { head: string; base: string; title: string; body: string },
): Promise<GiteaPullRequest | undefined> {
  const context = `creating pull request for branch "${params.head}" in ${owner}/${repo}`;
  const { status, body } = await request(
    opts,
    `${repoBase(owner, repo)}/pulls`,
    { method: 'POST', body: params },
    context,
  );
  if (status === 201) return body;
  if (status === 409 || status === 422) return undefined;
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}

export async function updatePullRequest(
  opts: GiteaClientOptions,
  owner: string,
  repo: string,
  index: number,
  // `state` maps to Gitea's EditPullRequestOption.State (v1.26.1): setting it
  // to "open" reopens a closed-but-unmerged PR. A PR can be merged
  // concurrently between a caller observing it as closed-but-unmerged and
  // this PATCH landing; Gitea rejects any state change on an already-merged
  // PR with 412 (confirmed against go-gitea/gitea v1.26.1's
  // routers/api/v1/repo/pull.go, EditPullRequest: `if form.State != nil { if
  // pr.HasMerged { ...StatusPreconditionFailed... } }`).
  params: { title: string; body: string; state?: 'open' | 'closed' },
): Promise<GiteaPullRequest | undefined> {
  const context = `updating pull request #${index} in ${owner}/${repo}`;
  const { status, body } = await request(
    opts,
    `${repoBase(owner, repo)}/pulls/${index}`,
    { method: 'PATCH', body: params },
    context,
  );
  // Gitea v1.26.1 EditPullRequest returns 201 Created for a successful PATCH
  // (routers/api/v1/repo/pull.go), including reopening a closed PR.
  if (status === 201) return body;
  // Same "conflict, let the caller re-resolve" signal createPullRequest
  // already uses for its own 409/422: this is the concurrent-merge race
  // (Issue #285 Medium blocker), not a hard failure.
  if (status === 412) return undefined;
  throw new GiteaResponseError(`Unexpected Gitea response ${status} while ${context}`);
}
