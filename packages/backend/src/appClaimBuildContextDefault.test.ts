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
import { getDefaultFormState, type RJSFSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import { parse } from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const XRD_FIXTURE_PATH = path.join(__dirname, '__fixtures__/appclaim-xrd.yaml');
const CLAIM_ACTION_PACKAGE =
  '@terasky/backstage-plugin-scaffolder-backend-module-terasky-utils';

type ResourceFetchOptions = {
  resourcePath: string;
};

type TemplateEntity = {
  kind: string;
  spec: {
    parameters: RJSFSchema[];
    steps: Array<{
      id: string;
      action: string;
      input: {
        excludeParams: string[];
      };
    }>;
  };
};

type ClaimAction = {
  handler(ctx: {
    input: Record<string, unknown>;
    logger: { info(message: string): void };
    output(name: string, value: unknown): void;
    workspacePath: string;
  }): Promise<void>;
};

async function generatedAppClaimTemplate(
  mutateXrd?: (xrd: Record<string, any>) => void,
): Promise<TemplateEntity> {
  const xrd = parse(fs.readFileSync(XRD_FIXTURE_PATH, 'utf8')) as Record<
    string,
    any
  >;
  mutateXrd?.(xrd);
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
  const entities: TemplateEntity[] = [];
  const connection = {
    applyMutation: jest.fn(
      async (mutation: { entities: Array<{ entity: TemplateEntity }> }) => {
        entities.push(...mutation.entities.map(entry => entry.entity));
      },
    ),
  } as unknown as EntityProviderConnection;
  const provider = new XRDTemplateEntityProvider(
    taskRunner,
    logger,
    config,
    resourceFetcher,
  );

  await provider.connect(connection);

  const templates = entities.filter(entity => entity.kind === 'Template');
  expect(templates).toHaveLength(1);
  return templates[0];
}

async function renderClaimManifest(
  template: TemplateEntity,
  formData: Record<string, unknown>,
): Promise<Record<string, any>> {
  const packageRoot = path.dirname(
    require.resolve(`${CLAIM_ACTION_PACKAGE}/package.json`),
  );
  const actionModule = require(path.join(
    packageRoot,
    'dist/actions/claim-templating.cjs.js',
  )) as {
    createCrossplaneClaimAction(options: { config: ConfigReader }): ClaimAction;
  };
  const config = new ConfigReader(
    parse(fs.readFileSync(path.join(REPO_ROOT, 'app-config.yaml'), 'utf8')),
  );
  const action = actionModule.createCrossplaneClaimAction({ config });
  const outputs: Record<string, unknown> = {};
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'appclaim-context-contract-'),
  );
  const generateStep = template.spec.steps.find(
    step => step.id === 'generateManifest',
  );
  expect(generateStep?.action).toBe('terasky:claim-template');

  try {
    await action.handler({
      input: {
        parameters: {
          xrName: 'myapp',
          xrNamespace: 'app-claims',
          owner: 'group:default/platform-team',
          pushToGit: false,
          manifestLayout: 'cluster-scoped',
          ...formData,
        },
        nameParam: 'xrName',
        namespaceParam: 'xrNamespace',
        ownerParam: 'owner',
        excludeParams: generateStep?.input.excludeParams ?? [],
        apiVersion: 'platform.digiorg.io/v1alpha1',
        kind: 'AppClaim',
        clusters: ['digiorg-core-dev'],
        removeEmptyParams: true,
      },
      logger: { info: jest.fn() },
      output: (name, value) => {
        outputs[name] = value;
      },
      workspacePath,
    });
    return parse(outputs.manifest as string) as Record<string, any>;
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

describe('AppClaim build context API-default contract', () => {
  it('materializes the disabled-build default in the final manifest', async () => {
    const template = await generatedAppClaimTemplate();
    const resourceSpec = template.spec.parameters.find(
      parameter => parameter.title === 'Resource Spec',
    );
    expect(resourceSpec).toBeDefined();

    const formData = getDefaultFormState(validator, resourceSpec!, {
      services: [
        {
          name: 'myappapi',
          image: 'myappapi',
          port: 9950,
          build: { enabled: false },
        },
      ],
    }) as Record<string, unknown>;
    const manifest = await renderClaimManifest(template, formData);

    expect(manifest.spec.services[0].build).toEqual({
      enabled: false,
      context: '.',
    });
  });

  it('preserves a user-selected safe build context', async () => {
    const template = await generatedAppClaimTemplate();
    const resourceSpec = template.spec.parameters.find(
      parameter => parameter.title === 'Resource Spec',
    );
    expect(resourceSpec).toBeDefined();

    const formData = getDefaultFormState(validator, resourceSpec!, {
      services: [
        {
          name: 'myappapi',
          image: 'myappapi',
          port: 9950,
          build: { enabled: true, context: 'services/api' },
        },
      ],
    }) as Record<string, unknown>;
    const manifest = await renderClaimManifest(template, formData);

    expect(manifest.spec.services[0].build).toEqual({
      enabled: true,
      context: 'services/api',
    });
  });

  it('keeps provider-generated advanced controls out of API-default lookup', async () => {
    const template = await generatedAppClaimTemplate(xrd => {
      const buildProperties =
        xrd.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties
          .services.items.properties.build.properties;
      buildProperties.cache = {
        type: 'string',
        default: 'local',
        'x-ui-advanced': true,
      };
    });
    const resourceSpec = template.spec.parameters.find(
      parameter => parameter.title === 'Resource Spec',
    );
    const services = resourceSpec?.properties?.services as RJSFSchema;
    const serviceItem = services.items as RJSFSchema;
    const build = serviceItem.properties?.build as RJSFSchema;
    const enabledDependency = build.dependencies?.enabled as RJSFSchema;
    const enabledThen = enabledDependency.then as RJSFSchema;
    const enabledElse = enabledDependency.else as RJSFSchema;

    expect(enabledThen.properties?.showAdvancedSettings).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(enabledElse.properties?.context).toMatchObject({
      default: '.',
      'ui:widget': 'hidden',
    });
  });
});
