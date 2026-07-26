import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { ScmIntegrations } from '@backstage/integration';
import {
  scaffolderActionsExtensionPoint,
  type ScaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import type { Config } from '@backstage/config';
import { createPublishGiteaPullRequestAction } from './publishGiteaPullRequestAction';

/**
 * Wires the `publish:gitea:pull-request` action into the scaffolder using
 * the ScmIntegrations built from root config, so the action's Gitea
 * credential always comes from `integrations.gitea`.
 */
export function registerGiteaActions(
  scaffolder: ScaffolderActionsExtensionPoint,
  config: Config,
): void {
  const integrations = ScmIntegrations.fromConfig(config);
  scaffolder.addActions(createPublishGiteaPullRequestAction({ integrations }));
}

export const giteaModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'gitea',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        registerGiteaActions(scaffolder, config);
      },
    });
  },
});
