# FX plugin UI design guideline (2026-08-26, knob revised 2026-08-28)

How every effect's editor UI in the FX rack must look and behave. Applies to
the plugin detail view in `ui/src/components/plugins/FxRackCard.tsx`
(`PluginDetail`) and every per-effect component it delegates to.

The generic slider-bar list in `PluginDetail` today is a **placeholder**. It
is replaced by the category-specific editors described here.

This doc is FX-specific and sits **on top of `ui-design.md`** — the app-wide
visual language (rack format, realistic 3D analog components). Every knob,
fader, meter, and screen named below is a component from that kit
(`ui/src/components/analog/`); this doc only says how the FX editors
*arrange* them.

## 1. The canvas

- The editor renders in the right pane of the FX panel row; the fixed rack
  card sits to its left (`var(--rack-width)`, ~2/3 of the panel height).
- Usable area at 1080p: **~840 × 410 px** (`1116 − rack-width` wide, 40% of
  the workspace tall). Design to a floor of **600 × 360**; never assume more
  than ~840 wide.
- **No internal vertical scroll.** Everything for one effect fits in view.
  This is a live control surface, not a form.
- Touch-first: primary hit targets ≥ 32 px; drag beats fine typing; every
  control resettable by double-tap.

## 2. Universal three-column layout

Every effect editor is three columns, left → right:

| Column          | Width    | Contents |
|-----------------|----------|----------|
| **Input rail**  | 28–36 px | Vertical VU of the signal *entering* this effect (pre-FX, post previous slot). |
| **Body**        | flex     | The effect-specific editor (§4). |
| **Output rail** | 28–36 px | Vertical VU of the signal *leaving* this effect (post-FX, post wet/dry, post makeup). |

- Both rails follow the metering spec in §5 and share one dB scale, so the
  operator reads the effect's net gain change at a glance.
- Rails are **always present**, even when an effect can't change level; a
  bypassed slot shows input == output.
- The header bar (category chip, name, `ACTIVE`/`BYPASSED`) stays as it is in
  `PluginDetail` today and spans all three columns.

## 3. Analog knob standard

All continuous parameters are **analog rotary knobs** — the shared
`AnalogKnob` component (`ui/src/components/analog/AnalogKnob.tsx`),
**standard** size tier (52–64 px; the FX bays use `KNOB_SIZE = 56`). No bare
`<input type="range">` bars anywhere in the FX body.

The knob is the **"Rotary Knob · LED Level Ring"** design — ported from the
Claude Design canvas (`claude.ai/design/p/8dcc512d…`; the published study is
the artifact "Audio control knob design"). 270° sweep, zero at −135°.

- **Look**, concentric layers outer → inner:
  - a recessed dark **LED channel** at the rim;
  - the **value ring** — a faint unlit track plus an accent
    `conic-gradient` arc filled to the current position, with an always-on
    `drop-shadow` glow (brighter while turning) and a soft blurred bloom
    behind it. The lit arc *is* the value indicator — there is no engraved
    tick ring.
  - a machined **metal collar**;
  - a **chromed cap** (multi-stop metal `linear-gradient`) that rotates, with
    a **static** environment-sheen stack on top (conic reflection + top
    hotspot + directional shade + inset shadow) that does **not** rotate;
  - the **accent pointer** — a short bar in the category colour with its own
    glow, on the rotating cap.
  - `ring` geometry scales with `size` and the channel/track get extra
    contrast so the arc still reads at 56 px (the study was drawn at
    100–200 px).
- **Interaction:** vertical drag = value (≈ `1/240` of range per px; Shift =
  fine, `1/900`); **wheel = 3 % steps**; double-click / double-tap =
  default; **↑ ↓ ← → nudge** once focused (Shift = fine). `role="slider"`
  with `aria-label` / `aria-valuetext`; a hairline focus ring on keyboard
  focus.
- **Bipolar params** (gain, trim, pan) get a red **centre-detent reference
  mark** at 12 o'clock. (No snap detent — the ring reads the offset.)
- **Accent colour** = the effect's category colour (§7).
- The live value + unit shows in a `font-mono` pill that **floats above the
  knob while it is being turned** (mouse: until release; touch: for the whole
  gesture), styled like the fader dB pill in `LiveConsoleView`. The static
  label sits below in `text-[8px] font-black tracking-wide uppercase`.
- Range / label / unit come from the curated per-URI `ParamSpec` maps
  (`data/calfPlugins.ts`, from the `.ttl` files) via
  `paramToPos` / `posToParam` / `formatParam`, which also carry the log /
  gain taper. For non-Calf plugins, fall back to the engine's
  `PluginControlPortInfo` once the server forwards it (`plugin_ports`, §6) —
  **never** the `key.includes('threshold') ? …` heuristic.
- The old `KNOB2624.knob` / `webknobman.html` sprite-sheet route is
  **superseded** — the LED-ring design is pure CSS/DOM (no image assets, no
  frame-count mapping) and lives entirely in `AnalogKnob`.

## 4. Effect-specific body layouts

### 4.1 Equalizers — `category: 'Equalizer'`

Split horizontally **50 / 50**:

- **Top half — response graph.**
  - X: log frequency 20 Hz – 20 kHz. Y: −18 … +18 dB.
  - Live **RTA** behind the curve: translucent filled spectrum (≈1/12-oct
    bars or a smoothed line). Pre-EQ dim grey, post-EQ in category teal.
    Peak-hold ghost line, ~1.5 s decay.
  - The **EQ transfer curve** on top: bright teal, 2 px, subtle glow.
  - **One draggable node per band** on the curve — drag X = frequency,
    drag Y = gain, wheel / pinch / two-finger vertical = Q. Selected node is
    haloed and drives the bottom strip. Node hue steps per band.
  - Grid at decade frequencies and ±6 / ±12 dB.
- **Bottom half — band strip.**
  - One column per band: enable toggle, filter-type selector (`dd.js`
    dropdown styling), then Freq / Gain / Q knobs stacked.
  - Selecting a node up top highlights its column.
  - Global controls: input trim, output trim, bypass, A/B.

### 4.2 Dynamics — compressor, gate, expander, bus comp — `category: 'Dynamics'`

**Graph-driven.** The chart is the primary control; knobs are secondary and
stay in sync with it.

- **Transfer-function graph** (left ~55% of the body):
  - X: input level −60 … 0 dBFS. Y: output level, same scale. 1:1 diagonal
    reference line.
  - Curve rendered from threshold / ratio / knee. **Draggable nodes:**
    threshold point (slides along the diagonal), a knee handle, a ratio
    handle on the upper segment (drag rotates the slope). Makeup shifts the
    whole curve vertically.
  - Live **dot** on the curve = instantaneous in→out, trailing a short
    comet. Shade the gain-reduction region.
- **Gain-reduction history** (right ~45%): scrolling GR-vs-time graph (0 dB
  at top, growing downward), ~4 s window, plus a fast GR bar meter.
- **Bottom knob row:** Attack, Release, Ratio, Threshold, Knee, Makeup, Mix.
- Gate / expander: same graph with downward expansion below threshold, plus
  nodes for range and hysteresis.

### 4.3 De-Esser — `category: 'De-Esser'`

- Mini EQ-style graph: spectrum with the detection band shaded; draggable
  centre-frequency and bandwidth handles.
- GR meter for the sibilance band (as §4.2 right side, narrower).
- Knobs: Threshold, Frequency, Ratio, Range; listen / split toggle.

### 4.4 Saturation / Drive — `category: 'Saturation'`

- Body: a **waveshaper transfer curve** (input vs output) plus a harmonic
  bar readout (2nd / 3rd / … order) driven off the drive amount.
- Optional pre/post mini-RTA strip.
- Knobs: Drive, Blend (dry/wet), Output, tone / character.

### 4.5 Delay — `category: 'Delay'`

- Body: a **tap timeline** — horizontal bar showing L/R tap positions and
  decaying feedback echoes. Drag a tap for time, drag its height for level.
  Tempo-sync toggle with note-division selector.
- Knobs: Time L, Time R, Feedback, Mix, tone (HP/LP), width.

### 4.6 Reverb — `category: 'Reverb'`

- Body: a **decay-envelope graph** (level vs time, RT60 marked) with
  draggable pre-delay and decay-time handles; a frequency-damping curve
  overlaid (drag high-cut / low-cut).
- Knobs: Decay, Pre-delay, High-cut, Low-cut, Mix, size / diffusion.

### 4.7 Limiter — `category: 'Limiter'`

- Body: an output-ceiling graph (like §4.2 but hard-knee at the ceiling)
  with a prominent GR meter and a true-peak readout. Ceiling line draggable.
- Knobs: Ceiling, Threshold, Release, Gain; lookahead toggle.

## 5. Metering spec

Shared by the input/output rails and every in-graph meter.

- Scale **−60 … +6 dBFS**, matching `VuMeter` today.
- Colour stops: green ≤ −10, yellow −10…0, orange 0…+3, red > +3 — reuse
  `VuMeter`'s gradient.
- Ballistics: near-instant attack, ~150 ms ease-out release (as now).
- **Peak hold:** thin line, 1.5 s hold then fall.
- **Clip:** latch the top segment red for 1 s on any sample ≥ 0 dBFS.
- **GR meters:** 0 dB at top, grow **downward**, amber/orange fill; fast
  attack (in dB of reduction), slow recovery.
- Stereo effects: dual hairline L/R bars per rail sharing one track, as
  `VuMeter` already does.

## 6. Data contracts (engine ⇄ server ⇄ UI)

`fx_focus` and per-plugin in/out metering are **implemented**; the rest is
the backend work the graph editors still need. All are additive to the
`metering` scheme.

| Message         | Dir      | Payload                                                              | Feeds | Status |
|-----------------|----------|---------------------------------------------------------------------|-------|--------|
| `fx_focus`      | UI→engine | `{channel, pluginIndex}` (`-1` = none)                              | tells the engine which slot to meter/analyse | **done** — `setFxFocus`, forwarded via server allowlist |
| `fx` (key on `metering`) | engine→UI | `{channel, pluginIndex, inL, inR, outL, outR}` — pre/post-plugin peak dBFS, rides the existing ~metering cadence | input/output rails | **done** — engine `meter_fx`, `store.fxMeter` |
| *(extend `fx` with `gr`)* | engine→UI | gain-reduction dB | GR meter | pending |
| `rta` (key on `fx`) | engine→UI | 31 log-spaced band magnitudes (dBFS) of the focused plugin's **input** — engine Goertzel bank, 2048-sample window | RTA behind the EQ curve | **done** — `g_rta_*` in `main.cpp`, `store.fxMeter.rta`, `FreqScreen` |
| `fx_transfer`   | engine→UI| `{channel, pluginIndex, inDb, outDb}` instantaneous | dynamics comet dot | pending |
| `plugin_ports`  | engine→UI| per-URI array of `PluginControlPortInfo` + unit/log/scalePoints     | knob range / label / unit for non-Calf plugins | pending |

- The engine meters **only the focused slot** (cheap: one `fabs`/max loop on
  the one plugin's pre- and post-buffer, skipped for all others). Bypassed
  slot ⇒ in == out.
- Analysis payloads are **coalesced** to one frame per tick, like `metering`.
- If a stream is absent (engine built without it) the editor still renders:
  graphs show the curve math with no live overlay; rails fall back to the
  channel meter (`meterL` / `meterR`).
- Param writes stay on `set_plugin_param {channel, pluginIndex, paramId,
  value}`. Graph-node drags emit the same message(s), throttled to ~60 Hz,
  one per affected param.

## 7. Visual tokens

- Category accent = `CATEGORY_COLORS` in `FxRackCard.tsx`:

  | Category   | Accent hex |
  |------------|-----------|
  | Saturation | `#f97316` |
  | Dynamics   | `#3b82f6` |
  | De-Esser   | `#a855f7` |
  | Equalizer  | `#14b8a6` |
  | Delay      | `#6366f1` |
  | Reverb     | `#06b6d4` |
  | Limiter    | `#ef4444` |

  The chip, knob accent, active curve, and selected node all use it.
- The FX processor sits in an **anodized-black rack unit** (`ui-design.md`
  §1, §3); the editor body is a recessed `<Scope>` screen + knob panel.
- Backgrounds: panel `#0b0c10` / `#111318`; graph plot area `#050505`; grid
  `rgba(255,255,255,0.06)`.
- Analog texture: the `AnalogOverlay` fractal-noise layer over knob panels
  at opacity ≤ 0.15, `mix-blend-overlay`; the scanline/phosphor layer is
  part of `<Scope>` only.
- Type: labels `text-[9px] font-black tracking-widest uppercase`; value
  readouts `font-mono` — same as the console.
- Dropdowns: the `dd.js` `.select` styling, not native `<select>`.
- Curves / RTA on `<canvas>` (SVG is acceptable for a static curve, canvas
  for the live spectrum), 60 fps via `requestAnimationFrame`, inside a
  `<Scope>` bezel.

## 8. Component layout

Shared hardware (`<Knob>`, `<Fader>`, `<LedMeter>`, `<Scope>`, rack chrome)
comes from `ui/src/components/analog/` — see `ui-design.md` §4. FX-only
pieces:

```
ui/src/components/plugins/
  FxRackCard.tsx        rack + slot list (owns selection)
  PluginDetail.tsx      three-column shell: header, MeterRail, <body>, MeterRail   ← split out of FxRackCard
  fx/
    MeterRail.tsx        vertical VU (wraps <LedMeter>) per §5
    GrMeter.tsx          gain-reduction meter / history
    ResponseGraph.tsx    log-freq curve + RTA (in a <Scope>) — EQ, de-esser
    TransferGraph.tsx    in/out transfer curve + draggable nodes (dynamics, limiter, saturation)
    editors/
      EqEditor.tsx  DynamicsEditor.tsx  DeEsserEditor.tsx
      SaturationEditor.tsx  DelayEditor.tsx  ReverbEditor.tsx  LimiterEditor.tsx
```

`PluginDetail` picks the editor by `categoryOf(plugin.uri)`. An unknown
category falls back to a plain `<Knob>` grid — never the range-bar list.

## 9. Build order

1. **DONE** — `data/calfPlugins.ts` (real LV2 param maps for all 9 Calf
   plugins, from the .ttl files), `components/analog/AnalogKnob.tsx` +
   `Switch.tsx`, `components/plugins/fx/MeterRail.tsx`, and the rebuilt
   `PluginDetail.tsx` three-column shell — metadata-driven knob grid, EQ
   band selector, **BYPASS button** (header + per-slot pill → engine
   `set_plugin_bypass`). Param path: no engine change, `remap_param_symbol`
   passes real symbols straight through.
1b. **DONE** — real per-plugin **in/out metering**: `fx_focus` (UI→engine),
   engine `meter_fx` captures pre/post peak for the focused slot, `fx` key
   on the `metering` frame, `store.fxMeter`, left rail = plugin input /
   right rail = plugin output (falls back to channel meter when no engine).
2. `plugin_ports` (or extend the existing `plugin_list` control-port data
   with unit / logarithmic / scalePoint) so LSP plugins get the same
   treatment as the curated Calf maps.
3–5. **DONE — dedicated editor for every Calf plugin.** The Calf Compressor
   is the reference; all nine share `fx/FxEditorShell.tsx` (dirty-blue
   brushed faceplate · square recessed screen left · optional header meter →
   knob bay → toggle/enum switch row right) + `fx/fxShared.ts`
   (`useCalfParams`). `PluginDetail` routes each Calf URI through
   `CALF_EDITORS`.
   - Screens: `TransferGraph` (compressor — draggable threshold/ratio nodes,
     live dot); `screens/CurveScreen` (saturator soft-clip / crusher bit
     staircase / limiter brick-wall ceiling — live dot, limiter ceiling
     draggable); `screens/FreqScreen` (EQ + de-esser — summed approx-analog
     band response, HTML-overlay draggable nodes, optional synthetic RTA
     gradient behind the curve); `screens/DelayScreen` (tap timeline);
     `screens/ReverbScreen` (decay envelope, draggable pre-delay + RT60).
   - The **EQ** editor departs from the shell (§4.1): band chips + full-width
     response graph + RTA on the top half, the clicked band's knobs on the
     bottom half. Nodes select their band; chips also activate.
   - `fx/GrBar.tsx` — shared gain-reduction / attenuation meter (compressor,
     de-esser, limiter). GR still derived from the in/out meters; a real
     `gr` / `fx_rta` on the `fx` payload would improve dynamics + add live
     RTA behind the EQ curve.
6. **DONE — LED level-ring knob** (§3): `AnalogKnob` reskinned to the
   "Rotary Knob · LED Level Ring" study from the Claude Design canvas (accent
   `conic-gradient` value ring + glow, chromed cap with static environment
   sheen, accent pointer). Pure CSS/DOM, same `ParamSpec` API — all nine
   editors + the generic `PluginDetail` list inherit it. Adds wheel + arrow
   nudge + `role="slider"`. Supersedes the sprite-sheet route.
   Remaining: rack-format chrome (`ui-design.md`).
