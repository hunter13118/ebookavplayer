# Secrets on a new machine

**Do not use Clerk for API keys** — Clerk handles sign-in and roles only.

1. Clone `war-council` and copy `war-council/.env` from your password manager,
   or pull from Cloudflare after `wrangler login` (see `war-council/docs/SECRETS_HUB.md`).
2. From war-council: `node scripts/sync-workspace-secrets.mjs`
3. Or from this repo: `node scripts/sync-secrets-from-war-council.mjs`

Copies keys into `.env` (backend) and `web/.env.local` (Clerk publishable key only).
