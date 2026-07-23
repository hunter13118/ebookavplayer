# PWA / mobile notes

## Safe-area insets (notch / Dynamic Island / home indicator)

`index.html` already sets `viewport-fit=cover` and
`apple-mobile-web-app-status-bar-style: black-translucent` — content draws
full-bleed under the iOS status bar/notch by design. Without explicit
padding, a home-screen-installed PWA renders its top toolbar (Library
header, "More"/Settings buttons) genuinely behind the notch and unusable.

Fix: `--safe-top`/`--safe-bottom`/`--safe-left`/`--safe-right` CSS vars at
`:root` (`styles.css`), each `env(safe-area-inset-*, 0px)` — **0 in an
ordinary browser tab**, non-zero only inside an actual standalone iOS/
Android PWA. Applied via `max(existing-padding, var(--safe-*))` everywhere
content can render full-bleed:

- `.vae-app` — the one top-level wrapper around the whole app (library,
  player, headers). Covers everything in normal document flow.
- `.vae-sheet-backdrop` / `.vae-modal-backdrop` — `position:fixed;inset:0`
  escapes `.vae-app`'s padding entirely; sheets need the same treatment
  independently (Settings, Add Book, Downloads, etc.).
- `.vae-player-fullscreen` — same `fixed;inset:0` escape, for the Player's
  real `requestFullscreen()` mode.

**Any new `position:fixed;inset:0` full-viewport surface needs this same
`max(padding, var(--safe-*))` treatment** — it won't inherit from `.vae-app`.

Verified (no real notched device available this session): computed-style
check with the vars manually overridden to simulate an iPhone
(`--safe-top:47px`, `--safe-bottom:34px`) — `.vae-app` and
`.vae-sheet-backdrop` both picked up the simulated padding correctly, and
reverted to 0 impact in a normal (non-standalone) browser tab. Real iOS
verification is still worth doing when a device is available.

### Standalone detection (`App.jsx`)
`document.documentElement.dataset.standalone` set via
`matchMedia('(display-mode: standalone)')` (cross-platform) OR
`navigator.standalone` (iOS's own non-standard flag). Not required for the
safe-area fix itself (that's purely CSS, self-adjusting) — kept for any
future behavior that genuinely needs to branch on standalone vs. browser-tab.

## Loading indicator during first-open caching

`App.jsx`'s `openBook()` calls `ensureBookCached()` before a first-time cloud
book can open (a real pack-build wait, not instant) — previously silent in
Simple Mode (no `cacheBusy` prop reached `SimpleLibrary` at all) and a small
"Caching…" badge in Full Mode. Both now show **"Getting things ready…"**
(Simple: replaces the row's Play/Continue action label and disables the row;
Full: `BookCard`'s badge, reworded from "Caching…" for consistent tone) while
`cacheBusy === book.book_id`.

## Troubleshooting: phone can't reach the local dev backend

If `http://<mac-lan-ip>:5173/...` works fine from another browser but not
from an iPhone — especially **after adding to the home screen** — the most
likely cause is **iOS's Local Network privacy permission**, not the app or
network setup. A home-screen-installed PWA runs in its own container,
separate from Safari, and needs its own explicit "find and connect to
devices on your local network" grant the first time it reaches a private IP
(`192.x`/`10.x`/`172.16-31.x`). If that system prompt was dismissed or denied
for the installed icon specifically, the connection fails silently with no
useful error client-side. Check iOS Settings → the app (or Settings →
Privacy & Security → Local Network) and ensure it's granted; re-adding to
the home screen after granting can be necessary.

Ruled out while diagnosing this: macOS Application Firewall (already allows
incoming connections to `node`, confirmed via
`socketfilterfw --listapps`/`--getblockall`/`--getstealthmode`); the app/
server itself (loads and functions correctly over the same LAN IP from a
real desktop browser at mobile viewport dimensions).
