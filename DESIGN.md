# Digicam CCD-03 — design

The interface is the back of a 2003 compact camera. Not a photo editor with a
retro skin: a body you hold, with a screen on it and keys around it. Every
control is a part you could press with a thumb.

This document is the ground truth for the built interface. If the code and this
file disagree, the code is right and this file is stale.

## The object

A graphite polycarbonate body over a magnesium frame, lying on a dark desk.
White silkscreen print on the chassis, charcoal rubber keys, chrome selectors
and knurled thumbs, one small transflective TFT with a green OSD, a red record
lamp and green ready lamps.

The body colour is themed; nothing else is. Chrome, signal lamps and the screen
are the same physical parts whichever shell they are fitted to.

| Theme | How to get it | Notes |
| --- | --- | --- |
| Graphite | default | White print, faint edge sheen, chrome pops |
| Champagne silver | `<html data-theme="silver">` | Dark print, bright edge highlights |

## Colour

Everything is `oklch()`. Tokens live in `:root`, and `[data-theme="silver"]`
overrides only the chassis half of them.

**Chassis (themed).** `--body-hi / --body / --body-mid / --body-lo` are the four
stops of the body gradient, top-lit to bottom-shadowed. `--seam` is the line
where two mouldings meet. `--hairline` is the machined 1px edge around the body,
the bezel and latched keys.

**Light on plastic (themed).** `--edge-hi`, `--edge`, `--edge-soft` are how
brightly an edge catches light: white at 80–90% opacity on silver, 7–16% on
graphite. `--emboss` is the text-shadow under printed labels — a light lower
edge on silver, a dark drop on graphite. Never hardcode a white inset highlight
on a chassis part; it will be wrong in one of the two bodies.

**Deck and keys (themed).** `--deck-hi / --deck-lo` with `--deck-dots` is the
thumb-grip texture on the control side. `--key-*` are the charcoal rubber keys
(the same charcoal in both bodies, with a darker sidewall on graphite).
`--face-*` are the smaller moulded keys, currently just the format selector,
including `--face-on-*` for a latched key, which is always **darker** than its
neighbours because a latched key is pressed in.

**Recesses (themed).** `--well-hi / --well-lo` are slider grooves, switch beds
and the selector well. `--well-fill` is the filled length of a groove.

**Parts (never themed).** `--chrome-*` and `--chrome-ink` for selectors, the
shutter, slider thumbs, switch nubs and the write key — chrome labels stay dark
in both bodies, so use `--chrome-ink`, not `--ink`. `--lcd-*` and `--text-*` for
anything drawn on the screen. `--led-red / --led-green / --led-amber /
--led-off` for lamps.

Contrast on graphite: body print 11.1:1, dimmed print 6.6:1, smallest microprint
5.8:1, chrome key labels 9.3:1. Disabled keys sit near 3:1 on purpose.

## Type

Three faces, three jobs. No other face may appear.

- **Archivo** (`--font-ui`) — sentence-case prose: dropzone copy, hints, toasts.
- **Archivo Narrow** (`--font-print`) — everything printed on the body: key
  caps, section names, control labels, the base plate. Uppercase with wide
  tracking, 9–13px.
- **Silkscreen** (`--font-lcd`) — anything the camera itself displays: OSD,
  value chips, the date field, the model number. Whole-pixel sizes only (9px,
  10px, 11px); fractional sizes blur a pixel face.

## Motion

`--dur-press: 90ms` for a key going down, `--dur-ui: 180ms` for state, and
`--dur-view: 260ms` for a view swap. Easing is `--ease-out` and
`--ease-out-soft`; nothing in the UI uses ease-in.

Keys translate 2px down and swap their cast shadow for an inner one — the
travel is the feedback. The boot sequence irises the screen open. The record
lamp pulses only while the camera is live. Every animation is disabled under
`prefers-reduced-motion`, which also collapses the three durations to 1ms.

## Layout

One `.cam-body` wraps the whole app: top plate, back, base plate.

Above 900px the back is two columns, screen left and control deck right, with
the deck scrolling inside itself. At 900px and below it stacks: the screen
sticks to the top, the deck scrolls under it, and the four main keys become a
fixed dock at the bottom in thumb reach. Touch targets are 44px minimum there.
`.cam-body` must keep `overflow: visible` on mobile or the sticky screen breaks.

## Rules

- A new control is a physical part first. Ask what it would be on the camera —
  a key, a switch, a groove, a lamp — then build that.
- State is never signalled by colour alone. A latched key is recessed *and* lit;
  an error toast has a red lamp *and* says what failed.
- The screen shows the photo. Nothing textures, tints or overlays it: the pixel
  matrix sits under the active view, and the grain is on the desk, not the glass.
- Anything the user must read is Archivo or Archivo Narrow. Silkscreen is for
  short machine strings only.
