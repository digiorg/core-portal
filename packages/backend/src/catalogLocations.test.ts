import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APP_CONFIG_PATH = path.join(REPO_ROOT, 'app-config.yaml');
const DOCKERFILE_PATH = path.join(REPO_ROOT, 'packages/backend/Dockerfile');

type CatalogLocation = {
  type?: string;
  target?: string;
};

type AppConfig = {
  catalog?: {
    locations?: CatalogLocation[];
  };
};

type ProductionLayout = {
  contextSource: string;
  imageDestination: string;
  workdir: string;
};

function readFileTargets(configText: string): string[] {
  const config = parse(configText) as AppConfig;
  return (config.catalog?.locations ?? [])
    .filter(location => location.type === 'file')
    .map(location => location.target)
    .filter((target): target is string => target !== undefined);
}

function readProductionLayout(dockerfile: string): ProductionLayout {
  const workdir = dockerfile.match(/^WORKDIR\s+(\S+)\s*$/m)?.[1];
  const examplesCopy = dockerfile.match(
    /^COPY(?:\s+--\S+)*\s+(\.?\/?examples)\s+(\.?\/?examples)\s*$/m,
  );

  if (!workdir || !examplesCopy) {
    throw new Error(
      'Dockerfile must declare WORKDIR and copy the examples directory',
    );
  }

  return {
    contextSource: examplesCopy[1],
    imageDestination: examplesCopy[2],
    workdir,
  };
}

function productionSourceForTarget(
  target: string,
  layout: ProductionLayout,
): string {
  const copiedImageRoot = path.posix.resolve(
    layout.workdir,
    layout.imageDestination,
  );
  const resolvedTarget = path.posix.resolve(layout.workdir, target);
  const relativeToCopy = path.posix.relative(copiedImageRoot, resolvedTarget);

  if (
    relativeToCopy.startsWith('..') ||
    path.posix.isAbsolute(relativeToCopy)
  ) {
    throw new Error(
      `Catalog target "${target}" resolves to "${resolvedTarget}", outside copied image directory "${copiedImageRoot}"`,
    );
  }

  return path.resolve(REPO_ROOT, layout.contextSource, relativeToCopy);
}

describe('catalog file locations in development and the production image', () => {
  const appConfig = fs.readFileSync(APP_CONFIG_PATH, 'utf8');
  const fileTargets = readFileTargets(appConfig);
  const productionLayout = readProductionLayout(
    fs.readFileSync(DOCKERFILE_PATH, 'utf8'),
  );

  it('resolves every file target from the repository root during development', () => {
    expect(fileTargets).not.toHaveLength(0);

    for (const target of fileTargets) {
      expect(fs.statSync(path.resolve(REPO_ROOT, target)).isFile()).toBe(true);
    }
  });

  it('maps every target resolved from /app to a file copied by the production Dockerfile', () => {
    expect(productionLayout.workdir).toBe('/app');
    expect(fileTargets).not.toHaveLength(0);

    for (const target of fileTargets) {
      expect(
        fs
          .statSync(productionSourceForTarget(target, productionLayout))
          .isFile(),
      ).toBe(true);
    }
  });

  it('rejects a regression to ../../examples targets', () => {
    const mutatedTargets = fileTargets.map(target =>
      target.replace(/^\.\/examples\//, '../../examples/'),
    );

    expect(mutatedTargets).toHaveLength(fileTargets.length);
    for (const target of mutatedTargets) {
      expect(() => productionSourceForTarget(target, productionLayout)).toThrow(
        /outside copied image directory/,
      );
    }
  });
});
