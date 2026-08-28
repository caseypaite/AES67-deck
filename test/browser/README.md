# Browser smoke test — TIMELINE view

Headless-browser test for the cue list (Phase 3b) and loudness log (Phase 3c)
in the TIMELINE view. Renders the real UI against a real (isolated) server and
exercises the panels, downloads, and CSV output end to end.

## What it covers

- Switch to TIMELINE, toggle the **CUES** and **LUFS** panels.
- Drop cues while the transport rolls → they list sorted with distinct
  timecodes; inline rename lands in the store.
- **EXPORT CSV** downloads an as-run cue sheet with the right schema.
- The server writes `logs/loudness-<date>.csv` at ~1 Hz while rolling.
- The loudness strip draws the Short-term / Integrated traces and a live
  M/S/I/TP readout; the target selector switches −14 / −23.
- **REPORT REGION** downloads a compliance report with a PASS/FAIL summary.

## Isolation

The run stands up its own stack so a production deck can keep running:

| piece            | detail |
|------------------|--------|
| server           | `PORT=8199`, `AES67_SOCKET_PATH=/tmp/aes67_bt.sock`, data dirs under `.work/` |
| engine           | `fake-engine.mjs` — synthetic metering frames, no JACK / audio |
| UI               | `vite` on `:5273`, `VITE_WS_URL` pointed at `:8199` |
| browser          | Puppeteer + `chrome-headless-shell` |

`.work/` (logs, downloads, screenshots, sandbox state) is git-ignored.

## Run

```bash
(cd ui && npm install)          # once, if not already
cd test/browser
npm install                     # downloads chrome-headless-shell
npm test
```

`npm install` needs `unzip` **or** the bundled `yauzl` dep (already listed) to
unpack the browser. Screenshots land in `.work/shots/`.

The one production hook this needs: the server honours
`AES67_SOCKET_PATH` (defaults to `/tmp/aes67_deck.sock`).

---

## Mixer showcase

`npm run showcase` drives the **MIXER** view through a scripted 12-step tour
and captures the result. Same isolated-stack pattern, but with
`showcase-engine.mjs` — a fake engine that animates every channel/bus meter,
the master analyser (spectrum / goniometer / correlation), BS.1770 loudness,
and per-plugin FX metering.

Output in `.work/showcase/`:

| file | what |
|------|------|
| `NN-*.png` / `.jpg` | one screenshot per step (PNG full quality, JPG for embedding) |
| `mixer-showcase.gif` | the whole run, ~4 fps, 560px (pure-JS encode via `gifenc` + `jpeg-js`) |
| `index.html` | self-contained captioned showcase page (data-URI images) |
| `shots.json` | step manifest |

The GIF is also copied to `docs/media/mixer-showcase.gif` (committed — the main
README embeds it); re-running `npm run showcase` refreshes it.

The tour: console overview → tape-label rename + faders → S/M/REC/ø states →
select a strip (FX rack + aux sends) → insert Calf Compressor + 8-Band EQ →
the analog EQ and compressor editors → the built-in FX chain library →
Master mastering suite → apply a Streaming −14 chain → input bank 2 → scene save.
