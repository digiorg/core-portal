import { AuthenticationError, NotAllowedError, NotFoundError, ConflictError } from '@backstage/errors';
import {
  changeFiles,
  compareBranches,
  createBranch,
  createPullRequest,
  findLatestPullRequestByHead,
  findOpenPullRequestByHead,
  getBranch,
  getFileContents,
  putFileContents,
  updatePullRequest,
  type GiteaClientOptions,
} from './giteaClient';

const SECRET_TOKEN = 'gitea-secret-token-value-12345';

const opts: GiteaClientOptions = {
  baseUrl: 'http://gitea-http.gitea.svc.cluster.local:3000',
  token: SECRET_TOKEN,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
  });
}

describe('giteaClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('request status classification', () => {
    it('sends the token in the Authorization header, never as a query param', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'main', commit: { id: 'abc' } }));
      await getBranch(opts, 'owner', 'repo', 'main');

      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).not.toContain(SECRET_TOKEN);
      expect((init.headers as Record<string, string>).Authorization).toBe(`token ${SECRET_TOKEN}`);
    });

    it('classifies 401 as AuthenticationError without leaking the token', async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, { message: 'unauthorized' }));
      await expect(getBranch(opts, 'owner', 'repo', 'main')).rejects.toBeInstanceOf(AuthenticationError);

      const error = (await getBranch(opts, 'owner', 'repo', 'main').catch(caught => caught)) as Error;
      expect(String(error.message)).not.toContain(SECRET_TOKEN);
    });

    it('classifies 403 as NotAllowedError', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(403, { message: 'forbidden' }));
      await expect(getBranch(opts, 'owner', 'repo', 'main')).rejects.toBeInstanceOf(NotAllowedError);
    });

    it('classifies an unexpected status as a generic error identifying the status code', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));
      await expect(getBranch(opts, 'owner', 'repo', 'main')).rejects.toThrow(/500/);
    });
  });

  describe('timeout handling', () => {
    it('aborts and rejects with a timeout-classified error when the request exceeds timeoutMs', async () => {
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      });

      await expect(
        getBranch({ ...opts, timeoutMs: 5 }, 'owner', 'repo', 'main'),
      ).rejects.toThrow(/timed out/);
    });

    it('does not leak the token in a timeout error message', async () => {
      fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const abortError = new Error('aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        });
      });

      const error = (await getBranch({ ...opts, timeoutMs: 5 }, 'owner', 'repo', 'main').catch(
        caught => caught,
      )) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(String(error.message)).not.toContain(SECRET_TOKEN);
    });
  });

  describe('getBranch', () => {
    it('returns the branch when found (200)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'main', commit: { id: 'abc' } }));
      await expect(getBranch(opts, 'owner', 'repo', 'main')).resolves.toEqual({
        name: 'main',
        commit: { id: 'abc' },
      });
    });

    it('returns undefined when the branch does not exist (404)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));
      await expect(getBranch(opts, 'owner', 'repo', 'missing')).resolves.toBeUndefined();
    });
  });

  describe('createBranch', () => {
    it('returns the new branch on success (201)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { name: 'feature', commit: { id: 'def' } }));
      await expect(createBranch(opts, 'owner', 'repo', 'feature', 'main')).resolves.toEqual({
        name: 'feature',
        commit: { id: 'def' },
      });
    });

    it('treats an existing branch (409) as idempotent success, not an error', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { message: 'already exists' }));
      await expect(createBranch(opts, 'owner', 'repo', 'feature', 'main')).resolves.toBeUndefined();
    });

    it('throws NotFoundError when the base branch is missing (404)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));
      await expect(createBranch(opts, 'owner', 'repo', 'feature', 'missing-base')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('getFileContents', () => {
    it('returns file contents on success (200)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { sha: 'sha1', content: 'Y29udGVudA==', encoding: 'base64' }),
      );
      await expect(getFileContents(opts, 'owner', 'repo', 'path/file.yaml', 'main')).resolves.toEqual({
        sha: 'sha1',
        content: 'Y29udGVudA==',
        encoding: 'base64',
      });
    });

    it('returns undefined when the file does not exist (404)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));
      await expect(getFileContents(opts, 'owner', 'repo', 'missing.yaml', 'main')).resolves.toBeUndefined();
    });
  });

  describe('putFileContents (Issue #285 blocker #10: exact Gitea method selection)', () => {
    // Gitea's contents API requires POST to create a new file (no sha) and
    // PUT to update an existing one (sha required) -- confirmed against
    // go-gitea/gitea's templates/swagger/v1_json.tmpl at tag v1.26.1 (the
    // appVersion this platform's Gitea chart actually pins,
    // apps/platform/gitea.yaml): POST responses 201/403/404/422/423, PUT
    // responses 200/201/403/404/422/423.
    it('uses POST when no sha is given (create)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { content: {} }));
      await putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
        content: 'Y29udGVudA==',
        message: 'add file',
        branch: 'feature',
      });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('POST');
    });

    it('uses PUT when a sha is given (update)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: {} }));
      await putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
        content: 'Y29udGVudA==',
        message: 'update file',
        branch: 'feature',
        sha: 'sha1',
      });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('PUT');
    });

    it('resolves on a successful create (201)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { content: {} }));
      await expect(
        putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
          content: 'Y29udGVudA==',
          message: 'add file',
          branch: 'feature',
        }),
      ).resolves.toBeUndefined();
    });

    it('resolves on a successful update (200)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: {} }));
      await expect(
        putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
          content: 'Y29udGVudA==',
          message: 'update file',
          branch: 'feature',
          sha: 'sha1',
        }),
      ).resolves.toBeUndefined();
    });

    it('resolves on an update that returns 201 (Gitea also returns 201 from PUT in some cases)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { content: {} }));
      await expect(
        putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
          content: 'Y29udGVudA==',
          message: 'update file',
          branch: 'feature',
          sha: 'sha1',
        }),
      ).resolves.toBeUndefined();
    });

    it('throws ConflictError on a conflicting update (409)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { message: 'conflict' }));
      await expect(
        putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
          content: 'Y29udGVudA==',
          message: 'update file',
          branch: 'feature',
          sha: 'sha1',
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('throws ConflictError when a create targets a path that already exists (422)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(422, { message: 'file already exists' }));
      await expect(
        putFileContents(opts, 'owner', 'repo', 'path/file.yaml', {
          content: 'Y29udGVudA==',
          message: 'add file',
          branch: 'feature',
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('changeFiles (Issue #285 blocker #11: true one-commit semantics)', () => {
    it('sends every file in a single POST request to the batch contents endpoint', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { commit: { sha: 'batch-sha' } }));
      await changeFiles(opts, 'owner', 'repo', {
        message: 'Create AppClaim myapp',
        branch: 'feature',
        files: [
          { operation: 'upload', path: 'claims/myapp.yaml', content: 'Y29udGVudA==' },
          { operation: 'upload', path: 'claims/myapp2.yaml', content: 'Y29udGVudA==', sha: 'sha1' },
        ],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('http://gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/owner/repo/contents');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.files).toHaveLength(2);
      expect(body.message).toBe('Create AppClaim myapp');
      expect(body.branch).toBe('feature');
    });

    it('resolves on success (201)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { commit: { sha: 'batch-sha' } }));
      await expect(
        changeFiles(opts, 'owner', 'repo', {
          message: 'm',
          branch: 'feature',
          files: [{ operation: 'upload', path: 'a.yaml', content: 'Y29udGVudA==' }],
        }),
      ).resolves.toBeUndefined();
    });

    it('throws ConflictError on a conflicting batch update (409)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { message: 'conflict' }));
      await expect(
        changeFiles(opts, 'owner', 'repo', {
          message: 'm',
          branch: 'feature',
          files: [{ operation: 'upload', path: 'a.yaml', content: 'Y29udGVudA==' }],
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe('owner/repo URL encoding (Issue #285 blocker #11 defense-in-depth)', () => {
    // parseGiteaRepoUrl already rejects unsafe owner/repo values at the
    // input boundary; giteaClient still encodes them itself so any other
    // future caller can never splice an unencoded path-altering value into
    // a Gitea API URL.
    it('percent-encodes an owner/repo containing characters requiring encoding', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'main', commit: { id: 'abc' } }));
      await getBranch(opts, 'my org', 'my repo', 'main');
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(
        'http://gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/my%20org/my%20repo/branches/main',
      );
    });
  });

  describe('findOpenPullRequestByHead', () => {
    it('finds an existing open PR by head ref for idempotent re-runs', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          { number: 7, html_url: 'http://gitea/owner/repo/pulls/7', head: { ref: 'feature' }, base: { ref: 'main' } },
        ]),
      );
      await expect(findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main')).resolves.toEqual({
        number: 7,
        html_url: 'http://gitea/owner/repo/pulls/7',
        head: { ref: 'feature' },
        base: { ref: 'main' },
      });
    });

    it('returns undefined when no open PR matches the head ref', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
      await expect(findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main')).resolves.toBeUndefined();
    });

    describe('base branch matching (Issue #285 blocker #11)', () => {
      it('does not match a PR with the same head but a different base branch', async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse(200, [
            {
              number: 9,
              html_url: 'http://gitea/owner/repo/pulls/9',
              head: { ref: 'feature' },
              base: { ref: 'release' },
            },
          ]),
        );
        await expect(
          findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main'),
        ).resolves.toBeUndefined();
      });

      it('matches only the PR whose head AND base both match the requested pair', async () => {
        fetchMock.mockResolvedValueOnce(
          jsonResponse(200, [
            { number: 5, html_url: 'x', head: { ref: 'feature' }, base: { ref: 'release' } },
            { number: 6, html_url: 'y', head: { ref: 'feature' }, base: { ref: 'main' } },
          ]),
        );
        await expect(
          findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main'),
        ).resolves.toMatchObject({ number: 6 });
      });
    });

    describe('pagination (Issue #285 blocker #11: not just the first 50)', () => {
      function prPage(pageNumber: number, count: number, matchOnLast?: boolean) {
        return Array.from({ length: count }, (_, i) => ({
          number: pageNumber * 100 + i,
          html_url: `http://gitea/owner/repo/pulls/${pageNumber * 100 + i}`,
          head: {
            ref: matchOnLast && i === count - 1 ? 'feature' : `other-${pageNumber}-${i}`,
          },
          base: { ref: 'main' },
        }));
      }

      it('fetches a second page when the first page is full (50 items)', async () => {
        fetchMock
          .mockResolvedValueOnce(jsonResponse(200, prPage(1, 50)))
          .mockResolvedValueOnce(jsonResponse(200, prPage(2, 1, true)));

        const result = await findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main');
        expect(result?.number).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [firstUrl] = fetchMock.mock.calls[0];
        const [secondUrl] = fetchMock.mock.calls[1];
        expect(String(firstUrl)).toContain('page=1');
        expect(String(secondUrl)).toContain('page=2');
      });

      it('stops paginating once a page returns fewer than the page size (no more pages)', async () => {
        fetchMock
          .mockResolvedValueOnce(jsonResponse(200, prPage(1, 50)))
          .mockResolvedValueOnce(jsonResponse(200, prPage(2, 3)));

        const result = await findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main');
        expect(result).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it('does not fetch a second page when the first page already matches', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, prPage(1, 50, true)));

        const result = await findOpenPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main');
        expect(result?.number).toBe(149);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('findLatestPullRequestByHead (Issue #285 blocker: no-diff/closed-PR idempotency)', () => {
    it('queries state=all with the base_branch filter and recentupdate sort', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
      await findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main');
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toContain('state=all');
      expect(String(url)).toContain('base_branch=main');
      expect(String(url)).toContain('sort=recentupdate');
    });

    it('finds a merged (closed) PR matching head and base', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          {
            number: 12,
            html_url: 'http://gitea/owner/repo/pulls/12',
            head: { ref: 'feature' },
            base: { ref: 'main' },
          },
        ]),
      );
      await expect(
        findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main'),
      ).resolves.toMatchObject({ number: 12 });
    });

    it('does not match a closed PR with the same head but a different base branch', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          {
            number: 13,
            html_url: 'http://gitea/owner/repo/pulls/13',
            head: { ref: 'feature' },
            base: { ref: 'release' },
          },
        ]),
      );
      await expect(
        findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main'),
      ).resolves.toBeUndefined();
    });

    it('returns the highest-numbered (latest) match across multiple closed PRs for the same head+base', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, [
          { number: 5, html_url: 'x', head: { ref: 'feature' }, base: { ref: 'main' } },
          { number: 20, html_url: 'y', head: { ref: 'feature' }, base: { ref: 'main' } },
          { number: 11, html_url: 'z', head: { ref: 'feature' }, base: { ref: 'main' } },
        ]),
      );
      await expect(
        findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main'),
      ).resolves.toMatchObject({ number: 20 });
    });

    it('returns undefined when no PR in any state matches', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
      await expect(
        findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main'),
      ).resolves.toBeUndefined();
    });

    it('paginates (bounded) across more than one page', async () => {
      const page1 = Array.from({ length: 50 }, (_, i) => ({
        number: 100 + i,
        html_url: `http://gitea/owner/repo/pulls/${100 + i}`,
        head: { ref: `other-${i}` },
        base: { ref: 'main' },
      }));
      const page2 = [
        { number: 200, html_url: 'http://gitea/owner/repo/pulls/200', head: { ref: 'feature' }, base: { ref: 'main' } },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(200, page1)).mockResolvedValueOnce(jsonResponse(200, page2));
      const result = await findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main');
      expect(result?.number).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops paginating once a page returns fewer than the page size', async () => {
      const page1 = Array.from({ length: 50 }, (_, i) => ({
        number: 100 + i,
        html_url: `http://gitea/owner/repo/pulls/${100 + i}`,
        head: { ref: `other-${i}` },
        base: { ref: 'main' },
      }));
      const page2 = [
        { number: 200, html_url: 'x', head: { ref: 'other' }, base: { ref: 'main' } },
      ];
      fetchMock.mockResolvedValueOnce(jsonResponse(200, page1)).mockResolvedValueOnce(jsonResponse(200, page2));
      const result = await findLatestPullRequestByHead(opts, 'owner', 'repo', 'feature', 'main');
      expect(result).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('createPullRequest', () => {
    it('returns the created PR (201)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, { number: 8, html_url: 'http://gitea/owner/repo/pulls/8', head: { ref: 'feature' }, base: { ref: 'main' } }),
      );
      await expect(
        createPullRequest(opts, 'owner', 'repo', { head: 'feature', base: 'main', title: 't', body: 'b' }),
      ).resolves.toMatchObject({ number: 8 });
    });

    it('treats a duplicate PR (409) as idempotent, returning undefined instead of throwing', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { message: 'already exists' }));
      await expect(
        createPullRequest(opts, 'owner', 'repo', { head: 'feature', base: 'main', title: 't', body: 'b' }),
      ).resolves.toBeUndefined();
    });

    it('treats no-diff (422) as idempotent, returning undefined instead of throwing', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(422, { message: 'no commits between main and feature' }));
      await expect(
        createPullRequest(opts, 'owner', 'repo', { head: 'feature', base: 'main', title: 't', body: 'b' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('updatePullRequest', () => {
    it('returns the updated PR (201, Gitea v1.26.1 EditPullRequest contract)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, { number: 8, html_url: 'http://gitea/owner/repo/pulls/8', head: { ref: 'feature' }, base: { ref: 'main' } }),
      );
      await expect(updatePullRequest(opts, 'owner', 'repo', 8, { title: 't', body: 'b' })).resolves.toMatchObject({
        number: 8,
      });
    });

    it('sends the state field when reopening a closed pull request (EditPullRequestOption.State, Gitea v1.26.1)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, {
          number: 8,
          html_url: 'http://gitea/owner/repo/pulls/8',
          head: { ref: 'feature' },
          base: { ref: 'main' },
          state: 'open',
          merged: false,
        }),
      );
      await updatePullRequest(opts, 'owner', 'repo', 8, { title: 't', body: 'b', state: 'open' });
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.state).toBe('open');
    });

    // Confirmed against go-gitea/gitea v1.26.1's
    // routers/api/v1/repo/pull.go (EditPullRequest): `if form.State != nil {
    // if pr.HasMerged { ctx.APIError(http.StatusPreconditionFailed, ...) } }`
    // -- a state change is rejected with 412 specifically when the PR was
    // merged after the caller last observed it, e.g. concurrently between a
    // closed-PR lookup and this reopen PATCH (Issue #285 blocker: reopen
    // race). Treated the same way createPullRequest treats its own
    // conflict statuses (409/422): return undefined so the caller can
    // re-resolve against Gitea's current state instead of a thrown error.
    it('returns undefined (not a thrown error) when Gitea rejects a state change on an already-merged PR (412 concurrent-merge race)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(412, { message: 'cannot change state of this pull request, it was already merged' }),
      );
      await expect(
        updatePullRequest(opts, 'owner', 'repo', 8, { title: 't', body: 'b', state: 'open' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('compareBranches (Issue #285 blocker: identical files vs branch HEAD do not prove no base diff)', () => {
    // Confirmed against go-gitea/gitea v1.26.1's
    // routers/api/v1/repo/compare.go (CompareDiff, registered at
    // `GET /repos/{owner}/{repo}/compare/*`) and
    // modules/structs/repo_compare.go (`Compare.TotalCommits`), and
    // routers/common/compare.go's ParseCompareRouterParam, which tries the
    // "..." separator first: `{baseBranch}...{headBranch}`.
    it('requests the compare endpoint using the "base...head" separator', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { total_commits: 0, commits: [] }));
      await compareBranches(opts, 'owner', 'repo', 'main', 'feature');
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(
        'http://gitea-http.gitea.svc.cluster.local:3000/api/v1/repos/owner/repo/compare/main...feature',
      );
    });

    it('returns total_commits reflecting a real, unmerged divergence', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { total_commits: 3, commits: [] }));
      await expect(compareBranches(opts, 'owner', 'repo', 'main', 'feature')).resolves.toMatchObject({
        total_commits: 3,
      });
    });

    it('returns zero total_commits when the head branch has already been fully absorbed into base', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { total_commits: 0, commits: [] }));
      await expect(compareBranches(opts, 'owner', 'repo', 'main', 'feature')).resolves.toMatchObject({
        total_commits: 0,
      });
    });

    it('throws on an unexpected status', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'not found' }));
      await expect(compareBranches(opts, 'owner', 'repo', 'main', 'feature')).rejects.toThrow(/404/);
    });
  });
});
