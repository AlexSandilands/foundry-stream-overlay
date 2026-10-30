# Riv Stream Overlay

A Foundry VTT module (v13+, tested on v14 with dnd5e 5.x) that turns a non-GM observer
user into clean OBS browser sources for streaming:

| Browser source URL | Shows |
|---|---|
| `https://<your-game>/game` (inside OBS, or with `#map`) | The map only, no Foundry UI. The camera mirrors the GM's view while the GM is on the same scene. |
| `https://<your-game>/stream` | The chat log, styled for streaming. |
| `https://<your-game>/stream#party` | Party portraits with live HP bars. |

## GM controls

- **Shift+M** pauses or resumes the stream camera (configurable under Configure Controls).
- Viewing another scene to prepare it never moves the stream; mirroring only applies to the scene the stream is showing.
- Module settings: party slot characters, portrait image (portrait art or token), HP numbers, chat style.

## Install

Install from manifest:

```
https://github.com/AlexSandilands/foundry-stream-overlay/releases/latest/download/module.json
```

Then enable it in the world and choose the party slots under Module Settings.

## Notes

The party strip layout (five 188×188 slots) is sized for the matching OBS overlay.
Give the stream user Observer (not Owner) permission on the player characters so it
shares the party's vision.
