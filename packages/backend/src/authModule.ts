import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
} from '@backstage/plugin-auth-node';
import { oidcAuthenticator } from '@backstage/plugin-auth-backend-module-oidc-provider';
import {
  stringifyEntityRef,
  DEFAULT_NAMESPACE,
} from '@backstage/catalog-model';

/**
 * Custom OIDC auth module that creates user identity from OIDC claims
 * without requiring pre-existing User entities in the catalog.
 */
export const customOidcAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'custom-oidc-provider',
  register(reg) {
    reg.registerInit({
      deps: { providers: authProvidersExtensionPoint },
      async init({ providers }) {
        providers.registerProvider({
          providerId: 'oidc',
          factory: createOAuthProviderFactory({
            authenticator: oidcAuthenticator,
            async signInResolver(info, ctx) {
              // Get user info from OIDC claims
              const { result } = info;
              const { userinfo } = result.fullProfile;

              // Try to get username from various OIDC claims
              const username =
                userinfo.preferred_username ||
                userinfo.email?.split('@')[0] ||
                userinfo.sub;

              const userRef = stringifyEntityRef({
                kind: 'User',
                name: username,
                namespace: DEFAULT_NAMESPACE,
              });

              return ctx.issueToken({
                claims: {
                  sub: userRef,
                  ent: [userRef],
                },
              });
            },
          }),
        });
      },
    });
  },
});
