import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  LoggerService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';
import { ConfigReader } from '@backstage/config';
import type { EntityProviderConnection } from '@backstage/plugin-catalog-node';
import { XRDTemplateEntityProvider } from '@terasky/backstage-plugin-kubernetes-ingestor';
import { parse } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const XRD_FIXTURE_PATH = path.join(__dirname, '__fixtures__/appclaim-xrd.yaml');

type ResourceFetchOptions = {
  resourcePath: string;
};

type MutationEntity = {
  entity: TemplateEntity;
};

type TemplateEntity = {
  kind: string;
  metadata: {
    title?: string;
  };
  spec?: {
    parameters?: Array<{
      title: string;
      properties: Record<string, unknown>;
    }>;
    type?: string;
  };
};

async function generateAppClaimTemplates() {
  const xrd = parse(fs.readFileSync(XRD_FIXTURE_PATH, 'utf8'));
  const v2Xrd = {
    ...xrd,
    apiVersion: 'apiextensions.crossplane.io/v2',
    spec: {
      ...xrd.spec,
      scope: 'LegacyCluster',
    },
  };
  const config = new ConfigReader(
    parse(fs.readFileSync(path.join(REPO_ROOT, 'app-config.yaml'), 'utf8')),
  );
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  } as unknown as LoggerService;
  const taskRunner = {
    run: jest.fn(async ({ fn }: { fn: () => Promise<void> }) => fn()),
  } as unknown as SchedulerServiceTaskRunner;
  const resourceFetcher = {
    getClusters: jest.fn(async () => ['digiorg-core-dev']),
    fetchResources: jest.fn(async ({ resourcePath }: ResourceFetchOptions) => {
      if (
        resourcePath ===
        'apiextensions.crossplane.io/v1/compositeresourcedefinitions'
      ) {
        return [xrd];
      }
      if (
        resourcePath ===
        'apiextensions.crossplane.io/v2/compositeresourcedefinitions'
      ) {
        return [v2Xrd];
      }
      return [];
    }),
  } as unknown as ConstructorParameters<typeof XRDTemplateEntityProvider>[3];
  const mutations: unknown[] = [];
  const applyMutation = jest.fn(async (mutation: unknown) => {
    mutations.push(mutation);
  });
  const connection = {
    applyMutation,
  } as unknown as EntityProviderConnection;
  const provider = new XRDTemplateEntityProvider(
    taskRunner,
    logger,
    config,
    resourceFetcher,
  );

  await provider.connect(connection);

  const mutation = mutations[0] as {
    type: string;
    entities: MutationEntity[];
  };
  const templates = mutation.entities
    .map(entry => entry.entity)
    .filter(entity => entity.kind === 'Template');

  return {
    applyMutation,
    config,
    mutation,
    resourceFetcher,
    templates,
    v2Xrd,
    xrd,
  };
}

describe('AppClaim XRD reconciliation through kubernetes-ingestor 3.15.0', () => {
  it('emits exactly one Template for AppClaim when controllers status is complete', async () => {
    const ingestorPackage = JSON.parse(
      fs.readFileSync(
        require.resolve(
          '@terasky/backstage-plugin-kubernetes-ingestor/package.json',
        ),
        'utf8',
      ),
    ) as { version: string };
    const { applyMutation, mutation, resourceFetcher, templates, v2Xrd, xrd } =
      await generateAppClaimTemplates();
    expect({
      apiVersion: xrd.apiVersion,
      kind: xrd.kind,
      metadataName: xrd.metadata.name,
      group: xrd.spec.group,
      names: xrd.spec.names,
      claimNames: xrd.spec.claimNames,
      version: xrd.spec.versions[0].name,
      controllers: xrd.status.controllers,
    }).toEqual({
      apiVersion: 'apiextensions.crossplane.io/v1',
      kind: 'CompositeResourceDefinition',
      metadataName: 'applications.platform.digiorg.io',
      group: 'platform.digiorg.io',
      names: {
        kind: 'Application',
        plural: 'applications',
      },
      claimNames: {
        kind: 'AppClaim',
        plural: 'appclaims',
      },
      version: 'v1alpha1',
      controllers: {
        compositeResourceType: {
          apiVersion: 'platform.digiorg.io/v1alpha1',
          kind: 'Application',
        },
        compositeResourceClaimType: {
          apiVersion: 'platform.digiorg.io/v1alpha1',
          kind: 'AppClaim',
        },
      },
    });
    expect(v2Xrd).toMatchObject({
      apiVersion: 'apiextensions.crossplane.io/v2',
      metadata: {
        name: xrd.metadata.name,
      },
      spec: {
        scope: 'LegacyCluster',
        group: 'platform.digiorg.io',
        names: {
          kind: 'Application',
          plural: 'applications',
        },
        claimNames: {
          kind: 'AppClaim',
          plural: 'appclaims',
        },
      },
    });
    expect(ingestorPackage.version).toBe('3.15.0');
    expect(resourceFetcher.fetchResources).toHaveBeenCalledWith({
      clusterName: 'digiorg-core-dev',
      resourcePath:
        'apiextensions.crossplane.io/v1/compositeresourcedefinitions',
    });
    expect(resourceFetcher.fetchResources).toHaveBeenCalledWith({
      clusterName: 'digiorg-core-dev',
      resourcePath:
        'apiextensions.crossplane.io/v2/compositeresourcedefinitions',
    });
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(mutation.type).toBe('full');

    expect(templates).toHaveLength(1);
    expect(templates[0].metadata.title).toBe('AppClaim');
    expect(templates[0].spec?.type).toBe('applications.platform.digiorg.io');

    const metadataParameters = templates[0].spec?.parameters?.find(
      parameter => parameter.title === 'Resource Metadata',
    );
    const specParameters = templates[0].spec?.parameters?.find(
      parameter => parameter.title === 'Resource Spec',
    );

    expect(metadataParameters?.properties.xrNamespace).toMatchObject({
      default: 'app-claims',
      enum: ['app-claims'],
      type: 'string',
      'ui:widget': 'hidden',
    });
    expect(specParameters?.properties.appName).toEqual({
      description: 'The workload identity and namespace created by Crossplane',
      type: 'string',
    });
  });

  it('writes an explicit claim namespace while preserving appName in spec', async () => {
    const { config, templates } = await generateAppClaimTemplates();
    const metadataParameters = templates[0].spec?.parameters?.find(
      parameter => parameter.title === 'Resource Metadata',
    );
    const xrNamespaceSchema = metadataParameters?.properties.xrNamespace as {
      default?: string;
    };
    const xrNamespace = xrNamespaceSchema.default;
    expect(xrNamespace).toBe('app-claims');

    const actionPackageDir = path.dirname(
      require.resolve(
        '@terasky/backstage-plugin-scaffolder-backend-module-terasky-utils/package.json',
      ),
    );
    const actionModule = require(path.join(
      actionPackageDir,
      'dist/actions/claim-templating.cjs.js',
    )) as {
      createCrossplaneClaimAction: (options: { config: ConfigReader }) => {
        handler: (context: {
          input: Record<string, unknown>;
          logger: { info: jest.Mock };
          output: jest.Mock;
          workspacePath: string;
        }) => Promise<void>;
      };
    };
    const action = actionModule.createCrossplaneClaimAction({ config });
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'appclaim-action-'),
    );
    const outputs = new Map<string, unknown>();

    try {
      await action.handler({
        input: {
          apiVersion: 'platform.digiorg.io/v1alpha1',
          clusters: ['temp'],
          excludeParams: [
            'owner',
            'pushToGit',
            'basePath',
            'manifestLayout',
            'targetBranch',
            'repoUrl',
            'clusters',
            'xrName',
            'xrNamespace',
          ],
          kind: 'AppClaim',
          nameParam: 'xrName',
          namespaceParam: 'xrNamespace',
          ownerParam: 'owner',
          parameters: {
            appName: 'myapp',
            basePath: '',
            manifestLayout: 'custom',
            owner: 'group:default/platform-team',
            pushToGit: false,
            xrName: 'myapp',
            xrNamespace,
          },
          removeEmptyParams: true,
        },
        logger: { info: jest.fn() },
        output: jest.fn((name: string, value: unknown) => {
          outputs.set(name, value);
        }),
        workspacePath,
      });

      const [manifestPath] = outputs.get('filePaths') as string[];
      const manifest = parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.metadata.namespace).toBe('app-claims');
      expect(manifest.spec.appName).toBe('myapp');
      expect(manifest.spec).not.toHaveProperty('xrNamespace');
    } finally {
      fs.rmSync(workspacePath, { force: true, recursive: true });
    }
  });
});
