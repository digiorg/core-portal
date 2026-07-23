import { ConfigReader } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { ScmIntegrations } from '@backstage/integration';
import { parseGiteaRepoUrl, sanitizeRepoTargetPath } from './parseGiteaRepoUrl';

function integrationsWithGitea() {
  return ScmIntegrations.fromConfig(
    new ConfigReader({
      integrations: {
        gitea: [
          {
            host: 'gitea-http.gitea.svc.cluster.local:3000',
            baseUrl: 'http://gitea-http.gitea.svc.cluster.local:3000',
            password: 'unused-in-parse-tests',
          },
        ],
        github: [{ host: 'github.com', token: 'unused' }],
      },
    }),
  );
}

describe('parseGiteaRepoUrl', () => {
  it('resolves host/owner/repo for a repoUrl backed by a configured gitea integration', () => {
    const integrations = integrationsWithGitea();
    const result = parseGiteaRepoUrl(
      'gitea-http.gitea.svc.cluster.local:3000?owner=DigiOrg&repo=app-config',
      integrations,
    );
    expect(result).toEqual({
      host: 'gitea-http.gitea.svc.cluster.local:3000',
      owner: 'DigiOrg',
      repo: 'app-config',
    });
  });

  it('throws InputError when repoUrl is undefined', () => {
    const integrations = integrationsWithGitea();
    expect(() => parseGiteaRepoUrl(undefined, integrations)).toThrow(InputError);
  });

  it('rejects a host that has no integration configured at all', () => {
    const integrations = integrationsWithGitea();
    expect(() =>
      parseGiteaRepoUrl('unconfigured.example.com?owner=DigiOrg&repo=app-config', integrations),
    ).toThrow(InputError);
  });

  it('rejects a host that is configured, but only as a non-gitea (e.g. github) integration', () => {
    const integrations = integrationsWithGitea();
    expect(() =>
      parseGiteaRepoUrl('github.com?owner=DigiOrg&repo=app-config', integrations),
    ).toThrow(/not configured as a Gitea integration/);
  });

  it('rejects a repoUrl missing the owner query parameter', () => {
    const integrations = integrationsWithGitea();
    expect(() =>
      parseGiteaRepoUrl('gitea-http.gitea.svc.cluster.local:3000?repo=app-config', integrations),
    ).toThrow(/owner/);
  });

  it('rejects a repoUrl missing the repo query parameter', () => {
    const integrations = integrationsWithGitea();
    expect(() =>
      parseGiteaRepoUrl('gitea-http.gitea.svc.cluster.local:3000?owner=DigiOrg', integrations),
    ).toThrow(/repo/);
  });

  describe('owner/repo identifier hardening (Issue #285 blocker #11)', () => {
    // A repoUrl's owner/repo are attacker-influenceable query values (the
    // scaffolder template author controls repoUrl). giteaClient splices them
    // directly into Gitea API URL paths, so a value containing "/" or other
    // path-altering characters must never reach it -- it must be rejected
    // here, at the input boundary, not merely encoded downstream.
    it('rejects an owner containing a path separator', () => {
      const integrations = integrationsWithGitea();
      expect(() =>
        parseGiteaRepoUrl(
          'gitea-http.gitea.svc.cluster.local:3000?owner=DigiOrg%2Fadmin&repo=app-config',
          integrations,
        ),
      ).toThrow(InputError);
    });

    it('rejects a repo containing a path separator', () => {
      const integrations = integrationsWithGitea();
      expect(() =>
        parseGiteaRepoUrl(
          'gitea-http.gitea.svc.cluster.local:3000?owner=DigiOrg&repo=app-config%2F..%2Fother',
          integrations,
        ),
      ).toThrow(InputError);
    });

    it('rejects an owner containing ".."', () => {
      const integrations = integrationsWithGitea();
      expect(() =>
        parseGiteaRepoUrl(
          'gitea-http.gitea.svc.cluster.local:3000?owner=..&repo=app-config',
          integrations,
        ),
      ).toThrow(InputError);
    });

    it('rejects a repo containing a query-altering "?" character', () => {
      const integrations = integrationsWithGitea();
      expect(() =>
        parseGiteaRepoUrl(
          'gitea-http.gitea.svc.cluster.local:3000?owner=DigiOrg&repo=app-config%3Ffoo%3Dbar',
          integrations,
        ),
      ).toThrow(InputError);
    });

    it('accepts owner/repo names using Gitea\'s valid charset (alnum, dash, underscore, dot)', () => {
      const integrations = integrationsWithGitea();
      const result = parseGiteaRepoUrl(
        'gitea-http.gitea.svc.cluster.local:3000?owner=Digi-Org_1&repo=app.config-2',
        integrations,
      );
      expect(result).toEqual({
        host: 'gitea-http.gitea.svc.cluster.local:3000',
        owner: 'Digi-Org_1',
        repo: 'app.config-2',
      });
    });
  });
});

describe('sanitizeRepoTargetPath', () => {
  it('returns an empty string for an undefined path', () => {
    expect(sanitizeRepoTargetPath(undefined)).toBe('');
  });

  it('normalizes a plain relative path', () => {
    expect(sanitizeRepoTargetPath('claims')).toBe('claims');
  });

  it('normalizes a nested relative path, dropping redundant "." segments', () => {
    expect(sanitizeRepoTargetPath('./claims/apps/')).toBe('claims/apps');
  });

  it('rejects an absolute path', () => {
    expect(() => sanitizeRepoTargetPath('/etc/passwd')).toThrow(InputError);
  });

  it('rejects a ".." traversal segment', () => {
    expect(() => sanitizeRepoTargetPath('claims/../../etc/passwd')).toThrow(InputError);
  });

  it('rejects a ".." traversal segment even when mixed with valid segments', () => {
    expect(() => sanitizeRepoTargetPath('claims/../secrets')).toThrow(
      /path traversal/,
    );
  });
});
