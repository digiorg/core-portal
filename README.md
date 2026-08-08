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
| `GITEA_TOKEN` | Dedicated least-privilege Gitea identity token used by the `publish:gitea:pull-request` scaffolder action to open AppClaim GitOps pull requests (see `integrations.gitea` in `app-config.yaml`). Never the Gitea platform admin/bootstrap token. | (secret) |

## AppClaim GitOps Delivery (issue #285)

The dynamically generated AppClaim scaffolder templates publish the generated
manifest as a pull request to a dedicated Gitea GitOps repository, using the
`publish:gitea:pull-request` action registered in
`packages/backend/src/gitea/module.ts`:

- **Integration**: `integrations.gitea` in `app-config.yaml`, host
  `digiorg.local` (trusted ingress, HTTPS), credential from `GITEA_TOKEN`.
- **Destination**: `kubernetesIngestor.crossplane.xrds.publishPhase` targets
  the `DigiOrg/app-config` repository, `main` branch, under the `claims/`
  path (`publishPhase.git.targetPath`, added via the TeraSky patch below).
- **Fixed target**: `allowRepoSelection: false`, so every AppClaim is
  delivered to the same repo/branch/path; the wizard never falls back to
  GitHub.
- **Namespace contract**: generated AppClaim manifests always set
  `metadata.namespace: app-claims`, sourced from the fixed and hidden
  `kubernetesIngestor.crossplane.xrds.claimNamespace` field. The separate
  user-controlled `appName` (for example, `myapp`) remains in `spec`; the
  Crossplane Composition creates that workload namespace later. The portal
  does not pre-create the workload namespace.
- The action reads the Gitea token exclusively from the configured
  `integrations.gitea` entry — it never accepts or logs a token supplied by
  a template step — and every Gitea API call it makes is a single bounded,
  timed-out request (see `packages/backend/src/gitea/giteaClient.ts`).
- Every changed file is committed in a single request via Gitea's batch
  "change files" API (`changeFiles`), so publishing N generated manifest
  files produces exactly one commit, not N.
- Re-running a submission is idempotent: an existing branch, an unchanged
  file, or an already-open pull request matching both the head **and** base
  branch are detected and reused rather than duplicated. Open-PR lookup
  paginates through every open pull request, not just the first page.

`@terasky/backstage-plugin-kubernetes-ingestor@3.15.0` has no built-in
`gitea` target and no way to place generated manifests under a fixed
subdirectory of a shared repo, so both are added via the Yarn patch at
`.yarn/patches/@terasky-backstage-plugin-kubernetes-ingestor-npm-3.15.0-f1d878075e.patch`
(regression-tested in
`packages/backend/src/gitea/kubernetesIngestorGiteaPatch.test.ts`).

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
