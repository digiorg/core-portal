import { ConfigReader } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { ScmIntegrations } from '@backstage/integration';
import type { ActionContext } from '@backstage/plugin-scaffolder-node';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPublishGiteaPullRequestAction } from './publishGiteaPullRequestAction';
import * as giteaClient from './giteaClient';

jest.mock('./giteaClient');

const mockedGiteaClient = giteaClient as jest.Mocked<typeof giteaClient>;

const CONFIGURED_TOKEN = 'configured-integration-token';
const GITEA_HOST = 'gitea-http.gitea.svc.cluster.local:3000';
const GITEA_BASE_URL = 'http://gitea-http.gitea.svc.cluster.local:3000';

function buildIntegrations() {
  return ScmIntegrations.fromConfig(
    new ConfigReader({
      integrations: {
        gitea: [
          {
            host: GITEA_HOST,
            baseUrl: GITEA_BASE_URL,
            password: CONFIGURED_TOKEN,
          },
        ],
        github: [{ host: 'github.com', token: 'unused' }],
      },
    }),
  );
}

function createWorkspace(files: Record<string, string>): string {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gitea-action-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(workspacePath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  return workspacePath;
}

function createContext(
  input: Record<string, unknown>,
  workspacePath: string,
): { ctx: ActionContext<any, any>; outputs: Record<string, unknown> } {
  const outputs: Record<string, unknown> = {};
  const ctx = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn(() => ctx.logger),
    },
    workspacePath,
    input,
    checkpoint: async ({ fn }: { fn: () => unknown }) => fn(),
    output: (name: string, value: unknown) => {
      outputs[name] = value;
    },
    createTemporaryDirectory: async () => fs.mkdtempSync(path.join(os.tmpdir(), 'gitea-action-tmp-')),
    getInitiatorCredentials: async () => ({} as never),
    task: { id: 'task-1' },
    isDryRun: false,
  } as unknown as ActionContext<any, any>;
  return { ctx, outputs };
}

const baseInput = {
  repoUrl: `${GITEA_HOST}?owner=DigiOrg&repo=app-config`,
  branchName: 'create-myapp-resource',
  targetBranchName: 'main',
  title: 'Create AppClaim myapp',
  description: 'Create AppClaim myapp',
};

// Resubmitting byte-identical generated content: getFileContents reports the
// file already matches what's on the branch, and there is no OPEN PR. Shared
// across the no-diff idempotency and concurrent-merge race suites below,
// which both start from this same "nothing new to commit" starting point.
function mockNoDiffNoOpenPr() {
  mockedGiteaClient.createBranch.mockResolvedValue(undefined);
  mockedGiteaClient.getFileContents.mockResolvedValue({
    sha: 'existing-sha',
    content: Buffer.from('kind: AppClaim\n').toString('base64'),
    encoding: 'base64',
  });
  mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
  // Default assumption for tests that don't care about this call: genuinely
  // no diff remains. Tests exercising the "real diff remains" path override
  // this.
  mockedGiteaClient.compareBranches.mockResolvedValue({ total_commits: 0 });
}

describe('createPublishGiteaPullRequestAction', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): clearAllMocks only wipes call
    // history, leaving a mockResolvedValue set by an earlier test as the
    // live implementation for the next one. That leak was harmless while
    // findLatestPullRequestByHead was only read by a couple of tests, but
    // the conflict-recovery paths now consult it from several branches, so
    // every test must start from a clean, unconfigured mock.
    jest.resetAllMocks();
  });

  it('exposes the expected action id', () => {
    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    expect(action.id).toBe('publish:gitea:pull-request');
  });

  it('does not declare a token input field in its schema', () => {
    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const inputSchema = action.schema?.input as unknown as { shape?: Record<string, unknown> };
    expect(inputSchema?.shape?.token).toBeUndefined();
  });

  it('rejects a repoUrl for a host with no configured gitea integration, before any network call', async () => {
    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'manifest.yaml': 'kind: AppClaim\n' });
    const { ctx } = createContext(
      { ...baseInput, repoUrl: 'unconfigured.example.com?owner=DigiOrg&repo=app-config' },
      workspacePath,
    );

    await expect(action.handler(ctx)).rejects.toThrow(InputError);
    expect(mockedGiteaClient.createBranch).not.toHaveBeenCalled();
  });

  it('rejects a targetPath containing ".." traversal, before any network call', async () => {
    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'manifest.yaml': 'kind: AppClaim\n' });
    const { ctx } = createContext({ ...baseInput, targetPath: '../../etc' }, workspacePath);

    await expect(action.handler(ctx)).rejects.toThrow(InputError);
    expect(mockedGiteaClient.createBranch).not.toHaveBeenCalled();
  });

  it('uses only the token from the configured gitea integration, ignoring any token on the input', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue(undefined);
    mockedGiteaClient.getFileContents.mockResolvedValue(undefined);
    mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
    mockedGiteaClient.createPullRequest.mockResolvedValue({
      number: 1,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/1`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
    });

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'manifest.yaml': 'kind: AppClaim\n' });
    const { ctx } = createContext({ ...baseInput, token: 'attacker-supplied-token' }, workspacePath);

    await action.handler(ctx);

    for (const call of mockedGiteaClient.createBranch.mock.calls) {
      expect(call[0].token).toBe(CONFIGURED_TOKEN);
    }
    for (const call of mockedGiteaClient.changeFiles.mock.calls) {
      expect(call[0].token).toBe(CONFIGURED_TOKEN);
    }
    expect(mockedGiteaClient.createBranch.mock.calls[0]?.[0].token).not.toBe('attacker-supplied-token');
  });

  it('never logs the configured token', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue(undefined);
    mockedGiteaClient.getFileContents.mockResolvedValue(undefined);
    mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
    mockedGiteaClient.createPullRequest.mockResolvedValue({
      number: 1,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/1`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
    });

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'manifest.yaml': 'kind: AppClaim\n' });
    const { ctx } = createContext(baseInput, workspacePath);

    await action.handler(ctx);

    const logger = ctx.logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
    for (const mockFn of [logger.info, logger.warn, logger.error, logger.debug]) {
      for (const call of mockFn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(CONFIGURED_TOKEN);
      }
    }
  });

  it('creates the branch, writes files under targetPath, and creates a PR, producing outputs', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue({ name: baseInput.branchName, commit: { id: 'sha' } });
    mockedGiteaClient.getFileContents.mockResolvedValue(undefined);
    mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
    mockedGiteaClient.createPullRequest.mockResolvedValue({
      number: 42,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
    });

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
    const { ctx, outputs } = createContext({ ...baseInput, targetPath: 'claims' }, workspacePath);

    await action.handler(ctx);

    expect(mockedGiteaClient.createBranch).toHaveBeenCalledWith(
      expect.anything(),
      'DigiOrg',
      'app-config',
      baseInput.branchName,
      'main',
    );
    expect(mockedGiteaClient.changeFiles).toHaveBeenCalledWith(
      expect.anything(),
      'DigiOrg',
      'app-config',
      expect.objectContaining({
        branch: baseInput.branchName,
        files: [expect.objectContaining({ operation: 'upload', path: 'claims/myapp.yaml' })],
      }),
    );
    expect(mockedGiteaClient.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DigiOrg',
      'app-config',
      expect.objectContaining({ head: baseInput.branchName, base: 'main' }),
    );
    // Issue #285 blocker #11: open-PR lookup must be scoped to the requested
    // base branch too, not just the head.
    expect(mockedGiteaClient.findOpenPullRequestByHead).toHaveBeenCalledWith(
      expect.anything(),
      'DigiOrg',
      'app-config',
      baseInput.branchName,
      'main',
    );
    expect(outputs.remoteUrl).toBe(`${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`);
    expect(outputs.pullRequestNumber).toBe(42);
    expect(outputs.targetBranchName).toBe('main');
  });

  it('is idempotent when re-run against an already-created branch, unchanged file, and open PR', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue(undefined);
    mockedGiteaClient.getFileContents.mockResolvedValue({
      sha: 'existing-sha',
      content: Buffer.from('kind: AppClaim\n').toString('base64'),
      encoding: 'base64',
    });
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue({
      number: 42,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
    });
    mockedGiteaClient.updatePullRequest.mockResolvedValue({
      number: 42,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
    });

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
    const { ctx, outputs } = createContext(baseInput, workspacePath);

    await action.handler(ctx);

    expect(mockedGiteaClient.changeFiles).not.toHaveBeenCalled();
    expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
    expect(mockedGiteaClient.updatePullRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DigiOrg',
      'app-config',
      42,
      expect.objectContaining({ title: baseInput.title }),
    );
    expect(outputs.pullRequestNumber).toBe(42);
  });

  it('falls back to locating the pull request in any state when createPullRequest reports a conflict (idempotent race)', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue(undefined);
    mockedGiteaClient.getFileContents.mockResolvedValue(undefined);
    mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
    mockedGiteaClient.createPullRequest.mockResolvedValue(undefined);
    // Issue #285 blocker: the conflict fallback must search every PR state
    // (not just open), so a PR that a concurrent run created -- and which
    // may since have been merged -- is still found.
    mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
      number: 42,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
      state: 'open',
      merged: false,
    });

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
    const { ctx, outputs } = createContext(baseInput, workspacePath);

    await action.handler(ctx);

    // An open PR found via the all-state lookup is adopted directly -- no
    // need to recompare against base.
    expect(mockedGiteaClient.compareBranches).not.toHaveBeenCalled();
    expect(outputs.pullRequestNumber).toBe(42);
  });

  it('always uses the configured integration baseUrl, never a value derived from repoUrl input (Issue #285 blocker #12: host pinning)', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue(undefined);
    mockedGiteaClient.getFileContents.mockResolvedValue(undefined);
    mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
    mockedGiteaClient.createPullRequest.mockResolvedValue({
      number: 1,
      html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/1`,
      head: { ref: baseInput.branchName },
      base: { ref: 'main' },
    });

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'manifest.yaml': 'kind: AppClaim\n' });
    // A repoUrl can only select among configured integration hosts (rejected
    // otherwise, see parseGiteaRepoUrl); it never supplies transport/baseUrl.
    const { ctx } = createContext(baseInput, workspacePath);

    await action.handler(ctx);

    for (const call of mockedGiteaClient.createBranch.mock.calls) {
      expect(call[0].baseUrl).toBe(GITEA_BASE_URL);
    }
    for (const call of mockedGiteaClient.changeFiles.mock.calls) {
      expect(call[0].baseUrl).toBe(GITEA_BASE_URL);
    }
  });

  it('throws when the PR can neither be created nor located', async () => {
    mockedGiteaClient.createBranch.mockResolvedValue(undefined);
    mockedGiteaClient.getFileContents.mockResolvedValue(undefined);
    mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
    mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
    mockedGiteaClient.createPullRequest.mockResolvedValue(undefined);

    const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
    const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
    const { ctx } = createContext(baseInput, workspacePath);

    await expect(action.handler(ctx)).rejects.toThrow();
  });

  describe('no-diff / closed-PR idempotency (Issue #285 blocker)', () => {
    // Resubmitting byte-identical generated content: getFileContents reports
    // the file already matches what's on the branch, and there is no OPEN
    // PR. That alone proves nothing about whether the branch still differs
    // from base (a closed-but-unmerged PR means it never landed), so the
    // action must consult the real Gitea signals -- findLatestPullRequestByHead
    // for the PR's actual state, and compareBranches (base...head) for
    // whether a diff genuinely remains -- rather than treating "no open PR
    // found" as either an automatic failure or "any PR found" as automatic
    // success. It must never call createPullRequest when there is truly no
    // diff to publish (Gitea 422s on "no commits between head and base").

    it('resubmitting identical content after the PR was merged, with no diff remaining against base, returns the merged PR (Issue #285 High: the merged flag alone is never trusted -- base...head is always compared first, since the branch may have received commits after the merge)', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 42,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: true,
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.changeFiles).not.toHaveBeenCalled();
      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
      expect(mockedGiteaClient.updatePullRequest).not.toHaveBeenCalled();
      // Unlike before, the merged flag is never trusted on its own: the
      // real base...head relationship is always checked directly.
      expect(mockedGiteaClient.compareBranches).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        'main',
        baseInput.branchName,
      );
      expect(mockedGiteaClient.findLatestPullRequestByHead).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        baseInput.branchName,
        'main',
      );
      expect(outputs.pullRequestNumber).toBe(42);
      expect(outputs.remoteUrl).toBe(`${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`);
    });

    it('creates a fresh PR when a historical PR was merged but the branch has since gained new commits ahead of base (Issue #285 High: a merged PR does not cover commits added after the merge, and cannot itself be reopened -- Gitea 412s any state change once HasMerged is true)', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.compareBranches.mockResolvedValue({ total_commits: 1 });
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 42,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/42`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: true,
      });
      mockedGiteaClient.createPullRequest.mockResolvedValue({
        number: 51,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/51`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'open',
        merged: false,
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.updatePullRequest).not.toHaveBeenCalled();
      expect(mockedGiteaClient.createPullRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        expect.objectContaining({ head: baseInput.branchName, base: 'main' }),
      );
      expect(outputs.pullRequestNumber).toBe(51);
    });

    it('resubmitting identical content when the closed PR is fully absorbed into base (genuine no base diff) returns it without reopening', async () => {
      mockNoDiffNoOpenPr();
      // Closed and NOT merged, but compareBranches (mocked to total_commits:
      // 0 by the helper) proves base already has everything -- e.g. it was
      // delivered by other means. Genuinely nothing left to do.
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 44,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/44`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: false,
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.compareBranches).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        'main',
        baseInput.branchName,
      );
      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
      expect(mockedGiteaClient.updatePullRequest).not.toHaveBeenCalled();
      expect(outputs.pullRequestNumber).toBe(44);
    });

    it('resubmitting identical content after the PR was closed without merging, while a real diff against base remains, reopens the PR instead of returning fake success', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.compareBranches.mockResolvedValue({ total_commits: 2 });
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 43,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/43`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: false,
      });
      mockedGiteaClient.updatePullRequest.mockResolvedValue({
        number: 43,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/43`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'open',
        merged: false,
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
      expect(mockedGiteaClient.updatePullRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        43,
        expect.objectContaining({ title: baseInput.title, body: baseInput.description, state: 'open' }),
      );
      expect(outputs.pullRequestNumber).toBe(43);
    });

    it('creates a new PR when the branch already has the desired files committed but no pull request exists at all, and a real diff against base remains', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.compareBranches.mockResolvedValue({ total_commits: 1 });
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue(undefined);
      mockedGiteaClient.createPullRequest.mockResolvedValue({
        number: 50,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/50`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'open',
        merged: false,
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.createPullRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        expect.objectContaining({ head: baseInput.branchName, base: 'main' }),
      );
      expect(outputs.pullRequestNumber).toBe(50);
    });

    it('throws a clear InputError when there is no diff and truly no existing pull request in any state', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue(undefined);

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx } = createContext(baseInput, workspacePath);

      await expect(action.handler(ctx)).rejects.toThrow(InputError);
      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
    });

    it('still creates a new PR when there are actual changes and no existing PR (new-create flow preserved)', async () => {
      mockedGiteaClient.createBranch.mockResolvedValue(undefined);
      mockedGiteaClient.getFileContents.mockResolvedValue(undefined); // file doesn't exist yet -> real diff
      mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
      mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
      mockedGiteaClient.createPullRequest.mockResolvedValue({
        number: 44,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/44`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.changeFiles).toHaveBeenCalled();
      expect(mockedGiteaClient.createPullRequest).toHaveBeenCalled();
      expect(mockedGiteaClient.findLatestPullRequestByHead).not.toHaveBeenCalled();
      expect(outputs.pullRequestNumber).toBe(44);
    });

    it('still updates the existing open PR when there are actual changes (open-update flow preserved)', async () => {
      mockedGiteaClient.createBranch.mockResolvedValue(undefined);
      mockedGiteaClient.getFileContents.mockResolvedValue(undefined); // real diff
      mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
      mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue({
        number: 45,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/45`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
      });
      mockedGiteaClient.updatePullRequest.mockResolvedValue({
        number: 45,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/45`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.updatePullRequest).toHaveBeenCalled();
      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
      expect(mockedGiteaClient.findLatestPullRequestByHead).not.toHaveBeenCalled();
      expect(outputs.pullRequestNumber).toBe(45);
    });

    it('never matches an unrelated closed PR with the same head but a different base branch', async () => {
      mockNoDiffNoOpenPr();
      // findLatestPullRequestByHead itself is responsible for base-scoping;
      // this test locks that the action passes the requested base through
      // rather than substituting a wildcard.
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue(undefined);

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx } = createContext(baseInput, workspacePath);

      await expect(action.handler(ctx)).rejects.toThrow(InputError);
      expect(mockedGiteaClient.findLatestPullRequestByHead).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        baseInput.branchName,
        'main',
      );
    });
  });

  describe('concurrent-merge races (Issue #285 Medium blocker)', () => {
    // A closed-but-unmerged PR can be merged by someone/something else in
    // the window between this action reading its state and the reopen
    // PATCH landing. Gitea rejects that PATCH with 412 (EditPullRequest,
    // v1.26.1: any `state` change once `pr.HasMerged` is true), which
    // giteaClient surfaces as `undefined` -- the same "conflict, re-resolve"
    // signal already used for createPullRequest's 409/422. The action must
    // recover by re-fetching the PR in any state and re-comparing base...head
    // rather than treating the 412 as a hard failure.
    it('recovers when a closed PR is merged concurrently between the diff check and the reopen PATCH (Gitea 412)', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.compareBranches
        .mockResolvedValueOnce({ total_commits: 2 }) // initial check: real diff remains
        .mockResolvedValueOnce({ total_commits: 0 }); // re-check after the race: absorbed by the concurrent merge
      mockedGiteaClient.findLatestPullRequestByHead
        .mockResolvedValueOnce({
          number: 43,
          html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/43`,
          head: { ref: baseInput.branchName },
          base: { ref: 'main' },
          state: 'closed',
          merged: false,
        })
        .mockResolvedValueOnce({
          number: 43,
          html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/43`,
          head: { ref: baseInput.branchName },
          base: { ref: 'main' },
          state: 'closed',
          merged: true,
        });
      // undefined signals the 412: Gitea rejected the state change because
      // the PR was merged concurrently.
      mockedGiteaClient.updatePullRequest.mockResolvedValue(undefined as unknown as giteaClient.GiteaPullRequest);

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.updatePullRequest).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        43,
        expect.objectContaining({ state: 'open' }),
      );
      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
      expect(mockedGiteaClient.findLatestPullRequestByHead).toHaveBeenCalledTimes(2);
      expect(mockedGiteaClient.compareBranches).toHaveBeenCalledTimes(2);
      expect(outputs.pullRequestNumber).toBe(43);
    });

    it('fails cleanly, without reporting false success, when the reopen 412s but a real diff against base is still pending after re-checking', async () => {
      mockNoDiffNoOpenPr();
      mockedGiteaClient.compareBranches.mockResolvedValue({ total_commits: 2 });
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 43,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/43`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: false,
      });
      mockedGiteaClient.updatePullRequest.mockResolvedValue(undefined as unknown as giteaClient.GiteaPullRequest);

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx } = createContext(baseInput, workspacePath);

      await expect(action.handler(ctx)).rejects.toThrow();
      expect(mockedGiteaClient.createPullRequest).not.toHaveBeenCalled();
    });

    it('recovers when createPullRequest conflicts (real file changes) because the conflicting PR was merged concurrently before the fallback lookup', async () => {
      mockedGiteaClient.createBranch.mockResolvedValue(undefined);
      mockedGiteaClient.getFileContents.mockResolvedValue(undefined); // real diff
      mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
      mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
      mockedGiteaClient.createPullRequest.mockResolvedValue(undefined);
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 60,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/60`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: true,
      });
      mockedGiteaClient.compareBranches.mockResolvedValue({ total_commits: 0 });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx, outputs } = createContext(baseInput, workspacePath);

      await action.handler(ctx);

      expect(mockedGiteaClient.compareBranches).toHaveBeenCalledWith(
        expect.anything(),
        'DigiOrg',
        'app-config',
        'main',
        baseInput.branchName,
      );
      expect(outputs.pullRequestNumber).toBe(60);
    });

    it('does not report success when createPullRequest conflicts and the conflicting PR is closed-unmerged -- it remains actionable, never silently swallowed', async () => {
      mockedGiteaClient.createBranch.mockResolvedValue(undefined);
      mockedGiteaClient.getFileContents.mockResolvedValue(undefined); // real diff
      mockedGiteaClient.changeFiles.mockResolvedValue(undefined);
      mockedGiteaClient.findOpenPullRequestByHead.mockResolvedValue(undefined);
      mockedGiteaClient.createPullRequest.mockResolvedValue(undefined);
      mockedGiteaClient.findLatestPullRequestByHead.mockResolvedValue({
        number: 61,
        html_url: `${GITEA_BASE_URL}/DigiOrg/app-config/pulls/61`,
        head: { ref: baseInput.branchName },
        base: { ref: 'main' },
        state: 'closed',
        merged: false,
      });

      const action = createPublishGiteaPullRequestAction({ integrations: buildIntegrations() });
      const workspacePath = createWorkspace({ 'myapp.yaml': 'kind: AppClaim\n' });
      const { ctx } = createContext(baseInput, workspacePath);

      await expect(action.handler(ctx)).rejects.toThrow();
      // A closed-unmerged PR is never merged, so there is nothing to
      // recompare against -- no false success is possible here.
      expect(mockedGiteaClient.compareBranches).not.toHaveBeenCalled();
    });
  });
});
