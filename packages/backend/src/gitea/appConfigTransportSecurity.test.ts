import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Issue #285 (TLS hardening): the real root app-config.yaml -- not a unit
 * test's synthetic config -- is the thing that actually gets deployed. The
 * Gitea integration and the AppClaim publish target must both point at the
 * trusted digiorg.local ingress (CA: cert-manager/digiorg-local-ca-secret)
 * over HTTPS, never the raw in-cluster gitea-http Service address over
 * plain HTTP: Backstage's own container (platform/base/backstage/deployment.yaml
 * in core) trusts that CA via NODE_EXTRA_CA_CERTS, so there is no longer any
 * reason to bypass TLS verification for this credential-bearing path.
 *
 * This is a static text check (no YAML parser dependency needed), matching
 * the style already used by kubernetesIngestorGiteaPatch.test.ts in this
 * same directory.
 */
const APP_CONFIG_PATH = path.join(__dirname, '../../../../app-config.yaml');

function readAppConfig(): string {
  return fs.readFileSync(APP_CONFIG_PATH, 'utf8');
}

describe('app-config.yaml Gitea transport security', () => {
  it('configures the gitea integration host as the trusted ingress hostname, not an in-cluster Service DNS name', () => {
    const config = readAppConfig();
    expect(config).toMatch(/host:\s*digiorg\.local\b/);
    expect(config).not.toContain('gitea-http.gitea.svc.cluster.local');
  });

  it('configures the gitea integration baseUrl as https, never plain http', () => {
    const config = readAppConfig();
    expect(config).toMatch(/baseUrl:\s*https:\/\/digiorg\.local\/gitea\b/);
  });

  it('does not use a plain-http baseUrl anywhere under integrations.gitea', () => {
    const config = readAppConfig();
    const giteaBlockMatch = config.match(/integrations:\n {2}gitea:\n([\s\S]*?)(?=\n\S|\n {2}\S)/);
    expect(giteaBlockMatch).not.toBeNull();
    const giteaBlock = giteaBlockMatch ? giteaBlockMatch[1] : '';
    expect(giteaBlock).not.toContain('http://');
  });

  it('publishes the AppClaim GitOps pull request against the same trusted ingress hostname', () => {
    const config = readAppConfig();
    expect(config).toMatch(/repoUrl:\s*digiorg\.local\?owner=DigiOrg&repo=app-config\b/);
  });
});
