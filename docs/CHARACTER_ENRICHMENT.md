# Character Enrichment (Phase 3)

Design record for `docs/02_REVOLUTION_ROADMAP.md`'s Phase 3 — "enrich text,
not pixels." Implemented in `worker/_shared/character-enrich.js`.

## What it does

After a book's whole character roster is final (every chapter has drained —
see "Pipeline hook point" below), and only when opted in, the worker looks up
each named, non-placeholder character on a couple of free fan-content sources
and asks an LLM to pull out **structured textual attributes** from whatever
prose it finds:

```json
{
  "hair_color": "silver", "eye_color": "violet", "build": "tall and lean",
  "age": "early 20s", "outfit": "a travel cloak",
  "speech_register": "formal and precise", "cadence": "slow and deliberate"
}
```

Any attribute not clearly stated in the source text comes back `null` and is
never written onto the character — the LLM prompt (`ENRICH_SYSTEM` in
`character-enrich.js`) explicitly forbids guessing.

These attributes then feed two existing consumers, both additive and
backward-compatible (no effect when the fields are absent):

- **Image prompt** — `edge-imaging.js`'s `characterGenDescription()` appends
  a "Canonically: …" clause built from `hair_color`/`eye_color`/`build`/
  `outfit`, the same way it already appends `appearance_changes`.
- **Voice/prosody** — `voice-assign.js` maps `speech_register`/`cadence`
  free text through small keyword tables onto a pitch nudge and a rate
  percentage, layered on top of the existing gender/age/turn-order logic.

## Why no scraped images

The roadmap explicitly rules out piping fan art into img2img conditioning —
real copyright exposure for unlicensed art, especially on a public portfolio
piece. Structured text distilled from wiki prose gets most of the accuracy
gain (canonical hair color, defining outfit, etc.) with none of that risk.
The separate, user-driven "pin a reference image URL yourself" flow
(`external-refs.js`, `ReplaceArtSheet.jsx`) is untouched — that's a deliberate
user choice and a different thing.

## Sources (v1: Fandom + MyAnimeList, both keyless)

Both APIs are free and require no signup/API key, which is what keeps this
on the right side of the project's `$0` ceiling and avoids needing the user
to create any new account.

1. **Fandom** — `resolveFandomWiki()` finds the right wiki domain for the
   book's series (cached per series — most characters in a book share one
   wiki), then `fetchFandomCharacterExtract()` uses the standard MediaWiki
   API: `action=query&list=search` to find the page, then `action=parse&
   prop=wikitext` to pull the page's raw wikitext against that wiki. **Not
   `prop=extracts`** (clean plain text) — confirmed live during
   implementation that it needs the TextExtracts extension, which isn't
   installed on every Fandom wiki (errors with "Unrecognized value for
   parameter prop: extracts" on at least one real wiki tested). Raw wikitext
   is core MediaWiki (works everywhere) and, confirmed against a real
   character page, its infobox lines (`|hair=...`, `|eye=...`, `|age=...`)
   are exactly the attributes this module wants — only the noisiest
   non-prose blocks (image galleries, citation refs, comments) are stripped
   before the text is handed to the LLM structuring pass, which parses
   `|key = value` markup fine on its own. **Domain resolution is a
   guess-and-confirm, not a search call**: Fandom's own
   public cross-wiki search (`fandom.com/api/v1/Search/CrossWiki`) turned
   out to be sat behind a Cloudflare JS challenge — confirmed live during
   implementation, it returns an HTML "Just a moment…" page to a plain
   server-side `fetch()`, not JSON. Individual wiki subdomains are **not**
   behind that wall, so instead `resolveFandomWiki()` guesses the subdomain
   from the series title (Fandom subdomains are near-always the series name
   with spaces/punctuation stripped, no dashes) and confirms the guess with
   a lightweight `meta=siteinfo` call before using it — see
   `candidateWikiDomains()`/`probeWikiDomain()` in `character-enrich.js`.
2. **MyAnimeList**, via the free [Jikan](https://jikan.moe/) REST wrapper —
   fallback when Fandom has no match. `fetchJikanCharacterAbout()` queries
   `api.jikan.moe/v4/characters` and uses the `about` field.

Baka-Tsuki (light-novel fan translations, also named in the roadmap) was
deferred from v1 — its current API shape wasn't confirmed at implementation
time. Best-effort integration following the same MediaWiki-API pattern as
Fandom is a natural fast-follow once verified against a real book.

## Caching

Everything lives in the existing `VAE_JOBS` KV binding under new key
prefixes — no new KV namespace, no wrangler.toml change:

- `character_enrich:v1:{series-slug}:{name-slug}` — the enrichment result
  itself (or a cached `null` for "nothing found"). Positive hits cache 90
  days (fan-wiki prose is fairly stable); negative results cache 7 days
  (short enough to retry later, long enough to stop hammering search on
  every re-extraction of the same book for an obscure/original character).
- `character_enrich:wiki:v1:{series-slug}` — the resolved Fandom wiki domain
  for a series, so the cross-wiki search only runs once per series, not once
  per character.

This is a **new module**, not a reuse of `external-refs.js` — that file is a
different shape entirely (user-pinned image URLs for the BYO/i2i flow), and
mixing the two would have been the wrong abstraction.

## Pipeline hook point

`chapter-extract-pipeline.js`'s `runCheckpointedExtraction`, right after
`analysisCharacters` is finalized and before the `analysis`/`playback`
objects are built — the first point the whole-book roster is stable (a given
character's id can still be rewritten by `character-reconcile.js` up to that
point) and before the imaging block runs, so enriched fields are in place
when image prompts get built. Results are merged onto both the
`analysis.json` character list and the `playback.json` (`knownCharacters`)
copy via `mergeEnrichmentIntoCharacter()`, since imaging/voice-assign read
the latter.

## Toggle & failure behavior

`VAE_CHARACTER_ENRICH=true` in `.env` — default **off**. `enrichCharacters()`
runs with bounded concurrency (default 3) and an overall time budget (default
45s) over the whole roster; any single character's lookup/parse failure is
fully non-fatal (falls back to no enrichment for that character), and the
whole step is wrapped so a total outage never blocks book processing —
extraction proceeds exactly as it did before Phase 3.
