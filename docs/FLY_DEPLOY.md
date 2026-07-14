# Fly.io — VAE API host

> **Historical.** The Cloudflare Worker's origin-proxy fallback
> (`VAE_API_ORIGIN`) has been removed entirely — every route is edge-native
> now, and there is no wiring left for a Fly-hosted FastAPI origin to plug
> into. The original FastAPI backend is archived at `legacy/server/` for
> reference only. This doc is kept for historical record of how the
> since-retired proxy tier was set up; don't follow it for a current deploy.
> See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the current architecture.

Hosts the **FastAPI backend** (Gemini ingest, Edge TTS, pack builds). Your
**portfolio Worker** on Cloudflare proxies to this URL via `VAE_API_ORIGIN`.

The **web UI** stays on Cloudflare Pages (portfolio embed). Only the API runs
on Fly.

## What I need from you

You do **not** need to paste secrets into chat. Run these locally:

| Step | You provide | Where |
|------|-------------|--------|
| 1 | Fly account | [fly.io](https://fly.io) — payment method required for volumes |
| 2 | `fly auth login` | CLI |
| 3 | App name (default `vae-api`) | Edit `fly.toml` `app =` if you want a different name |
| 4 | Region (default `iad`) | `fly.toml` `primary_region` — pick closest to you |
| 5 | API secrets | `deploy/fly-secrets.example.env` → `deploy/fly-secrets.env` |
| 6 | After deploy: API URL | Set as Cloudflare `VAE_API_ORIGIN` |

### Required secrets (minimum)

```env
GEMINI_API_KEY=...              # Google AI Studio
QUEUE_WEBHOOK_SECRET=...        # random string; same on Fly + Cloudflare Worker
```

### Strongly recommended (offline packs + CF stack)

```env
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...        # Workers AI permission
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=vae-packs
```

Generate a queue secret:

```powershell
# PowerShell
-join ((48..57 + 65..90 + 97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

## One-time setup

```powershell
cd ebookavplayer

# Install Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
fly auth login

# Create app (uses fly.toml; say no to deploying yet if prompted)
fly launch --no-deploy

# Persistent disk for books / media / packs (10 GB — increase later)
fly volumes create vae_data --size 10 --region iad

# Secrets (create deploy/fly-secrets.env from example first)
fly secrets import < deploy/fly-secrets.env

# Deploy
fly deploy

# Smoke test
fly open /internal/health
fly open /books
```

Expected health JSON:

```json
{"ok": true, "r2": true, "queue_secret": true}
```

## Wire Cloudflare portfolio

After deploy, your API is at `https://vae-api.fly.dev` (or your chosen app name):

```powershell
cd ..\milkman-webapp-portfolio
wrangler secret put VAE_API_ORIGIN
# paste: https://vae-api.fly.dev

wrangler secret put QUEUE_WEBHOOK_SECRET
# same value as Fly

npm run cf:deploy
```

The embedded SPA calls `/projects/ebookavplayer/api/*` → Worker → Fly.

## Costs (ballpark)

| Resource | Notes |
|----------|--------|
| Machine 1× shared 1 GB | ~$5–7/mo if always on |
| Volume 10 GB | ~$1.50/mo |
| Outbound bandwidth | Usually low for personal use |

Set `auto_stop_machines = "on"` in `fly.toml` to save money if you accept cold
starts (not ideal while ingesting a book).

## Operations

```powershell
fly logs                    # live logs
fly ssh console             # shell into machine
fly volumes list            # check disk
fly secrets list            # names only, not values
fly scale memory 2048       # bump for huge audiobook pack builds
```

### Backup

Books and media live on the Fly volume at `/data`. Snapshot or copy periodically:

```powershell
fly ssh console -C "tar czf - -C /data ." > vae-data-backup.tgz
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Health check failing | `fly logs`; ensure volume mounted (`fly volumes list`) |
| 503 from portfolio Worker | `VAE_API_ORIGIN` wrong or Fly app stopped |
| 401 on pack queue | `QUEUE_WEBHOOK_SECRET` mismatch Fly ↔ Worker |
| OOM during audiobook pack | `fly scale memory 2048` |
| Empty library after redeploy | Volume not attached — check `[mounts]` in fly.toml |

See also: [CLOUDFLARE_DEPLOY.md](./CLOUDFLARE_DEPLOY.md), [WORKERS_AI.md](./WORKERS_AI.md).
