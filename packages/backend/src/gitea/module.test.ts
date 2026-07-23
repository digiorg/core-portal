import { ConfigReader } from '@backstage/config';
import type { ScaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { giteaModule, registerGiteaActions } from './module';

describe('registerGiteaActions', () => {
  it('registers the publish:gitea:pull-request action built from root config integrations', () => {
    const addActions = jest.fn();
    const scaffolder: ScaffolderActionsExtensionPoint = { addActions };
    const config = new ConfigReader({
      integrations: {
        gitea: [{ host: 'gitea-http.gitea.svc.cluster.local:3000', password: 'token' }],
      },
    });

    registerGiteaActions(scaffolder, config);

    expect(addActions).toHaveBeenCalledTimes(1);
    const [registeredAction] = addActions.mock.calls[0];
    expect(registeredAction.id).toBe('publish:gitea:pull-request');
  });
});

describe('giteaModule', () => {
  it('is defined as a backend feature', () => {
    expect(giteaModule).toBeDefined();
  });
});
