import {
  ApiRef,
  appThemeApiRef,
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
import { OAuth2, AppThemeSelector } from '@backstage/core-app-api';
import { UnifiedThemeProvider } from '@backstage/theme';
import { digiorgDarkTheme, digiorgLightTheme } from './themes/digiorgTheme';
import { PropsWithChildren } from 'react';

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

/** Theme provider wrappers */
const DigiOrgDarkThemeProvider = ({ children }: PropsWithChildren<{}>) => (
  <UnifiedThemeProvider theme={digiorgDarkTheme}>{children}</UnifiedThemeProvider>
);

const DigiOrgLightThemeProvider = ({ children }: PropsWithChildren<{}>) => (
  <UnifiedThemeProvider theme={digiorgLightTheme}>{children}</UnifiedThemeProvider>
);

/**
 * DigiOrg Theme API — registers Dark and Light themes
 */
const digiorgThemeApi = ApiBlueprint.make({
  name: 'app-theme',
  params: defineParams =>
    defineParams({
      api: appThemeApiRef,
      deps: {},
      factory: () =>
        AppThemeSelector.createWithStorage([
          {
            id: 'digiorg-dark',
            title: 'DigiOrg Dark',
            variant: 'dark',
            Provider: DigiOrgDarkThemeProvider,
          },
          {
            id: 'digiorg-light',
            title: 'DigiOrg Light',
            variant: 'light',
            Provider: DigiOrgLightThemeProvider,
          },
        ]),
    }),
});

/**
 * Frontend module that provides Keycloak OIDC auth + DigiOrg themes
 */
export const keycloakAuthApiModule = createFrontendModule({
  pluginId: 'app',
  extensions: [keycloakOIDCAuthApi, digiorgThemeApi],
});
