# Riv Stream Overlay: agent guide

Foundry VTT module (id `riv-stream-overlay`, v13+, used on v14 with dnd5e 5.x) that turns a
non-GM observer user into clean OBS browser sources, plus a tool that logs those OBS
sources into Foundry.

This repo is **public**. Keep it free of anything specific to a real game: no game URLs,
user names, passwords, Forge account details or local paths beyond `~`. Machine and game
specifics (OBS scene layout, which observer is used, the pre-stream checklist,
troubleshooting) live in a private guide outside the repo:
`/mnt/storage/Misc/OBS Stream Overlays/DnD/AGENTS.md`.

## Files

| File | Purpose |
|---|---|
| `module.json` | Manifest. `socket: true` is required for the mirroring messages. |
| `scripts/main.js` | All module logic (single ES module). |
| `styles/stream.css` | All styling, scoped to `body.riv-stream*` and `#riv-party`. |
| `tools/obs_login.py` | Logs OBS browser sources into Foundry over CDP (see below). |
| `dist/` | Release zip build output (gitignored). |

## Views

`mode` is decided once from the URL, at module load:

| URL | mode | What it shows |
|---|---|---|
| `/game` inside OBS (`window.obsstudio`) or with `#map` | `map` | Canvas only (CSS hides every other body child except `#board` and the Dice So Nice canvas); camera mirrors the GM |
| `/stream` | `chat` | Foundry's built-in chat-only stream page, restyled; mirrors the GM's chat |
| `/stream#party` | `party` | Five portrait slots with HP bars, drawn by the module |
| anything else (the GM's normal client) | `null` | Nothing visible; the GM client is the mirroring source |

The body gets `riv-stream riv-stream-<mode>`; chat also gets `riv-chat-<style>`.

## Mirroring (GM → stream)

All messages go over `game.socket` on `module.riv-stream-overlay`; only GM clients with
`mode === null` send. `CameraMirror.paused` (toggled by the `toggleMirror` keybinding,
default Shift+M) stops all sending.

| Message | Sent when | Receiver behaviour |
|---|---|---|
| `view {sceneId, x, y, width, height}` | `canvasPan` (throttled 100 ms), `canvasReady`, resume | Map view: ignored unless showing the same scene; fits the GM's visible area into its own window and `animatePan`s (250 ms) |
| `chatScroll {atBottom}` or `{messageId, fraction}` | scroll of `#chat .chat-scroll` (throttled 50 ms), after toggles, resume | Chat view: anchors that message's point at the bottom edge (or follows newest), eased per frame (`ChatView.glide`) |
| `chatToggle {messageId, path, changed, added, removed}` or `{attribute: "open", value}` | `class`/`open` attribute changes inside a chat message within 1.5 s of a GM click on it | Chat view: resolves the element and applies the class change |
| `request` | Stream views on load / `canvasReady` | GM replies with `view` and `chatScroll` |

Element paths (`elementPath` / `resolveElementPath`) identify an element inside a message
by tag + non-state classes + index among matching siblings, so GM-only elements (e.g.
dnd5e's damage "Apply" tray) don't break matching. Chat scroll anchors skip whispered
and blind messages, which never reach the stream.

## Foundry quirks this code works around

- **`/stream` fires neither `ready` nor `setup`.** Stream views poll for data
  (`streamDataReady`) and must register the socket listener themselves
  (`registerSocket()` is idempotent and also runs on `setup` for normal clients).
- **`/stream` doesn't load `CONFIG.fontDefinitions`** (dnd5e's Roboto family), so
  `loadRegisteredFonts()` adds them as `FontFace`s.
- **`game.modules.get(id).version` is stale** until the Foundry server restarts; the
  served files update immediately. Browsers may cache the old `main.js`: hard refresh.
- The chat panel is wider than Foundry's sidebar, so `.chat-log` uses `zoom: 1.3`;
  measure positions with `getBoundingClientRect()` (zoom-safe), not offsets.
- Party slot geometry in `stream.css` matches a specific overlay (five 188×188 frames at
  x = 0/284/574/863/1149 within a 1337×188 source). HP bars are centred on the whole
  frame (`left: 22px`), not on the transparent hole, because the frame's shadow is
  heavier on the top/left.

## Settings

World: `slots` (array of actor ids, set through the `slotsMenu` ApplicationV2 form),
`chatStyle` (`parchment` default, `dark`, `banner`, `ledger`), `portraitImage`
(`actor`/`token`), `showHpNumbers`. Keybinding: `toggleMirror`.

## Owner preferences

Keep the stream calm: no damage flashes, shakes or other effects on the party strip, and
no automatic camera following; the camera only mirrors the GM.

## tools/obs_login.py

Requires OBS started with `--remote-debugging-port=9222` (OBS passes its argv to its
embedded CEF). Connects with Playwright `connect_over_cdp` (no browser download needed),
finds panels by viewport size from `~/.config/riv-stream-overlay/obs-login.json`, reads
optional passwords from `passwords.json` there.

OBS browser sources share one cookie jar, so all panels must use the same Foundry user.
If any panel isn't on its page as that user, the script sends every panel to `/join`
(disconnecting the user, since the join screen refuses users who are already connected),
joins once, then loads each panel's page. Never call `browser.close()` on the CDP
connection: it would close OBS's browser.

## Testing

There is no local Foundry. Test against the live game:
- **Stream views**: attach to the OBS panels over CDP (`http://127.0.0.1:9222`) and
  `page.evaluate(...)` (e.g. `globalThis.RivStreamOverlay` exposes `mode`,
  `CameraMirror`, `ChatMirror`, `ChatView`, `PartyView`). Simulate mirror messages by
  calling `ChatView.onScroll(...)` / `CameraMirror.onMessage(...)` directly.
- **Unreleased JS/CSS**: either inject into a separate Playwright browser logged in as
  an observer user that isn't in use (route the `/game` or `/stream` HTML and add a
  `<script type="module">` for `scripts/main.js`), or preview CSS via an OBS browser
  source's Custom CSS.
- Look at results with OBS screenshots (obs-websocket `GetSourceScreenshot`), composited
  over the overlay PNG when checking alignment.
- `node --check scripts/main.js` before every release.

## Releasing

1. Bump `version` and the `download` URL in `module.json`.
2. Build the zip (no `zip` binary on this machine):
   ```python
   import zipfile, pathlib
   with zipfile.ZipFile("dist/riv-stream-overlay.zip", "w", zipfile.ZIP_DEFLATED) as z:
       for f in ["module.json", "README.md", "LICENSE",
                 *map(str, pathlib.Path("scripts").rglob("*.js")),
                 *map(str, pathlib.Path("styles").rglob("*.css"))]:
           z.write(f)
   ```
3. Commit, push, then
   `gh release create vX.Y.Z module.json dist/riv-stream-overlay.zip --title vX.Y.Z --notes "..."`.
4. Wait until `releases/latest/download/module.json` reports the new version (GitHub's
   redirect can lag a minute), then update the module in Forge and reload the world.
