# AES67-Deck UI design language (2026-08-26)

The master visual language for the whole app — console, timeline, patchbay,
and the FX editors (which additionally follow `fx-ui-design.md`).

Two rules govern everything:

1. **Rack format.** The interface reads as a 19-inch equipment rack. Every
   functional area is a rack unit with a metal faceplate, mounting ears,
   and screws.
2. **Realistic analog components.** Knobs, faders, buttons, switches, and
   meters are dimensional, materially believable, lit from one source — not
   flat UI widgets.

This is a re-skin, not a re-layout. The confirmed layouts and dimensions
recorded in project memory (channel strip layout, SourceSendsPanel sizing,
the 1116px FX-panel cap and sends-sidebar alignment) stay exactly as they
are — rack chrome wraps them. Any change to those dimensions needs sign-off
first.

---

## 1. Rack format

### The rack

- The viewport is a rack enclosure. Fixed **rack rails** run down the far
  left and right edges: a dark anodized strip (~18–22 px) with evenly
  spaced mounting holes and a soft inner shadow, framing everything.
- Content is a vertical stack of **rack units**, full width between the
  rails, separated by a thin seam (a 2–3 px dark gap with a highlight on
  the lower lip of the unit above and shadow on the upper lip below).
- The stack scrolls as one rack when taller than the viewport; the top
  toolbar is the rack's fixed top trim.

### A rack unit

Every unit is a `<RackUnit>`:

- **Faceplate** — a finished metal panel (finishes in §3). Slight top-edge
  rim light, bottom-edge contact shadow, faint overall vignette so it looks
  physically mounted and lit from above-left.
- **Mounting ears** — the faceplate's left and right ~16 px carry 1–2
  countersunk bolt holes each, aligned to the rail holes.
- **Screws** — a `<RackScrew>` at each of the 4 ear positions: Phillips or
  hex head, ~10–12 px, its own tiny bevel + cast shadow, a few degrees of
  random rotation each. Subtle. Never cartoonish.
- **Silkscreen** — unit title and section labels are engraved/printed:
  `text-[9px] font-black tracking-widest uppercase`, low-contrast, with a
  1 px light emboss (`text-shadow`).
- **Section tint** — the faceplate finish is tinted with the section's
  existing accent (channel-strip section colours, `CATEGORY_COLORS`), kept
  desaturated — a hint, not paint.

### Mapping the current app to units

| Area                        | Unit                                                        |
|-----------------------------|------------------------------------------------------------|
| Top toolbar (MIXER/TIMELINE/PATCHBAY, scenes) | Rack top trim — brushed strip, backlit tab buttons, transport as illuminated hardware buttons |
| FX panel row                | `FX PROCESSOR` unit — rack card as an inset sub-module, editor as a recessed screen + knob panel |
| Mixer surface               | `CONSOLE` unit(s) — the channel strips sit on a faceplate; the input bank, aux group, and monitor/master group each read as bays on that plate |
| Timeline                    | `TIMELINE` unit — recessed screen for the arrangement, transport hardware on the plate |
| Patchbay                    | `PATCHBAY` unit — literal patch-field look: rows of labelled jacks, cables for connections |

### Rhythm

- Define a base **1U** in `ui/src/components/analog/rack.ts` (a CSS var,
  e.g. `--rack-u`). Unit heights are whole multiples where practical; the
  console unit is the deliberate oversized exception (a console leaning
  back out of the rack).
- Horizontal internal spacing keeps the existing `gap-3` / `p-2` grid.

---

## 2. Realistic analog components

Shared kit in `ui/src/components/analog/`. Existing `MiniAnalogKnob`
(`ChannelStrip.tsx`) and `VuMeter` are the starting point — upgrade, don't
discard.

### Global lighting & material model

- **One light source:** top-left, elevation ~35°. Every highlight, every
  cast shadow agrees with it.
- **Two shadows per raised element:** a tight dark contact shadow + a wide
  soft ambient one.
- Interactive controls are **never flat fills** — always layered radial +
  linear gradients, a rim, an inner shadow, and a specular hit.
- Materials: *brushed metal* (anisotropic streak highlight), *anodized
  black*, *powder-coat grey*, *matte plastic* (soft broad specular),
  *rubber* (grip rings, no specular). Pick per component below.
- **Grain:** the `AnalogOverlay` fractal-noise layer over faceplates and
  caps at opacity ≤ 0.15, `mix-blend-overlay`. Scanline/phosphor layer is
  for screens only (§2.6).
- CSS-first: layered `background`, `box-shadow`, `border-image`. Sprite
  sheets only where CSS can't reach photoreal (knurling). Animate
  `transform`/`opacity` only — no `filter: blur` inside drag loops.

### 2.1 Knobs — `<Knob>`

Layers, bottom to top:

1. **Tick ring** engraved into the faceplate (recessed, dark, inner shadow).
2. **Outer skirt** — chamfered, radial gradient `circle at 35% 35%`,
   bright rim on the top-left arc, dark on the bottom-right.
3. **Knurled grip band** — fine vertical flutes via `repeating-conic-gradient`,
   slight rubber sheen.
4. **Top cap** — brushed aluminium or matte, own micro-bevel.
5. **Indicator** — engraved line or a raised pip that casts its own shadow
   across the cap and skirt as it rotates.
6. Optional **LED collar** / engraved value arc showing position.

- Sweep 270°, zero at −135° (matches `MiniAnalogKnob`).
- Size tiers: **mini** ~37 px (channel strip), **standard** 52–64 px (FX),
  **hero** 80 px+ (master / headline controls).
- States: hover → rim brightens; press/drag → cap presses in
  (`scale(.98)` + deeper inner shadow); release → settle.
- Interaction: vertical drag ≈ 0.5 %/px of range, double-tap = default,
  slow-drag / Shift = fine.
- Bipolar params: red centre tick + centre detent.
- Accent = category / section colour.
- **The FX editors already ship this as `AnalogKnob`
  (`ui/src/components/analog/AnalogKnob.tsx`)** in the "LED level ring"
  treatment — accent `conic-gradient` value arc (layer 6) instead of an
  engraved tick ring, chromed cap, glowing accent pointer, pure CSS.
  See `fx-ui-design.md` §3. The channel-strip `MiniAnalogKnob` still uses the
  older skirt/knurl look; unify on `AnalogKnob` when `<Knob>` lands.
- ~~`KNOB2624.knob` (WebKnobMan) sprite path~~ — superseded by the pure-CSS
  LED-ring knob above.

### 2.2 Faders — `<Fader>`

- **Slot** — a channel routed into the faceplate: inner shadow, a black or
  metal track insert, an engraved centre/detent line.
- **Cap** — moulded plastic or aluminium: grip line, side flutes, a
  coloured indicator stripe, top highlight, and a **drop shadow onto the
  track that tracks its position**.
- **Scale** — dB marks engraved beside the slot (reuse `SendFaderColumn`'s
  marks: +6 / 0 / −6 / −12 / −∞).
- Real throw (≈ 60–100 mm equivalent). Programmatic moves (scene recall)
  ease smoothly — motorised-fader feel.
- Vertical default; horizontal variant for balance / crossfade.

### 2.3 Push-buttons — `<PushButton>`

- Moulded, bevelled, with real travel: press → `translateY(1px)` + shadow
  collapse + face darken.
- **LED**: on = lit lens with a soft bloom; off = dark inset lens.
- Engraved legend. Latching vs momentary read differently (latched sits
  lower, brighter LED).
- Mute / solo / bypass are **illuminated bar buttons** — full coloured
  backlit lens (red / yellow / blue), matching today's channel-strip colours.

### 2.4 Toggles & rockers — `<Rocker>`

- Bypass, phase, sync, listen: a real rocker or bat toggle with a metal
  lever, throw animation, and a shadow into the panel cut-out.

### 2.5 Meters — `<LedMeter>` / `<NeedleMeter>`

- Default: LED-ladder / backlit bar under a glass lens (faint reflection
  gradient, bezel), following `fx-ui-design.md` §5 (scale, colours,
  ballistics, peak-hold, clip latch). This is the upgrade path for
  `VuMeter`.
- Master / headline: optional moving-coil **needle** meter — ballistic
  needle, illuminated arc scale, glass, bezel.
- GR meters: same lens, fill grows downward from 0 dB, amber.

### 2.6 Screens — `<Scope>` / recessed displays

- RTA, transfer curves, timeline, and any graph render as a **recessed
  backlit display**: dark glass plate, bezel, faint phosphor glow +
  optional scanlines, a slight edge vignette (screen curvature).
- Plot bg `#050505`, grid `rgba(255,255,255,0.06)`, trace in the section
  accent with a soft glow.
- 60 fps canvas; bake the bezel/glass as static chrome around it.

### 2.7 Patch field — `<Jack>` / `<PatchCable>`

- Patchbay connections are literal ¼" jacks in a drilled panel with a
  metal nut ring and inner shadow; an active connection is a slightly
  slack, shaded cable with a moulded plug.

---

## 3. Faceplate finishes

| Finish            | Use                                    | Recipe sketch |
|-------------------|----------------------------------------|---------------|
| Brushed aluminium | top trim, hero units                   | horizontal fine-streak gradient + anisotropic highlight band + grain |
| Anodized black    | FX processor, patchbay                  | near-black vertical gradient, cool rim light, heavier grain |
| Powder-coat grey  | console surface                        | matte mid-grey, soft broad highlight, fine grain |

All three take a desaturated section-colour tint and the top-left lighting.

---

## 4. Component kit / build order

```
ui/src/components/analog/
  rack.ts          --rack-u and shared tokens
  RackRail.tsx     RackUnit.tsx     RackScrew.tsx     Faceplate.tsx
  Knob.tsx         Fader.tsx        PushButton.tsx    Rocker.tsx
  LedMeter.tsx     NeedleMeter.tsx  Scope.tsx
  Jack.tsx         PatchCable.tsx
```

1. `Faceplate` + `RackUnit` + `RackScrew` + `RackRail`; wrap the existing
   toolbar / FX row / mixer in units with **no layout changes**.
   - **Partial (FX area only)** — `src/index.css` carries a metallic surface
     kit: `.metal-face` (brushed gunmetal, horizontal brush), `.metal-face-rack`
     (darker, vertical brush), `.metal-grain` (fractal-noise overlay via
     `::before`), `.metal-well` (recessed), `.metal-btn`, `.metal-groove`,
     `.text-engrave`, `.metal-screw`; plus `components/analog/Screw.tsx`.
     Applied to the FX panel row (+ corner screws), the FX rack card
     (nameplate header, machined slot well, brushed slot modules with a
     category-accent stripe), preset/insert buttons, and the `PluginDetail`
     header/footer. Still to do: extract into real `Faceplate`/`RackUnit`
     components and roll out to the toolbar, mixer, timeline, patchbay.
2. `Knob` (all three size tiers) — replace `MiniAnalogKnob` and the FX knob
   placeholder in one move.
3. `Fader` — replace the channel-strip and `SendFaderColumn` faders.
4. `PushButton` / `Rocker` — replace mixer + toolbar buttons.
5. `LedMeter` — replace `VuMeter`; `Scope` for the FX graphs
   (`fx-ui-design.md`).
6. `NeedleMeter`, `Jack` / `PatchCable`.

Keep the existing background palette (`#0b0c10`, `#111318`) and category
accents (`CATEGORY_COLORS`). Test every step on the 1080p touch target for
frame rate.
