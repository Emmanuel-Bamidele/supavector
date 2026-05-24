# SupaVector Enterprise Guide

This guide is for teams that want an enterprise access model on top of SupaVector, whether they use SupaVector-hosted infrastructure or run SupaVector themselves.

Use this guide when you need:

- SSO for many human users
- tenant-scoped access control
- a clean split between human admin login and machine runtime tokens
- hosted billing clarity for enterprise customers
- a self-hosted rollout path that still supports enterprise identity

If you are already in the browser UI, the same operational guide now lives in the dedicated `Documentation -> Enterprise` tab.

If you are still deciding whether you are hosted or self-hosted, start with [`setup-modes.md`](setup-modes.md) first.

## Deployment Options

SupaVector supports three enterprise shapes:

| Mode | Who runs infrastructure | Who pays for AI generation | Who pays for storage | Best when |
| --- | --- | --- | --- | --- |
| Hosted enterprise | SupaVector | SupaVector-hosted prepaid credit by default | SupaVector monthly hosted storage billing | You want enterprise access controls without running SupaVector yourself |
| Hosted enterprise + your provider key | SupaVector | Your provider for matching BYO-key generation requests | SupaVector monthly hosted storage billing | You want shared hosted storage/runtime but your own AI provider billing |
| Self-hosted enterprise | You | You | You | You need SupaVector inside your own environment and billing perimeter |

Important boundary:

- If SupaVector runs on SupaVector-hosted infrastructure and stores your data in SupaVector-managed Postgres, storage remains hosted storage even when requests bring their own provider key.
- If you run SupaVector yourself, SupaVector does not bill you for storage or AI usage.

## Enterprise Access Model

The recommended model is the same in hosted and self-hosted deployments:

- human admins sign in with username/password or SSO
- enterprise users sign in with SSO
- apps, backends, workers, and agents use service tokens
- provider-key overrides are request-scoped and do not replace tenant identity

Current enterprise auth scope includes:

- tenant auth modes: `sso_only`, `sso_plus_password`, `password_only`
- tenant-scoped SSO configuration for Google, Azure, and Okta
- default role assignment for new SSO users
- claim/group-to-role mapping
- allowed email-domain enforcement per provider
- automatic SSO user creation on first successful login
- tenant user-management APIs and browser admin UI
- local break-glass users for password login when you want an emergency admin path

Open-source gateway without the private portal overlay does not include tenant SCIM or runtime-placement surfaces.

When you run the private portal overlay:

- tenant SCIM is available, but the current runtime path supports bearer-token auth only
- tenant SAML sign-in can be configured and validated in the portal, and live tenant sign-in availability follows the same readiness signals shown for tenant rollout
- hosted-dedicated and customer-cloud runtimes must register and heartbeat into the portal control plane before they can be used for tenant placement

## Roles And Tenant Operations

SupaVector currently uses four built-in roles:

- `instance_admin`
- `admin`
- `indexer`
- `reader`

Role boundary:

- `instance_admin` is the enterprise control-plane role. It can manage tenants, cross-tenant users, cross-tenant service tokens, and audit logs.
- `admin`, `indexer`, and `reader` remain tenant-scoped roles.
- Tenant-scoped SSO role mappings can assign only tenant roles. `instance_admin` is intentionally not assignable from IdP claims.

Recommended policy:

- reserve `instance_admin` for platform operators or a very small self-hosted enterprise control group
- map your IdP admin group to `admin,indexer,reader`
- map editor/operator groups to `indexer,reader`
- map general internal users to `reader`
- keep at least one local break-glass admin user per tenant for recovery

Tenant admins can now do the following from the browser settings UI:

- switch auth mode
- allow or deny Google, Azure, and Okta per tenant
- configure tenant-scoped OIDC settings instead of relying only on instance-wide env
- set default roles and claim-to-role mappings
- limit sign-in to approved email domains
- inspect tenant users after first SSO login
- promote, demote, disable, or password-reset users
- create local password users for emergency access

## Enterprise Control APIs

There are now two admin API layers:

- tenant admin APIs for customer or tenant-local admins
- enterprise control APIs for `instance_admin`

Tenant admin APIs:

- `GET/PATCH /v1/admin/tenant`
- `GET/POST/PATCH /v1/admin/users`
- `GET/POST/DELETE /v1/admin/service-tokens`
- `GET /v1/admin/vector/search-runtime`
- `POST /v1/admin/vector/reindex`

Enterprise control APIs:

- `GET /v1/admin/tenants`
- `POST /v1/admin/tenants`
- `GET /v1/admin/tenants/:tenantId`
- `PATCH /v1/admin/tenants/:tenantId`
- `GET /v1/admin/tenants/:tenantId/users`
- `POST /v1/admin/tenants/:tenantId/users`
- `PATCH /v1/admin/tenants/:tenantId/users/:id`
- `GET /v1/admin/tenants/:tenantId/service-tokens`
- `POST /v1/admin/tenants/:tenantId/service-tokens`
- `DELETE /v1/admin/tenants/:tenantId/service-tokens/:id`
- `GET /v1/admin/audit`
- `GET /v1/admin/tenants/:tenantId/audit`

What they cover:

- tenant lifecycle create and update
- external system identifiers and tenant metadata
- cross-tenant user and role management
- cross-tenant machine-token issuance
- audit-log access for enterprise operations
- vector search runtime inspection, ANN rollout state, and admin-triggered vector rebuilds

What is intentionally not exposed yet:

- tenant deletion
- SCIM
- invitation workflows
- org/account billing APIs in the open-source gateway

## Enterprise Bootstrap

For self-hosted enterprise control, bootstrap the first control-plane admin with `instance_admin`.

Example:

```bash
cd gateway
node scripts/bootstrap_instance.js \
  --tenant platform-admin \
  --username admin \
  --roles instance_admin,admin,indexer,reader \
  --service-token-roles instance_admin,admin,indexer,reader
```

That creates:

- a local break-glass user with enterprise control-plane access
- a service token that can automate tenant and role management

The normal tenant-scoped token routes cannot mint `instance_admin`. That role is only allowed through bootstrap or the enterprise control APIs.

## Enterprise API Examples

Inspect dense vector search runtime:

```bash
curl -sS "$SUPAVECTOR_BASE_URL/v1/admin/vector/search-runtime" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT"
```

Trigger a vector rebuild from stored chunks after an embedding-model change or vector-store restore:

```bash
curl -sS "$SUPAVECTOR_BASE_URL/v1/admin/vector/reindex" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"mode":"always"}'
```

The CLI equivalents are `supavector vector runtime` and `supavector vector reindex --mode always`.

List tenants:

```bash
curl -sS "$SUPAVECTOR_BASE_URL/v1/admin/tenants?limit=100&search=acme" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT"
```

Create a tenant and return a bootstrap admin plus service token:

```bash
curl -sS "$SUPAVECTOR_BASE_URL/v1/admin/tenants" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "acme-prod",
    "name": "Acme Production",
    "externalId": "crm-123",
    "metadata": { "region": "us", "tier": "enterprise" },
    "authMode": "sso_plus_password",
    "ssoProviders": ["okta"],
    "bootstrapAdmin": {
      "username": "acme-breakglass",
      "roles": ["admin", "indexer", "reader"]
    },
    "bootstrapServiceToken": {
      "name": "acme-prod-automation",
      "principalId": "acme-control-plane",
      "roles": ["admin", "indexer", "reader"]
    }
  }'
```

Update a tenant’s enterprise auth config:

```bash
curl -sS -X PATCH "$SUPAVECTOR_BASE_URL/v1/admin/tenants/acme-prod" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "authMode": "sso_only",
    "ssoProviders": ["okta"],
    "ssoConfig": {
      "okta": {
        "enabled": true,
        "issuer": "https://acme.okta.com/oauth2/default",
        "clientId": "client-id",
        "clientSecret": "client-secret",
        "allowedDomains": ["acme.com"],
        "defaultRoles": ["reader"],
        "roleMappings": {
          "SupaVector-Admins": ["admin", "indexer", "reader"]
        }
      }
    }
  }'
```

Create a cross-tenant machine token:

```bash
curl -sS "$SUPAVECTOR_BASE_URL/v1/admin/tenants/acme-prod/service-tokens" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "acme-prod-worker",
    "principalId": "acme-prod-worker",
    "roles": ["indexer", "reader"]
  }'
```

List audit logs for a tenant:

```bash
curl -sS "$SUPAVECTOR_BASE_URL/v1/admin/tenants/acme-prod/audit?limit=50" \
  -H "Authorization: Bearer $SUPAVECTOR_JWT"
```

## Enterprise CLI Equivalents

The same control-plane flows are available from the `supavector` CLI. Use the saved bootstrap service token, an admin service token, or pass `--token "$SUPAVECTOR_JWT"` when you want to act as a human admin.

List tenants:

```bash
supavector tenants list --limit 100 --search acme
```

Create a tenant with bootstrap credentials:

```bash
supavector tenants create \
  --tenant acme-prod \
  --name "Acme Production" \
  --external-id crm-123 \
  --metadata-json '{"region":"us","tier":"enterprise"}' \
  --bootstrap-admin acme-breakglass \
  --bootstrap-admin-roles admin,indexer,reader \
  --bootstrap-token-name acme-prod-automation \
  --bootstrap-token-principal-id svc:acme-control-plane \
  --bootstrap-token-roles admin,indexer,reader
```

Update enterprise SSO settings from a file:

```bash
supavector tenants update \
  --tenant acme-prod \
  --auth-mode sso_only \
  --sso-providers okta \
  --sso-config-file ./acme-okta.json
```

Create or rotate tenant runtime credentials:

```bash
supavector tenants tokens create \
  --tenant acme-prod \
  --name acme-prod-worker \
  --principal-id svc:acme-prod-worker \
  --roles indexer,reader

supavector tenants tokens revoke \
  --tenant acme-prod \
  --id 14 \
  --yes
```

Inspect tenant users or update one in place:

```bash
supavector tenants users list --tenant acme-prod

supavector tenants users update \
  --tenant acme-prod \
  --id 21 \
  --roles admin,indexer,reader \
  --disabled false
```

Pull audit logs through the CLI:

```bash
supavector audit list \
  --tenant acme-prod \
  --limit 50 \
  --action tenant.settings.update
```

For advanced automation, pass the full request body directly:

```bash
supavector tenants update \
  --tenant acme-prod \
  --body-file ./tenant-update.json
```

## Enterprise Developer Workflow

If you are building enterprise automation around SupaVector, this is the recommended control-plane flow:

1. Bootstrap or obtain one `instance_admin` credential.
2. Create a tenant with `tenantId`, optional `externalId`, and tenant metadata.
3. Create a break-glass tenant admin and a runtime service token during tenant creation, or immediately after.
4. Configure tenant auth mode, SSO providers, default roles, allowed domains, and claim-to-role mappings.
5. Run a real SSO login for a test user and confirm the resulting tenant roles.
6. Store runtime service tokens in your secret manager and let your app/backend use them server-to-server.
7. Pull audit logs during provisioning, support, or compliance workflows.
8. Move the tenant from `sso_plus_password` to `sso_only` only after SSO and break-glass recovery paths are proven.

This is the main operational split:

- enterprise control plane uses `instance_admin`
- tenant-local admin work uses tenant `admin`
- production apps and workers use service tokens

## Response Examples

Create-tenant responses use the normal JSON envelope:

```json
{
  "ok": true,
  "data": {
    "tenant": {
      "id": "acme-prod",
      "name": "Acme Production",
      "externalId": "crm-123",
      "metadata": {
        "region": "us",
        "tier": "enterprise"
      }
    },
    "bootstrapAdmin": {
      "user": {
        "username": "acme-breakglass",
        "roles": ["admin", "indexer", "reader"]
      },
      "generatedPassword": "shown-only-if-generated"
    },
    "bootstrapServiceToken": {
      "token": "supav_xxx",
      "tokenInfo": {
        "name": "acme-prod-automation",
        "principalId": "acme-control-plane",
        "roles": ["admin", "indexer", "reader"]
      }
    }
  },
  "meta": {
    "tenantId": "acme-prod",
    "collection": null,
    "timestamp": "2026-03-26T00:00:00.000Z"
  }
}
```

Notes:

- generated passwords are returned only if the password was omitted
- service token plaintext is returned only at creation time
- audit routes return the same `ok/data/meta` envelope with `data.logs`

## Hosted Enterprise Account Model

Hosted enterprise billing is account-level even when you run multiple projects or tenants:

- each project or tenant is separately isolated and separately metered
- AI credits are shared at the hosted account level
- hosted storage invoices and payment methods belong to the hosted account, not to each tenant independently

That is the normal enterprise pattern. If one customer needs separate legal billing entities or separate invoices, use separate hosted accounts rather than one account with many independently billed tenants.

## Hosted Enterprise Billing

Hosted enterprise billing now works like this:

- `/ask` and `/boolean_ask` use SupaVector prepaid credit by default
- if the request supplies the matching provider-key header for the effective generation provider, hosted AI credit is not deducted for that request
- hosted storage is billed separately as retained `GB-month`
- hosted storage billing applies to all hosted tenants, including BYO-key tenants
- a payment method is required for ongoing hosted storage writes after the grace window

That means:

- hosted enterprise with SupaVector AI: SupaVector bills AI and storage
- hosted enterprise with BYO provider key: your provider bills AI, SupaVector bills storage

## Self-Hosted Enterprise Billing

Self-hosted enterprise does not use SupaVector-hosted billing:

- you run the infrastructure
- you hold the provider keys
- you own the database
- you own your own infrastructure costs

If you run SupaVector yourself, the new hosted storage billing paths do not apply.

## Hosted Enterprise Quickstart

1. Create a hosted account and project.
2. Decide whether the tenant will use hosted AI credit or BYO provider-key overrides for generation.
3. Add a payment method for hosted storage billing.
4. Sign in to the hosted Dashboard as an admin.
5. Use the Dashboard as the source of truth for tenant auth mode, SSO config, users, tokens, billing, and enterprise controls.
6. Set the tenant auth mode.
7. Allow the SSO providers the tenant should use.
8. Add tenant-scoped Google, Azure, and/or Okta OIDC settings if this tenant should not rely only on shared defaults.
9. Set default roles, optional allowed email domains, and role mappings.
10. Use the hosted SSO login check to verify provider availability.
11. Have a test user complete SSO login once so the user is provisioned into the tenant.
12. Review that user and confirm roles.
13. Create or retain one local break-glass admin user if your hosted operating model allows it.
14. Mint service tokens for production apps and backends. Do not run production runtimes on human JWTs.

Recommended hosted rollout:

- start with `sso_plus_password`
- verify SSO and role mappings
- confirm break-glass access
- switch to `sso_only` when ready

## Self-Hosted Enterprise Quickstart

1. Choose your deployment path:
   - bundled stack: [`self-hosting.md`](self-hosting.md)
   - external Postgres: [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
2. Set `PUBLIC_BASE_URL` correctly so OIDC redirects match the externally reachable URL.
3. Set `COOKIE_SECRET`, `JWT_SECRET`, and `COOKIE_SECURE=1` when you are serving over HTTPS.
4. Configure provider keys and model defaults for SupaVector itself.
5. Configure either:
   - instance-wide OIDC env vars as the fallback/default enterprise IdP config
   - or tenant-scoped SSO config from the Settings UI after bootstrap
6. Bootstrap the first admin and first service token.
7. Sign in as admin and open the Tenant panel.
8. Configure auth mode, provider allowlist, tenant-scoped overrides, domain restrictions, and role mappings.
9. Test SSO with a real user.
10. Create a local break-glass admin user.
11. Issue service tokens for apps and internal backends.

Recommended self-hosted rollout:

- start with one tenant and one IdP
- validate redirect URIs and claims
- validate role mapping with a small pilot group
- keep password login available until SSO is proven
- move to `sso_only` when the rollout is stable

## Instance-Wide OIDC Env Fallback

Tenant-scoped SSO config can override the instance-wide env settings, but self-hosted enterprise teams will usually still want sane instance defaults.

Supported env vars per provider:

```env
OIDC_GOOGLE_CLIENT_ID=
OIDC_GOOGLE_CLIENT_SECRET=
OIDC_GOOGLE_ISSUER=
OIDC_GOOGLE_SCOPES=openid email profile
OIDC_GOOGLE_TENANT_CLAIM=hd
OIDC_GOOGLE_ROLE_CLAIM=groups
OIDC_GOOGLE_ALLOWED_DOMAINS=
OIDC_GOOGLE_DEFAULT_ROLES=

OIDC_AZURE_CLIENT_ID=
OIDC_AZURE_CLIENT_SECRET=
OIDC_AZURE_ISSUER=
OIDC_AZURE_SCOPES=openid email profile
OIDC_AZURE_TENANT_CLAIM=tid
OIDC_AZURE_ROLE_CLAIM=groups
OIDC_AZURE_ALLOWED_DOMAINS=
OIDC_AZURE_DEFAULT_ROLES=

OIDC_OKTA_CLIENT_ID=
OIDC_OKTA_CLIENT_SECRET=
OIDC_OKTA_ISSUER=
OIDC_OKTA_SCOPES=openid email profile
OIDC_OKTA_TENANT_CLAIM=iss
OIDC_OKTA_ROLE_CLAIM=groups
OIDC_OKTA_ALLOWED_DOMAINS=
OIDC_OKTA_DEFAULT_ROLES=
```

Notes:

- tenant-scoped config wins when it is enabled and fully configured
- blank client-secret fields in the UI keep the stored secret unchanged
- the settings UI also supports intentionally clearing a stored tenant-scoped client secret

## Runtime Recommendations

For enterprise product integrations:

- use service tokens for apps, agents, and backends
- keep human SSO for admins and interactive browser use
- if your product already has its own user auth, prefer backend-as-caller instead of exposing SupaVector login to every end user

Recommended runtime split:

- provisioning system or platform ops: `instance_admin`
- customer tenant admins: tenant `admin`
- product backend: service token
- human support or ops investigation: JWT in the browser UI, then service-token rotation if needed

Useful follow-up guides:

- [`agents.md`](agents.md)
- [`hosted.md`](hosted.md)
- [`self-hosting.md`](self-hosting.md)
- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)

## Operator Checklist

Before calling an enterprise rollout complete, verify:

- the tenant auth mode is correct
- redirect URIs match the public hostname
- at least one SSO provider is enabled and tested
- role mappings match real IdP claims
- allowed-domain rules are intentional
- at least one break-glass local admin exists
- if using hosted-dedicated or customer-cloud placement, the target runtime is registered and sending fresh heartbeats with `PORTAL_RUNTIME_CONTROL_PLANE_TOKEN_<RUNTIME>`
- if using hosted-dedicated or customer-cloud placement, the validated portal cutover flow was completed; registration and heartbeat alone do not switch tenant placement
- runtime service tokens are stored outside source control
- hosted tenants have billing and payment method setup completed if they will store data on SupaVector-hosted infrastructure

## Troubleshooting

Common enterprise rollout failures:

- `401` on enterprise API routes:
  Use a valid JWT or token from the same SupaVector deployment. Tokens are deployment-scoped.
- `403` on enterprise API routes:
  The caller is not `instance_admin`.
- SSO login says provider is unavailable:
  Check tenant auth mode, provider allowlist, and tenant-scoped or instance-scoped OIDC config.
- SSO login redirects incorrectly:
  Check `PUBLIC_BASE_URL` and the IdP redirect URI.
- Dedicated or customer-cloud runtime never becomes eligible for cutover:
  Check the runtime registration and heartbeat calls, the bearer token pattern `PORTAL_RUNTIME_CONTROL_PLANE_TOKEN_<RUNTIME>`, the runtime key and shard key values, and remember that placement changes only after validated portal cutover.
- Hosted writes fail with storage-billing errors:
  Add or update the payment method in the Billing Portal and pay outstanding hosted storage invoices.
- Bootstrap secrets were lost:
  Reset the user password or mint a new service token. Plain bootstrap secrets are shown only once by design.
