import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import crossplaneResourcesPlugin from '@terasky/backstage-plugin-crossplane-resources-frontend/alpha';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';
import { keycloakAuthApiModule } from './apis';

export default createApp({
  features: [catalogPlugin, crossplaneResourcesPlugin, navModule, authModule, keycloakAuthApiModule],
});
