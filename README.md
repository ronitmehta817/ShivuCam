# Digicam

A browser tool that gives any photo the look of an early-2000s point-and-shoot,
then lets you download the result at full original resolution. Load a file or
shoot through a live viewfinder that already has the filter applied. Plain HTML,
CSS and JavaScript, no build step and no dependencies. Nothing is uploaded
anywhere; all processing happens on your machine, and the camera stream never
leaves the page.

## Running it

Open `index.html` in a browser. That is the whole setup.

If your browser blocks anything over the `file://` protocol, serve the folder
instead:

```bash
cd digicam-filter
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Using it

1. Drop a photo onto the window, click to browse, paste from the clipboard, or
   hit **Shoot with camera** to use a live viewfinder.
2. The look is already on it. Fine-tune with the sliders if you want, and drag
   the divider on the image to compare against the original.
3. Click **Download**.

There is nothing to pick. Every photo arrives already shot in low light on a
2.0MP CCD: the situation these sensors handled worst and the reason the era
looks the way it does. Heavy sensor noise, the noise reduction smearing it into
blotches, a long shutter's worth of vignetting, and detail already gone before
the JPEG encoder gets to it.

Those values come from measurements where a measurement exists rather than from
taste — sharpening, for instance, sits at the measured median halo rather than
the caricature a higher gain produces. Every one of them is still a slider, so
the look is a starting point, not a limit. **Reset** puts it back.

## Camera mode

The viewfinder runs the whole pipeline on every frame, so you frame the shot
through the filter rather than applying it afterwards. Adjustments take effect
live, which makes the sliders far easier to understand than they are on a still.

- **Shutter** is the round button, or press <kbd>Space</kbd>. <kbd>Esc</kbd>
  closes the camera.
- **Mirror** flips the frame, and turns itself on for front-facing cameras since
  those are mirrors. It applies to the saved photo too, so what you framed is
  what you get.
- **Filtered** can be switched off when you need an honest view to frame by.
- The dropdown appears when there is more than one camera. Labels only become
  readable once permission is granted; that is a browser privacy rule, not a bug.

Capture happens at the sensor's full resolution, not at the viewfinder's. The
viewfinder is deliberately small — around 480px on its long edge, which is a
frame-rate budget rather than a quality choice, and lands at roughly 25fps. It is
also honest: the LCD on one of these cameras held about 110k pixels.

The camera is requested at 4:3 and about 2 MP, the shape and size these cameras
actually shot, though browsers treat that as a hint and return whatever the
hardware offers. The stream is released the instant it leaves the screen — after a
capture, when you close the camera, or when you switch away from the tab — so the
recording indicator never stays lit longer than the viewfinder is visible.

Browsers only expose cameras to secure pages. `http://localhost` counts, so the
`python3 -m http.server` command above is the reliable way to run this. If you
opened `index.html` straight from disk and the camera will not start, the app
tells you to serve it instead.

## What the filter does

A colour grade alone will not pass as a photo from 2003. The look comes from
artefacts, and artefacts only land correctly if they are applied in the order a
real camera produced them — so the pipeline follows the actual imaging chain:

```
optical  ->  sensor sampling  ->  sensor response  ->  in-camera processing
```

**Optical.** Purple fringing, the giveaway of a cheap zoom on a small sensor. Red
and blue are resampled at slightly different scales, which is true lateral
chromatic aberration, and dark edges standing against something bright pick up a
violet rim. Both worsen toward the corners. The rim deliberately lands on the
dark side of the edge — the branch, not the sky behind it — because that is where
it appears in real photos, and applying it symmetrically just looks like a tint.
Then two kinds of falloff, which are different things and often conflated. Lens
vignetting dims the corners by a fraction of a stop. **Flash falloff** is the
inverse-square law throwing away most of the light before it reaches anything
behind the subject — about three stops out to the frame corners in the reference
frame — and what little reaches them is room light rather than the flash tube, so
it warms as it darkens. That cold-subject-against-warm-murk split is what gives
an on-camera flash away.

**Sensor sampling.** Detail is thrown away by resampling down and back up, and
the frame is left at its original dimensions. This is the single biggest reason a
modern photo does not read as a digicam shot, and nothing else substitutes for
it: a 2 MP sensor never recorded that detail, so no amount of grading can imply
its absence.

**Sensor response.** White balance, including the green cast a failing auto white
balance left on indoor shots, then a contrast curve whose defining trait is the
top end. These sensors had perhaps six stops, so highlights did not roll off
gracefully — they hit a wall, went flat featureless white, and lost their colour
on the way. Blown highlights then bleed a veiling halo, and CCD smear draws a
pale band the **full height** of any column containing something too bright:
overloaded photosites leaked charge into the vertical transfer register, and the
register carried it the whole way out. Only a column's excess over its neighbours
is visible, so the band is drawn from that difference — which is what separates a
compact specular glint, that smears, from a broad blown highlight like a white
shirt, that does not. Skip it and every sunlit frame ends up ruled with stripes.

Finally sensor noise, in two forms whose shapes were measured rather than assumed,
because both run against intuition. Luminance grain **rises** with brightness:
photon shot noise scales with the square root of the signal and swamps everything
else, so grain being worst in the shadows is a film habit, not a digital one. It
only falls away in the last stop, where clipped pixels have nothing left to vary.
Chroma blotching is U-shaped — worst in deep shadow where the colour signal is
buried, then rising again at the very top as channels clip unevenly and drag the
hue around.

**In-camera processing.** Chroma subsampling, so colour bleeds across edges in
blocks and the shadow colour noise softens into blotches. Then noise reduction
and sharpening, which ran as one contradictory step: the same processor smoothed
flat areas into waxy mush and threw hard halos around every edge it could find.
Splitting detail by magnitude against a single blurred copy reproduces both at
once, and smudging the corners harder while sharpening them less stands in for
the lens going soft off-axis. The halo is lopsided on purpose: measured across the
reference files, the bright ring on the light side of an edge runs about 1.9× the
depth of the dark dip opposite it. Last, JPEG artefacts — 8×8 blocking and banding
concentrated in smooth gradients, because quantisation spends its bits on edges
and abandons flat areas. Skies were always the worst affected.

**Date stamp.** Optional, amber, bottom right — and deliberately not a
seven-segment display, which is what the camera's own LCD used and what faked
digicam photos almost always reach for. The imprint was drawn by the camera's
processor into the image itself, in a plain condensed sans about 3% of the frame
height. It goes on before the JPEG stage, so it picks up the same blocking as
everything around it; a stamp added afterwards stays suspiciously clean, which
along with being too large is the most common tell in a fake.

Every slider maps onto one of those stages, grouped in the panel accordingly.
**Filter strength** blends the whole result back against the untouched original,
so you can dial the effect down without losing its balance.

## About output quality

- **Dimensions are never changed.** The exported image has exactly the pixel
  dimensions of the file you loaded. Nothing is scaled, cropped, or resampled.
- **PNG export is lossless**, and this is the default. Decoding the exported PNG
  back and comparing it against the canvas gives zero differing bytes, so there
  are no compression artefacts and no generation loss.
- **JPEG export** is offered at quality 1.0 for a smaller file. It is still a
  lossy codec, so PNG is the better choice if you plan to edit further.
- A PNG will usually be *larger* than the JPEG you started with. That is
  expected: you are trading file size for the absence of compression loss, and
  the added grain and sharpening are genuinely hard to compress.

Three resolutions are in play while you work. A draft copy capped at 620px keeps
up with a slider while you drag it, a 1300px preview renders once the value
settles, and the download re-runs the identical pipeline on the untouched
full-resolution pixels.

Feature sizes — grain, blur radii, fringe width, JPEG blocks — are all expressed
relative to a 1600px long edge, which is the long edge of a 2 MP frame. That is
what keeps the three passes looking the same instead of the preview being a rough
approximation. It also means the effect is scale-invariant: a 24 MP photo gets the
same *look* as a 2 MP one rather than the same absolute pixel measurements, which
is what you want, since otherwise 8×8 JPEG blocks would be invisible on a large
file and obvious on a small one.

Note that "resolution loss" is relative for the same reason. A 24 MP export keeps
proportionally more absolute detail than a 2 MP one; it just looks equally soft
when viewed at the same size.

Because the whole pipeline runs on the main thread, the preview stays responsive
but large exports take a moment. On a laptop, a 2 MP photo renders in about 0.5s,
24 MP in about 4.5s, and 50 MP in about 25s. Sliders stay at roughly 15fps
regardless of source size, because dragging uses the draft copy. The overlay tells
you when it is working.

EXIF orientation is honoured on load, so photos shot in portrait on a phone come
in upright.

## Files

```
index.html             markup and layout
styles.css             dark UI, camera view, compare slider, controls
app.js                 filter pipeline, camera, canvas rendering, export
_test/make_sample.py   generates a synthetic test photo; not used by the app
_test/sample.jpg       handy image for trying the filter out
```

The pipeline lives in the top half of `app.js`, split into the four stages above
and assembled in `renderTo`. Most stages are standalone functions that mutate a
pixel buffer in place, so they can be reordered or swapped without touching the
UI; the exception is resolution loss, which resamples through the canvas itself.

The control panel is generated from the `CONTROLS` table at the top of the file,
so adding a slider means adding one row and reading one parameter. `SCENE`, just
below it, is the look every photo starts from.
