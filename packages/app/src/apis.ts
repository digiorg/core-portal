import {
  ApiRef,
  configApiRef,
  createApiRef,
  discoveryApiRef,
  oauthRequestApiRef,
  OpenIdConnectApi,
  ProfileInfoApi,
  BackstageIdentityApi,
  SessionApi,
} from '@backstage/core-plugin-api';
import {
  ApiBlueprint,
  createFrontendModule,
} from '@backstage/frontend-plugin-api';
import { OAuth2 } from '@backstage/core-app-api';

/**
 * API reference for Keycloak OIDC authentication
 */
export const keycloakOIDCAuthApiRef: ApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
> = createApiRef({
  id: 'auth.keycloak-oidc',
});

/**
 * API Extension for Keycloak OIDC auth
 */
const keycloakOIDCAuthApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: keycloakOIDCAuthApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        oauthRequestApi: oauthRequestApiRef,
        configApi: configApiRef,
      },
      factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
        OAuth2.create({
          configApi,
          discoveryApi,
          oauthRequestApi,
          provider: {
            // This MUST be 'oidc' - it maps to the backend auth provider
            id: 'oidc',
            title: 'Keycloak',
            icon: () => null,
          },
          environment: configApi.getOptionalString('auth.environment'),
          defaultScopes: ['openid', 'profile', 'email'],
          popupOptions: {
            size: {
              fullscreen: true,
            },
          },
        }),
    }),
});

/**
 * Frontend module that provides the Keycloak OIDC auth API
 */
export const keycloakAuthApiModule = createFrontendModule({
  pluginId: 'app',
  extensions: [keycloakOIDCAuthApi],
});
