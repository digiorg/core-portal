import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { createThemeExtension } from '@backstage/frontend-plugin-api';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';
import { keycloakAuthApiModule } from './apis';
import { digiorgDarkTheme, digiorgLightTheme } from './themes/digiorgTheme';

export default createApp({
  features: [
    catalogPlugin,
    navModule,
    authModule,
    keycloakAuthApiModule,
    // DigiOrg Dark Theme (default)
    createThemeExtension({
      id: 'digiorg-dark',
      title: 'DigiOrg Dark',
      variant: 'dark',
      theme: digiorgDarkTheme,
    }),
    // DigiOrg Light Theme
    createThemeExtension({
      id: 'digiorg-light',
      title: 'DigiOrg Light',
      variant: 'light',
      theme: digiorgLightTheme,
    }),
  ],
});
