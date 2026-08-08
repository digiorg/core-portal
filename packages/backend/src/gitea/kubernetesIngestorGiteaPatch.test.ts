import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The AppClaim wizard's `create-pull-request` step is generated entirely by
 * the vendored TeraSky kubernetes-ingestor package (see
 * publishPhase.target in app-config.yaml). Backstage core has no built-in
 * `gitea` SCM type in that generator's target switch, and no way to place
 * generated manifests under a fixed subdirectory of a shared GitOps repo, so
 * both are added via a Yarn patch. This test locks the patch to exactly the
 * additions issue #285 needs and fails loudly if a `yarn` upgrade replaces
 * the patched package without carrying the patch forward.
 */
const PATCH_PATH = path.join(
  __dirname,
  '../../../../.yarn/patches/@terasky-backstage-plugin-kubernetes-ingestor-npm-3.15.0-f1d878075e.patch',
);

function readPatch(): string {
  return fs.readFileSync(PATCH_PATH, 'utf8');
}

function readInstalledProvider(): string {
  const packageDir = path.dirname(
    require.resolve(
      '@terasky/backstage-plugin-kubernetes-ingestor/package.json',
    ),
  );
  return fs.readFileSync(
    path.join(packageDir, 'dist/providers/EntityProvider.cjs.js'),
    'utf8',
  );
}

describe('TeraSky kubernetes-ingestor gitea patch', () => {
  it('exists on disk', () => {
    expect(fs.existsSync(PATCH_PATH)).toBe(true);
  });

  it('touches only config.d.ts and the EntityProvider dist file', () => {
    const patch = readPatch();
    const touchedFiles = [
      ...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm),
    ].map(m => m[1]);
    expect(touchedFiles.sort()).toEqual(
      ['config.d.ts', 'dist/providers/EntityProvider.cjs.js'].sort(),
    );
  });

  it('routes the crossplane XRD (AppClaim) publish target to publish:gitea:pull-request', () => {
    const patch = readPatch();
    expect(patch).toMatch(
      /\+ {6}case "gitea":\n\+ {8}action = "publish:gitea:pull-request";\n\+ {8}break;/,
    );
  });

  it('adds exactly two gitea-routing case blocks (crossplane XRDs and generic CRD templates)', () => {
    const patch = readPatch();
    const matches = patch.match(/\+ {6}case "gitea":/g) ?? [];
    expect(matches).toHaveLength(2);
  });

  it('emits an optional targetPath line in the hardcoded create-pull-request step, driven by publishPhase.git.targetPath', () => {
    const patch = readPatch();
    expect(patch).toContain(
      'kubernetesIngestor.crossplane.xrds.publishPhase.git.targetPath',
    );
    expect(patch).toContain('targetPath: ${this.config.getOptionalString(');
  });

  it('declares targetPath as an optional config schema key so it is not rejected as unknown config', () => {
    const patch = readPatch();
    expect(patch).toContain('targetPath?: string;');
  });

  it('declares claimNamespace as an optional XRD config schema key', () => {
    const patch = readPatch();
    expect(patch).toContain('claimNamespace?: string;');
  });

  it('fixes and hides xrNamespace only when claimNamespace is configured', () => {
    const patch = readPatch();
    const provider = readInstalledProvider();
    expect(patch).toContain(
      'this.config.getOptionalString("kubernetesIngestor.crossplane.xrds.claimNamespace")',
    );
    expect(patch).toMatch(
      /\+ {6}if \(claimNamespace\) \{\n\+ {8}Object\.assign\(mainParameterGroup\.properties\.xrNamespace, \{\n\+ {10}default: claimNamespace,\n\+ {10}enum: \[claimNamespace\],\n\+ {10}"ui:widget": "hidden"/,
    );
    expect(provider).toContain(
      'if (isV2 && isNamespaced || !isV2 || isLegacyCluster) {',
    );
  });

  it('does not add a token/credential input to the generated step or schema', () => {
    const patch = readPatch();
    expect(patch).not.toMatch(/\+.*\btoken\b/i);
  });
});
