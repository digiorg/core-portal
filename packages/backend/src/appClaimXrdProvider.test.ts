import * as fs from 'node:fs';
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
  entity: {
    kind: string;
    metadata: {
      title?: string;
    };
    spec?: {
      type?: string;
    };
  };
};

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
    const xrd = parse(fs.readFileSync(XRD_FIXTURE_PATH, 'utf8'));
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
    const v2Xrd = {
      ...xrd,
      apiVersion: 'apiextensions.crossplane.io/v2',
      spec: {
        ...xrd.spec,
        scope: 'LegacyCluster',
      },
    };
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
      fetchResources: jest.fn(
        async ({ resourcePath }: ResourceFetchOptions) => {
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
        },
      ),
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
    const mutation = mutations[0] as {
      type: string;
      entities: MutationEntity[];
    };
    expect(mutation.type).toBe('full');
    const templates = mutation.entities
      .map(entry => entry.entity)
      .filter(entity => entity.kind === 'Template');

    expect(templates).toHaveLength(1);
    expect(templates[0].metadata.title).toBe('AppClaim');
    expect(templates[0].spec?.type).toBe('applications.platform.digiorg.io');
  });
});
