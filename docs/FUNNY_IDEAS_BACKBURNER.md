# Funny ideas (backburner)

Not on the roadmap. Preserved so we stop re-inventing them at 2am.

---

## The Great Nano-Banana Heist™

**Premise:** Google AI Studio’s *web* UI allegedly gets hundreds–1k images/day free. The *API* for `gemini-2.5-flash-image` (Nano Banana) reports **free-tier limit: 0** and bills ~$0.04/image once billing is on. Different pipes, different rules.

**The workaround:** Run Playwright against `aistudio.google.com` while logged into Gmail, paste prompts, yoink the `<img>`, upload to R2. Peak hack. Peak ToS grey area.

### Variants (in increasing sketch)

1. **Local bridge (least cursed)** — User runs `scripts/aistudio-bridge/` on their machine with *their* Chrome profile. Same pattern as War Council SD on `:3737`. Worker POSTs prompt → bridge returns PNG. BYO Google quota.

2. **Playwright “test” that saves artifacts** — Generate images in a “test,” download from report output or network intercept. Technically a test. Spiritually fraud.

3. **Multi-Gmail rotation** — Round-robin five accounts through headless windows. Funny. Ban magnet. Do not ship.

4. **“Sign in with Google” in the product** — User links account once; we only automate *their* session. Less funny, more defensible than a server-side account farm.

### Why it’s hard

- UI changes break selectors weekly
- 2FA, CAPTCHA, “unusual activity” emails
- Can’t run on Cloudflare Workers (needs sidecar: local PC, VPS, or Browser Rendering API = $$$)
- Google ToS ≠ “please scrape our free tier at scale”

### If we ever prototype (local only)

```
POST /generate { prompt, referenceUrls? }
→ Playwright + persisted userDataDir
→ AI Studio image flow
→ intercept network OR scrape result img
→ return bytes (optional R2 put)
```

Wire as `local_aistudio` tier after Pollinations, before paid Gemini API.

---

## Fandom yoink engine

Extract pass identifies character → crawl Fandom / wiki → save top 10 mugshots → user picks → slot filled without diffusion. Zero gen cost. Maximum copyright side-eye.

**Storage:** URLs in KV only (no R2) until user pins. Pollinations i2i can consume public URLs via `image=` param.

---

## Image search roulette

Query: `"Rudeus Greyrat" Mushoku Tensei vol 1 official art` → show 10 thumbnails → user picks winners → becomes reference library.

---

## Pollinations anon i2i (actually shipped, mildly funny)

Free `image.pollinations.ai` accepts comma/pipe `image=` refs but uses **flux** — weak continuity. Real i2i (`kontext`, `seedream`) needs pollen credits on `gen.pollinations.ai`. We try Gemini → authed i2i → anon alt fallback.

---

## Current sane stack (for contrast)

| Job | Default |
|-----|---------|
| Text extract | Cerebras / Groq / etc. (Gemini optional, quota precious) |
| Images | Pollinations anon → HF → Cloudflare → Workers AI FLUX |
| Ref-backed moments | Gemini API *if* quota/billing → Pollinations i2i → fail loud |
| EPUB plates | Extract all, no cap; refs from `/media/.../illustrations/` |

See `worker/_shared/pipeline-cost-guide.js` — cost-efficient preset **disables Gemini Image** on purpose.

---

*Last updated: when someone suggested headless Gmail again.*
