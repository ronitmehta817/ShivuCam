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
`--face-*` are the smaller moulded keys — the format selector, the paper stocks
and the 4-cut mode key — including `--face-on-*` for a latched key, which is
always **darker** than its neighbours because a latched key is pressed in.

**Recesses (themed).** `--well-hi / --well-lo` are slider grooves, switch beds
and the selector well. `--well-fill` is the filled length of a groove.

**Paper (not a chassis part).** The five stocks in `PAPERS` in `app.js` are plain
hex, not tokens, because they are printed output rather than interface: they have
to look the same in a downloaded file as they do on screen, and they must not
move when the body colour changes. Each stock carries its own ink and a dimmer
sub-ink for the date, so the footer stays legible on black as well as on cream.
The swatch on each paper key is the same hex, set inline, so the key cannot drift
from what it prints.

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

The booth countdown is the one place a number animates: each second lands with a
single `--dur-view` pop, restarted from script because the class stays on between
numbers. The focus brackets fade out while it runs, since two things cannot own
the middle of the frame at once.

Twenty seconds is long enough to stop watching the number, so the last three turn
red and the numeral has to come back and say so. The three seconds after the
shutter invert that: the scrim goes, the OSD moves to the bottom edge, and all
that is left is a blinking dot and **hold it**. That is the part where somebody is
looking at themselves and holding a pose, and nothing may sit over the middle of
the frame.

## The OSD strip

Mode on the left, size in the middle, battery on the right, in the green pixel
face — the strip a camera of this kind kept across the top of its screen.

The size half is live: the sensor's own frame while the viewfinder is open, the
size a save would write once there is a photo. It read `2.0M` at all times
before, which was decoration in the shape of information, and wrong the moment
the era being imitated stopped applying to the file. Only the look is from 2003;
the photograph is the full size of whatever took it. `FINE` stays fixed, because
that one is true — there is no other quality setting to be in.

Ten megapixels is where the decimal stops earning its place, so `2.1M` keeps one
and `12M` does not.

Movies use the same middle field without pretending a video has megapixels:
`480W MOV` names the long edge and the media type. The left field is **MOV**
while armed, **● REC** while writing, and **▶ MOV** in playback.
An unlocked moving sheet reads **▶ GIF** / `640W GIF`.

## Video

The **Video** control is a two-position hardware switch beside **Mirror** and
**Filtered**, not another momentary mode key beside 4-cut. Those three controls
describe persistent properties of the live camera; Close, 4-cut and the device
selector remain together on the left. This also keeps the round shutter alone in
the center. In movie mode its chrome center gains a red dot before recording and
a square while recording, so start and stop remain legible without colour.

The recording readout belongs to the LCD, not to the file. A blinking lamp,
**REC**, elapsed time and the 30-second limit sit at the bottom-right of the live
frame while the focus brackets recede. They are DOM over the canvas, so only an
explicit date stamp can burn machine text into the movie.

A movie is the filtered LCD feed: 480px on its long edge at 15 fps, capped at 30
seconds. That is the performance envelope in which the entire pixel pipeline can
run on a phone without a worker, and it is closer to a 2003 movie mode than a
modern HD recording would be. Stills continue to use the full sensor frame.
`camCanvas.captureStream()` hands the already mirrored and filtered frames to
`MediaRecorder`; compressed chunks are held instead of raw canvases. MP4 is
preferred when the browser exposes it and WebM is the fallback.

Microphone audio comes from the same camera permission request. Its track is
cloned into the canvas stream, so stopping the recorder cannot pull the live
camera out from underneath the final encoder flush. If audio is refused, the
movie remains available and says **silent** in the readout.

Playback is a fourth LCD view. The center prompt and **Play clip** switch carry
the same state; the control deck becomes one Video data plate and a physical
**Record another** key. Image adjustments disappear there because they are
already baked into the encoded Blob. The chrome Secure save key encrypts that
Blob and writes only the `.digicam` container.

## Secure export

The write key still occupies the primary chrome position, but its long label is
**Secure save** and its phone label is **Lock**. The separate motion key is
**Lock GIF**. A save never branches to a normal image, video or GIF download.
The media format selector still matters — PNG versus JPEG determines the bytes
prepared in memory — but the file on disk is always `.digicam`.

An inset warning plate sits beside each secure save surface. It is deliberately
plain and persistent, not a one-time modal: **Device locked**, no recovery key,
clearing site data destroys access. Amber on the lock drawing is caution rather
than success. The consequence is stated in readable Archivo; Silkscreen would
turn a permanent-loss warning into decoration.

The device identity is one non-exportable AES-256-GCM `CryptoKey` in IndexedDB.
It belongs to the exact browser origin and profile, not abstractly to the piece
of hardware. `secure.js` writes an encrypted metadata record followed by 1 MiB
media records. Each record gets a unique nonce and authenticates its index and
the whole container header as additional data. Wrong key, mutation, truncation
and reordering all refuse to decrypt; none return partial media.

The visible filename is a generic timestamp, so source names and media types do
not leak through cloud listings. Metadata is encrypted. The only plaintext
container facts are the `DGC1` format marker, version, chunk map, random nonce
base, ciphertext lengths, and total file size.

Opening a `.digicam` file uses the ordinary Open key. Images return to the
editor. Video returns to the movie player; an animated sheet uses the same LCD
frame with a native `<img>` surface and hides the play switch because GIF timing
owns itself. Authentication failure is named as either another device key or
changed encrypted bytes; the app never calls deliberate corruption a feature.

## Layout

One `.cam-body` wraps the whole app: top plate, back, base plate.

Above 900px the back is two columns, screen left and control deck right, with
the deck scrolling inside itself. At 900px and below it stacks: the screen
sticks to the top, the deck scrolls under it, and the four main keys become a
fixed dock at the bottom in thumb reach. Touch targets are 44px minimum there.
`.cam-body` must keep `overflow: visible` on mobile or the sticky screen breaks.

The shutter stays centred in the camera bar, alone in the middle column. Mode
keys — Close, 4-cut, the device selector — belong to the left group, which is why
4-cut lives there rather than beside the shutter: putting it in the middle column
squeezed the switches on the right until their labels clipped.

The right group now has three switches rather than two. On a phone this does not
make the bar taller: the left group already had three 44px controls, so Video
uses the height the opposite column was already paying for.

Four cuts print two by two rather than in a column. A 2 × 6 strip is 1:3, which
on a phone is the worst shape there is: sized to be readable it left 130px for the
whole control deck, and sized to leave the deck room it was a ribbon. Two by two
is 6:5, close enough to a photo to live by the photo sizing rules and to leave
336px of deck at rest. It is also the arrangement that reads as a print rather
than as a receipt. `.canvas-wrap` still drops to `width: auto` so the frame hugs
the sheet — otherwise the compare layer, which stretches to fill the frame,
distorts. The frame hugs the photo on mobile for the same reason, and because a
canvas given a definite width cannot keep its own ratio: a portrait photo was
being stretched to fit.

The booth gets its own key on the empty screen, next to the camera, because it is
a destination rather than a setting: nobody wants to open a camera in order to
find a photobooth. It stays the quieter key of the two so the empty state keeps
one primary. Its glyph is four cells two by two — the print it makes.

A booth print is finished work, so the deck drops **Adjustments** entirely for
one (`body[data-origin="booth"]`) instead of leaving seventeen sliders that
nobody in a booth is asking for. Sheets you assembled yourself keep theirs; the
flag lives on the sheet, not on the app. During a run the block is `inert` and
dimmed rather than removed, because pulling a block out of the deck mid-countdown
would move everything under it — and it has to be unreachable, or cut one and cut
four are two different photographs. Pressing the booth re-applies the scene and
forces the viewfinder filter on for that last reason too.

Footer type is set against the cut, not against the paper. Scaling it with the
sheet would have made the caption on a two-up sheet twice the size it should be;
a printed caption stays small whatever it is printed on.

A booth run has two outputs, so it gets two lock keys: **Lock** for the sheet and
the separate narrow **Lock GIF** key for the same sheet moving. Both encrypt
before download. The second key appears only when there is motion to lock; the
GIF is a property of the sheet, not a mode.

**Play motion** sits under the screen next to the compare slider rather than in
the deck, because it is a control for the screen. While it plays, the compare
divider is hidden: a divider across a moving image is two ideas at once and
neither reads.

The moving sheet is composed at playback and save rather than baked at record
time, which is what lets the loop follow the paper picked afterwards. It costs a
tenth of a millisecond a frame.

A sheet is tall enough to fill the phone screen top to bottom, so `.viewer`
reserves 23px above it — without the reserve the paper prints straight over the
mode and the battery in the OSD strip.

On a phone the screen is `50dvh` and nothing changes that: not a portrait photo,
not a 2 × 2 sheet, not the empty state. A box that sized itself around its
contents moved the whole deck every time the contents changed, and a screen that
shrank as you scrolled into the sliders moved it twice more. Half is also the
honest split — the screen is pinned, so it is taking that space either way, and
the deck gets a stable half instead of a negotiated one.

The image then gets whatever the box is not already spending: `50dvh` less 16px
of bezel, 29px of padding, the 8px gap and a 69px foot. That subtraction is only
safe because the foot cannot surprise it — on mobile the foot is one line of
readout over one row of switches, both clipped rather than wrapped, so it is 69px
on a 320px phone as well as a 430px one. Before that, two rows of switches and a
wrapped readout on a small phone pushed the image up over the OSD.

The viewfinder is the exception and keeps sizing to its own content: a camera
wants every pixel it can get, and there is no deck to protect while it is open.
Landscape is the other exception — the screen is not pinned there, so there is
nothing to pay for.

The stacked screen views are absolutely positioned unless active. Left in flow,
the dropzone and the viewfinder kept holding the screen open to their own height
behind the photo — 149px of dead glass under a compact preview.

The photo is capped at `calc(100vh - 276px)` on desktop, and 276 is not a guess:
everything above and below it inside the shell measures a fixed 275px, and the
frame clips whatever the photo asks for beyond that.

A vertical swipe on the photo scrolls the page. `touch-action: pan-y` on the
frame and a horizontal-intent test in the drag handler mean the compare split
only takes gestures that are going sideways; the divider itself, being
unambiguous, takes everything.

## Rules

- A new control is a physical part first. Ask what it would be on the camera —
  a key, a switch, a groove, a lamp — then build that.
- State is never signalled by colour alone. A latched key is recessed *and* lit;
  an error toast has a red lamp *and* says what failed.
- The screen shows the photo. Nothing textures, tints or overlays it: the pixel
  matrix sits under the active view, and the grain is on the desk, not the glass.
- The filter belongs to the photograph, not to the print. Paper, borders and the
  printed footer stay clean, which is why cuts are filtered individually and the
  sheet is composed afterwards.
- Anything the user must read is Archivo or Archivo Narrow. Silkscreen is for
  short machine strings only.
