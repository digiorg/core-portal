# DigiOrg Core Backstage Image

Custom Backstage Docker image for the DigiOrg Core Platform.

## Features

- **Keycloak SSO** - OIDC authentication via Keycloak
- **Kubernetes Plugin** - View and manage Kubernetes resources
- **GitHub Integration** - Software catalog from GitHub repositories
- **TechDocs** - Technical documentation as code
- **Scaffolder** - Software templates for new projects

## Image

```
ghcr.io/digiorg/core-backstage-image:latest
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `APP_BASE_URL` | Frontend URL | `http://digiorg.local/backstage` |
| `BACKEND_BASE_URL` | Backend URL | `http://digiorg.local/backstage` |
| `POSTGRES_HOST` | PostgreSQL host | `postgres` |
| `POSTGRES_PORT` | PostgreSQL port | `5432` |
| `POSTGRES_USER` | PostgreSQL user | `backstage` |
| `POSTGRES_PASSWORD` | PostgreSQL password | (secret) |
| `AUTH_OIDC_METADATA_URL` | Keycloak OIDC discovery URL | `http://digiorg.local/keycloak/realms/digiorg-core-platform/.well-known/openid-configuration` |
| `AUTH_OIDC_CLIENT_ID` | Keycloak client ID | `backstage` |
| `AUTH_OIDC_CLIENT_SECRET` | Keycloak client secret | (secret) |
| `GITHUB_TOKEN` | GitHub PAT for integrations | (secret) |

## Local Development

```bash
# Install dependencies
yarn install

# Start development server
yarn dev
```

## Building the Image

```bash
# Install dependencies
yarn install --immutable

# Compile TypeScript
yarn tsc

# Build backend bundle
yarn build:backend

# Build Docker image
yarn build-image --tag ghcr.io/digiorg/core-backstage-image:local
```

## CI/CD

The GitHub Actions workflow automatically builds and pushes the image on:
- Push to `main` branch → `latest` tag
- Push of version tag (e.g., `v1.0.0`) → version tags
- Pull requests → build only (no push)

## Deployed Plugins

### Backend
- `@backstage/plugin-auth-backend-module-oidc-provider` - OIDC authentication
- `@backstage/plugin-kubernetes-backend` - Kubernetes integration
- `@backstage/plugin-catalog-backend-module-github` - GitHub catalog provider
- `@backstage/plugin-techdocs-backend` - TechDocs
- `@backstage/plugin-scaffolder-backend` - Software templates

### Frontend
- `@backstage/plugin-kubernetes` - Kubernetes UI
- `@backstage/plugin-github-actions` - GitHub Actions integration
- `@backstage/plugin-techdocs` - TechDocs UI
- `@backstage/plugin-scaffolder` - Template wizard

## Related Repositories

- [digiorg-core-platform](https://github.com/digiorg/core) - Platform deployment manifests
