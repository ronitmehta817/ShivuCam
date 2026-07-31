'use strict';

/* ============================================================================
 * Shivucam - the look of an early-2000s point-and-shoot, applied in the browser.
 *
 * The pipeline follows the chain a real 2-3 MP CCD camera put an image through,
 * because the order is what makes the result read as authentic rather than as a
 * colour grade: light passes through a cheap lens, lands on a small sensor that
 * clips and smears, gets pushed through in-camera processing that over-sharpens
 * what it just smoothed, and is finally written out as a middling JPEG.
 *
 *   optical  ->  sensor sampling  ->  sensor response  ->  processing  ->  JPEG
 *
 * Feature sizes (grain, blur radii, JPEG blocks) are expressed relative to a
 * 1600px long edge, the long edge of a 2 MP frame. That keeps the look identical
 * across the three resolutions in play: a draft copy that keeps up with a slider
 * being dragged, a larger preview once the slider settles, and the untouched
 * full-resolution pixels on download.
 * ========================================================================== */

const PREVIEW_MAX_DIM = 1300;
const DRAFT_MAX_DIM = 620;

/**
 * The live viewfinder runs the full pipeline on every frame, so its resolution
 * is a frame-rate budget rather than a quality choice. Small is also honest: the
 * LCD on one of these cameras held about 110k pixels.
 */
const LIVE_MAX_DIM = 480;

/** Long edge of a 2 MP frame; the reference size all feature sizes scale from. */
const REFERENCE_LONG_EDGE = 1600;

/* ---------------------------------------------------------------------------
 * Controls. The panel is generated from this list; entries without a `key` are
 * group headings.
 * ------------------------------------------------------------------------- */

const CONTROLS = [
  { key: 'strength',   label: 'Filter strength',    min: 0,   max: 100, master: true },

  { group: 'Tone & colour' },
  { key: 'exposure',   label: 'Exposure',           min: -50, max: 50, signed: true },
  { key: 'contrast',   label: 'Contrast',           min: 0,   max: 100 },
  { key: 'saturation', label: 'Saturation',         min: 0,   max: 100 },
  { key: 'warmth',     label: 'White balance',      min: -50, max: 50, signed: true },
  { key: 'tint',       label: 'Green / magenta',    min: -50, max: 50, signed: true },

  { group: 'Lens & sensor' },
  { key: 'fringing',   label: 'Purple fringing',    min: 0,   max: 100 },
  { key: 'flash',      label: 'Flash falloff',      min: 0,   max: 100 },
  { key: 'vignette',   label: 'Vignette',           min: 0,   max: 100 },
  { key: 'clipping',   label: 'Highlight clipping', min: 0,   max: 100 },
  { key: 'bloom',      label: 'Highlight bloom',    min: 0,   max: 100 },
  { key: 'smear',      label: 'CCD smear',          min: 0,   max: 100 },
  { key: 'noise',      label: 'Sensor noise',       min: 0,   max: 100 },

  { group: 'In-camera processing' },
  { key: 'detail',     label: 'Resolution loss',    min: 0,   max: 100 },
  { key: 'smudge',     label: 'Noise reduction',    min: 0,   max: 100 },
  { key: 'sharpen',    label: 'Sharpening',         min: 0,   max: 100 },
  { key: 'jpeg',       label: 'JPEG artefacts',     min: 0,   max: 100 },
];

const PARAM_KEYS = CONTROLS.filter((c) => c.key).map((c) => c.key);

/**
 * The look, applied to every photo the moment it arrives. It is low light on a
 * 2.0MP CCD: the situation these sensors handled worst and the reason the era
 * looks the way it does. Values are anchored on measurements rather than taste
 * where a measurement exists — sharpening sits at the measured median halo
 * rather than the caricature a higher gain produces.
 *
 * The sliders start here and go wherever the user takes them; Reset comes back.
 */
const SCENE = {
  strength: 100, exposure: 16, contrast: 24, saturation: 14, warmth: -8, tint: -4,
  fringing: 22, flash: 0, vignette: 60, clipping: 40, bloom: 18, smear: 20, noise: 78,
  detail: 62, smudge: 70, sharpen: 44, jpeg: 55,
};

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */

const state = {
  mode: 'empty',  // 'empty' | 'camera' | 'editor'
  params: { ...SCENE },
  dateStamp: false,
  dateText: '',
  format: 'png',
  sourceName: 'image',
  sourceBytes: 0,
  full: null,     // { canvas, ctx, w, h } - pristine full-resolution pixels
  preview: null,  // pristine preview-scale pixels
  draft: null,    // pristine draft-scale pixels, for live slider dragging
  splitPct: 50,
  rendering: false,
  queued: null,   // 'draft' | 'preview' when a render arrives mid-render
};

/** Live viewfinder. The stream is released the moment it is not on screen. */
const camera = {
  stream: null,
  video: null,
  frame: 0,        // requestAnimationFrame handle
  live: null,      // downscaled layer the video frame is drawn into
  scratch: null,   // reused output canvas for the filtered frame
  deviceId: null,
  mirror: false,
  filtered: true,
  fps: 0,
  lastFrameAt: 0,
  readoutAt: 0,
};

const el = (id) => document.getElementById(id);

const ui = {
  fileInput: el('fileInput'),
  pickBtn: el('pickBtn'),
  cameraBtn: el('cameraBtn'),
  dzPickBtn: el('dzPickBtn'),
  dzCameraBtn: el('dzCameraBtn'),
  resetBtn: el('resetBtn'),
  downloadBtn: el('downloadBtn'),
  dropzone: el('dropzone'),
  viewer: el('viewer'),
  cameraView: el('cameraView'),
  camCanvas: el('camCanvas'),
  camFlash: el('camFlash'),
  camBusy: el('camBusy'),
  camBusyText: el('camBusyText'),
  camDevice: el('camDevice'),
  camMirror: el('camMirror'),
  camFiltered: el('camFiltered'),
  camReadout: el('camReadout'),
  shutterBtn: el('shutterBtn'),
  canvasWrap: el('canvasWrap'),
  preview: el('previewCanvas'),
  original: el('originalCanvas'),
  compareHandle: el('compareHandle'),
  compareToggle: el('compareToggle'),
  controls: el('controls'),
  dateStampToggle: el('dateStampToggle'),
  dateText: el('dateText'),
  formatSeg: el('formatSeg'),
  meta: el('meta'),
  busy: el('busy'),
  busyText: el('busyText'),
  toast: el('toast'),
};

const previewCtx = ui.preview.getContext('2d', { willReadFrequently: true });
const originalCtx = ui.original.getContext('2d');
const camCtx = ui.camCanvas.getContext('2d');

/* ===========================================================================
 * Stage 1 - optical: what the lens did before the light reached the sensor
 * ========================================================================= */

/**
 * Purple fringing, the giveaway of a cheap zoom lens on a small sensor. Two
 * things happen at once: the red and blue channels are resampled at slightly
 * different scales (true lateral chromatic aberration), and high-contrast edges
 * against bright backgrounds pick up a violet halo. Both grow toward the corners
 * because that is where the lens was worst.
 */
function purpleFringing(d, w, h, amount, scale) {
  const src = new Uint8ClampedArray(d);
  const n = w * h;
  const luma = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    luma[i] = src[p] * 0.2126 + src[p + 1] * 0.7152 + src[p + 2] * 0.0722;
  }

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxR = Math.hypot(cx, cy);
  const k = (amount * 2.2 * scale) / maxR;
  const violet = amount * 1.15;
  const step = Math.max(1, Math.round(scale));

  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const up = clamp(y - step, 0, h - 1) * w;
    const down = clamp(y + step, 0, h - 1) * w;
    const row = y * w;

    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const o = (row + x) * 4;

      // Lateral aberration: red focuses short, blue focuses long.
      d[o] = sampleBilinear(src, w, h, cx + dx * (1 - k), cy + dy * (1 - k), 0);
      d[o + 2] = sampleBilinear(src, w, h, cx + dx * (1 + k), cy + dy * (1 + k), 2);

      const left = luma[row + clamp(x - step, 0, w - 1)];
      const right = luma[row + clamp(x + step, 0, w - 1)];
      const above = luma[up + x];
      const below = luma[down + x];

      const gradient = Math.abs(right - left) + Math.abs(below - above);
      if (gradient < 20) continue;

      // The violet rim lands on the dark side of a bright edge - the branch, not
      // the sky behind it - which is why it reads as fringing rather than a tint.
      const bright = Math.max(left, right, above, below);
      const darkSide = Math.min(1, ((bright - luma[row + x]) / 255) * 2.4);
      if (darkSide <= 0) continue;

      // Worse toward the corners, but never absent in the middle.
      const radial = Math.hypot(dx, dy) / maxR;
      const weight =
        Math.min(1, gradient / 110) *
        Math.pow(bright / 255, 1.5) *
        darkSide *
        (0.35 + 0.65 * radial) *
        violet;

      d[o] += 112 * weight;
      d[o + 1] -= 70 * weight;
      d[o + 2] += 144 * weight;
    }
  }
}

/** Radial light falloff, with the mild centre hotspot a small on-body flash gave. */
function vignette(d, w, h, amount) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxSq = cx * cx + cy * cy;

  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const rn = Math.sqrt((dx * dx + dySq) / maxSq);
      const gain = (1 - amount * Math.pow(rn, 2.4)) * (1 + amount * 0.09 * (1 - rn * rn));
      const o = (y * w + x) * 4;
      d[o] *= gain;
      d[o + 1] *= gain;
      d[o + 2] *= gain;
    }
  }
}

/**
 * Flash falloff, which is a different thing from vignetting and the reason
 * built-in-flash photos are so recognisable. Vignetting is the lens dimming its
 * own corners by a fraction of a stop; this is the inverse-square law throwing
 * away most of the light before it reaches anything behind the subject.
 *
 * The reference frame measured about three stops from the lit subject out to the
 * frame edge, so at full strength the edges land near an eighth of centre. What
 * little light reaches them is room lighting rather than the flash tube, so the
 * falloff is tinted warm as it darkens - the cold-subject-against-warm-murk
 * split that gives away an on-camera flash.
 */
function flashFalloff(d, w, h, amount) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxSq = cx * cx + cy * cy;

  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const rSq = (dx * dx + dySq) / maxSq;
      const gain = 1 / (1 + amount * 7 * rSq);
      const ambient = amount * (1 - gain) * 0.5;

      const o = (y * w + x) * 4;
      d[o] *= gain * (1 + ambient * 0.34);
      d[o + 1] *= gain;
      d[o + 2] *= gain * (1 - ambient * 0.30);
    }
  }
}

/* ===========================================================================
 * Stage 2 - sensor sampling: there were only 2-3 million photosites
 * ========================================================================= */

/**
 * Throws away real detail by resampling down and back up, then leaves the frame
 * at its original dimensions. This is the single biggest reason a modern photo
 * does not pass as a Shivucam shot: no amount of grading fakes the absence of
 * detail, because a 2 MP sensor never recorded it in the first place.
 */
function limitResolution(ctx, canvas, w, h, ratio) {
  const sw = Math.max(1, Math.round(w * ratio));
  const sh = Math.max(1, Math.round(h * ratio));

  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, sw, sh);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(small, 0, 0, w, h);
}

/* ===========================================================================
 * Stage 3 - sensor response: white balance, a curve with nowhere to go at the
 * top, blooming, smear, and noise
 * ========================================================================= */

/**
 * White balance, tone curve and saturation, via per-channel lookup tables.
 *
 * The defining trait is the top end. These sensors had perhaps six stops of
 * range, so highlights did not roll off gracefully - they hit a wall and went
 * flat, featureless white, losing their colour on the way. `clipping` controls
 * where that wall sits and how abruptly it arrives.
 */
function colorGrade(d, p) {
  const exposure = 1 + (p.exposure / 100) * 0.75;
  const contrast = 1 + (p.contrast / 100) * 0.5;
  const sCurve = (p.contrast / 100) * 0.4;
  const saturation = 1 + (p.saturation / 100) * 1.05;
  const warmth = p.warmth / 100;
  const tint = p.tint / 100;
  const clip = p.clipping / 100;

  const knee = 0.95 - clip * 0.24;
  const hardness = 1 + clip * 7;
  const black = 0.014;

  // Warm-magenta highlights over slightly cyan shadows, plus the green cast a
  // failing auto white balance left on indoor shots.
  const gain = [
    1 + warmth * 0.20 + tint * 0.06,
    1 - tint * 0.12,
    1 - warmth * 0.24 + tint * 0.06,
  ];

  const lut = [
    new Uint8ClampedArray(256),
    new Uint8ClampedArray(256),
    new Uint8ClampedArray(256),
  ];

  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 256; i++) {
      let v = (i / 255) * exposure * gain[c];
      v = (v - 0.5) * contrast + 0.5;
      v += (smoothstep(v) - v) * sCurve;
      v = (v - black) / (1 - black);
      if (v > knee) v = knee + (1 - Math.exp(-(v - knee) * hardness)) * (1 - knee);
      lut[c][i] = v * 255;
    }
  }

  const [lr, lg, lb] = lut;
  for (let i = 0; i < d.length; i += 4) {
    const r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];

    // Vibrance-weighted saturation: already-vivid pixels get pushed less.
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const spread = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const amount = 1 + (saturation - 1) * (1 - spread * 0.55);
    let nr = y + (r - y) * amount;
    let ng = y + (g - y) * amount;
    let nb = y + (b - y) * amount;

    // Anything near the wall loses its colour and goes flat white.
    const blown = clip * smoothstep((y - 216) / 39) * 0.9;
    if (blown > 0) {
      nr += (255 - nr) * blown;
      ng += (255 - ng) * blown;
      nb += (255 - nb) * blown;
    }

    d[i] = nr;
    d[i + 1] = ng;
    d[i + 2] = nb;
  }
}

/** Veiling glare: blown highlights bleed a halo over their surroundings. */
function bloom(d, w, h, amount, radius) {
  const n = w * h;
  const highlights = new Float32Array(n * 3);
  const threshold = 168;

  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const p = i * 4;
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (y <= threshold) continue;
    const weight = (y - threshold) / (255 - threshold);
    highlights[o] = r * weight;
    highlights[o + 1] = g * weight;
    highlights[o + 2] = b * weight;
  }

  blurRGB(highlights, w, h, radius, 3);

  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const p = i * 4;
    for (let c = 0; c < 3; c++) {
      const base = d[p + c] / 255;
      const glow = Math.min(1, (highlights[o + c] / 255) * amount * 2.6);
      d[p + c] = (base + glow - base * glow) * 255;
    }
  }
}

/**
 * Vertical smear. An overloaded photosite leaked charge into the CCD's vertical
 * transfer register, and the register carried it the whole way out - so a bright
 * light drew a pale band running the full height of the frame, not a local glow.
 * Nothing in modern imaging does this, which is why it reads as period-correct.
 *
 * Calibrated against a sunny reference frame where a single specular glint on a
 * camera body - only 2.3% of that column blown - still drew a band 4px wide and
 * 22 luma levels above its neighbours, running edge to edge. So the threshold is
 * low: a column saturates the effect once a fiftieth of its height is blown, and
 * a small highlight is enough to draw a visible line.
 */
function ccdSmear(d, w, h, amount, scale) {
  const saturationPoint = h * 0.02;
  const strength = new Float32Array(w);

  for (let x = 0; x < w; x++) {
    let energy = 0;
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      const luma = d[o] * 0.2126 + d[o + 1] * 0.7152 + d[o + 2] * 0.0722;
      if (luma > 244) energy += (luma - 244) / 11;
    }
    strength[x] = Math.min(1, energy / saturationPoint) * amount;
  }

  // Only a column's excess over its neighbours is visible. Subtracting a wide
  // local average is what separates a compact specular glint, which overloads
  // one column and draws a band, from a broad blown highlight like a white shirt
  // or a bright sky, which loads every column equally and draws nothing. Without
  // this, any sunlit frame ends up ruled with stripes.
  const reach = Math.max(4, Math.round(w * 0.04));
  const span = reach * 2 + 1;
  let local = 0;
  for (let k = -reach; k <= reach; k++) local += strength[clamp(k, 0, w - 1)];
  const excess = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    excess[x] = Math.max(0, strength[x] - local / span);
    local += strength[clamp(x + reach + 1, 0, w - 1)] - strength[clamp(x - reach, 0, w - 1)];
  }
  strength.set(excess);

  // Soften the band's vertical edges; a hard step would give the trick away.
  const feather = Math.max(1, Math.round(3 * scale));
  const smoothed = new Float32Array(w);
  const win = feather * 2 + 1;
  let sum = 0;
  for (let k = -feather; k <= feather; k++) sum += strength[clamp(k, 0, w - 1)];
  for (let x = 0; x < w; x++) {
    smoothed[x] = sum / win;
    sum += strength[clamp(x + feather + 1, 0, w - 1)] - strength[clamp(x - feather, 0, w - 1)];
  }

  for (let x = 0; x < w; x++) {
    const s = smoothed[x];
    if (s < 0.004) continue;
    // The measured band is near-neutral with a faint magenta lean (green lifts
    // least), not the blue-white a leaking highlight might suggest. The gain is
    // set so the reference glint lands on its measured +22 luma at mid-slider,
    // after the feather above has spread the column's energy sideways.
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      d[o] += s * 70;
      d[o + 1] += s * 59;
      d[o + 2] += s * 65;
    }
  }
}

/**
 * Sensor noise, in the two forms these cameras produced: fine luminance grain,
 * and coarse blotches of wrong colour. The blotches matter more than the grain
 * for authenticity - they are what the noise reduction stage smears into
 * watercolour a moment later.
 *
 * Both are shaped by brightness, and both shapes are counter-intuitive enough
 * that they were measured off real ISO 800 Coolpix frames rather than guessed:
 *
 *  - Luma grain *rises* with brightness, because photon shot noise scales with
 *    the square root of the signal and dominates everything else. Grain being
 *    worst in the shadows is a film intuition, not a digital one. It only falls
 *    away right at the top, where clipped pixels have nothing left to vary.
 *  - Chroma blotching is U-shaped: worst in deep shadow where the colour signal
 *    is buried, but rising again in the last stop as channels clip unevenly and
 *    pull the hue around.
 */
function sensorNoise(d, w, h, sigma, scale) {
  const rand = mulberry32(0x9e3779b9);

  const fine = Math.max(1, Math.round(scale));
  for (let by = 0; by < h; by += fine) {
    for (let bx = 0; bx < w; bx += fine) {
      const level = (rand() + rand() + rand() - 1.5) * sigma;
      const x1 = Math.min(w, bx + fine);
      const y1 = Math.min(h, by + fine);
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const o = (y * w + x) * 4;
          const v = (d[o] + d[o + 1] + d[o + 2]) / 765;
          const clipped = clamp((v - 0.88) / 0.12, 0, 1);
          const shaped = level * (0.81 + 0.57 * v) * (1 - 0.85 * clipped * clipped);
          d[o] += shaped;
          d[o + 1] += shaped;
          d[o + 2] += shaped;
        }
      }
    }
  }

  const blob = Math.max(2, Math.round(scale * 9));
  const chroma = sigma * 0.34;
  for (let by = 0; by < h; by += blob) {
    for (let bx = 0; bx < w; bx += blob) {
      const cr = (rand() - 0.5) * chroma;
      const cb = (rand() - 0.5) * chroma;
      const x1 = Math.min(w, bx + blob);
      const y1 = Math.min(h, by + blob);
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const o = (y * w + x) * 4;
          const v = (d[o] + d[o + 1] + d[o + 2]) / 765;
          const dark = 1 - v;
          const shaped = 0.95 + dark * dark + 2.4 * Math.pow(v, 6);
          d[o] += cr * shaped;
          d[o + 1] -= (cr + cb) * shaped * 0.45;
          d[o + 2] += cb * shaped;
        }
      }
    }
  }
}

/* ===========================================================================
 * Stage 4 - in-camera processing: smooth it, then sharpen it, then compress it
 * ========================================================================= */

/**
 * Chroma subsampling. Colour was recorded and stored at a fraction of the
 * luminance resolution, so it bleeds across edges in blocks. This is also what
 * turns the shadow colour noise into soft blotches.
 */
function chromaSubsample(d, w, h, cell, mix) {
  for (let by = 0; by < h; by += cell) {
    const y1 = Math.min(h, by + cell);
    for (let bx = 0; bx < w; bx += cell) {
      const x1 = Math.min(w, bx + cell);

      let sumCb = 0, sumCr = 0, count = 0;
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const o = (y * w + x) * 4;
          const luma = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
          sumCb += d[o + 2] - luma;
          sumCr += d[o] - luma;
          count++;
        }
      }
      const meanCb = sumCb / count;
      const meanCr = sumCr / count;

      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const o = (y * w + x) * 4;
          const luma = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
          const cb = (d[o + 2] - luma) + (meanCb - (d[o + 2] - luma)) * mix;
          const cr = (d[o] - luma) + (meanCr - (d[o] - luma)) * mix;
          d[o] = luma + cr;
          d[o + 1] = luma - (0.299 * cr + 0.114 * cb) / 0.587;
          d[o + 2] = luma + cb;
        }
      }
    }
  }
}

/**
 * Noise reduction and sharpening in a single pass, which is how they behaved in
 * practice: the same processor smoothed flat areas into waxy mush and then threw
 * hard halos around every edge it could find. Splitting detail by magnitude
 * against one blurred copy reproduces both from a single blur.
 *
 * Corners are smudged harder and sharpened less, standing in for the lens going
 * soft away from the centre.
 *
 * The halo is deliberately lopsided. Measured across the reference files, the
 * bright ring on the light side of an edge runs about 1.9x the depth of the dark
 * dip on the other side (median 13.8% against 7.3% of the step height), so the
 * dark side is held back rather than mirrored.
 */
function shapeDetail(d, w, h, sharpen, smudge, radius) {
  const n = w * h;
  const blurred = new Float32Array(n * 3);
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const p = i * 4;
    blurred[o] = d[p];
    blurred[o + 1] = d[p + 1];
    blurred[o + 2] = d[p + 2];
  }

  blurRGB(blurred, w, h, radius, 2);

  const knee = 11;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxSq = cx * cx + cy * cy;

  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const rSq = (dx * dx + dySq) / maxSq;
      const soften = smudge * (1 + rSq * 0.9);
      const crisp = sharpen * (1 - rSq * 0.55);

      const p = (y * w + x) * 4;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const base = blurred[o + c];
        const detail = d[p + c] - base;
        const mag = Math.abs(detail);
        // 0 in flat texture, 1 on a real edge.
        const edge = mag >= knee ? 1 : smoothstep(mag / knee);
        const lopsided = detail > 0 ? 1 : 0.62;
        const factor = Math.max(0, 1 + crisp * lopsided * edge - soften * (1 - edge));
        // A safety rail only. Kept clear of the halo the gain above produces on
        // a full-range edge, so that clamping never becomes what shapes it.
        d[p + c] = base + clamp(detail * factor, -96, 96);
      }
    }
  }
}

/**
 * JPEG artefacts. In-camera encoders ran a fixed, unambitious quality setting,
 * and it showed up as 8x8 blocking and banding in smooth gradients - skies were
 * the worst affected. Detailed blocks are largely left alone, which is what real
 * quantisation does: it spends its bits on edges and abandons flat areas.
 */
function jpegArtefacts(d, w, h, amount, block) {
  const dcStep = 2 + amount * 11;
  const acLoss = amount * 0.8;

  for (let by = 0; by < h; by += block) {
    const y1 = Math.min(h, by + block);
    for (let bx = 0; bx < w; bx += block) {
      const x1 = Math.min(w, bx + block);

      let sr = 0, sg = 0, sb = 0, sy = 0, syy = 0, count = 0;
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const o = (y * w + x) * 4;
          const luma = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
          sr += d[o]; sg += d[o + 1]; sb += d[o + 2];
          sy += luma; syy += luma * luma;
          count++;
        }
      }

      const meanY = sy / count;
      const variance = Math.max(0, syy / count - meanY * meanY);
      const flat = 1 - Math.min(1, Math.sqrt(variance) / 13);
      if (flat < 0.02) continue;

      const means = [sr / count, sg / count, sb / count];
      const keep = 1 - acLoss * flat;

      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const o = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const mean = means[c];
            const quantised = Math.round(mean / dcStep) * dcStep;
            const dc = mean + (quantised - mean) * flat;
            d[o + c] = dc + (d[o + c] - mean) * keep;
          }
        }
      }
    }
  }
}

/* ===========================================================================
 * Shared helpers
 * ========================================================================= */

function sampleBilinear(src, w, h, x, y, c) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const row0 = y0 * w, row1 = y1 * w;
  const a = src[(row0 + x0) * 4 + c], b = src[(row0 + x1) * 4 + c];
  const e = src[(row1 + x0) * 4 + c], f = src[(row1 + x1) * 4 + c];
  const top = a + (b - a) * fx;
  const bottom = e + (f - e) * fx;
  return top + (bottom - top) * fy;
}

/** Three box-blur passes approximate a gaussian at a fraction of the cost. */
function blurRGB(buf, w, h, radius, passes) {
  const tmp = new Float32Array(buf.length);
  for (let i = 0; i < passes; i++) {
    boxBlurH(buf, tmp, w, h, radius);
    boxBlurV(tmp, buf, w, h, radius);
  }
}

function boxBlurH(src, dst, w, h, r) {
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 3;
    let s0 = 0, s1 = 0, s2 = 0;
    for (let k = -r; k <= r; k++) {
      const o = row + clamp(k, 0, w - 1) * 3;
      s0 += src[o]; s1 += src[o + 1]; s2 += src[o + 2];
    }
    for (let x = 0; x < w; x++) {
      const o = row + x * 3;
      dst[o] = s0 / win; dst[o + 1] = s1 / win; dst[o + 2] = s2 / win;
      const out = row + clamp(x - r, 0, w - 1) * 3;
      const inc = row + clamp(x + r + 1, 0, w - 1) * 3;
      s0 += src[inc] - src[out];
      s1 += src[inc + 1] - src[out + 1];
      s2 += src[inc + 2] - src[out + 2];
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const win = r * 2 + 1;
  for (let x = 0; x < w; x++) {
    let s0 = 0, s1 = 0, s2 = 0;
    for (let k = -r; k <= r; k++) {
      const o = (clamp(k, 0, h - 1) * w + x) * 3;
      s0 += src[o]; s1 += src[o + 1]; s2 += src[o + 2];
    }
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 3;
      dst[o] = s0 / win; dst[o + 1] = s1 / win; dst[o + 2] = s2 / win;
      const out = (clamp(y - r, 0, h - 1) * w + x) * 3;
      const inc = (clamp(y + r + 1, 0, h - 1) * w + x) * 3;
      s0 += src[inc] - src[out];
      s1 += src[inc + 1] - src[out + 1];
      s2 += src[inc + 2] - src[out + 2];
    }
  }
}

function blend(d, pristine, t) {
  for (let i = 0; i < d.length; i += 4) {
    d[i]     = pristine[i]     + (d[i]     - pristine[i])     * t;
    d[i + 1] = pristine[i + 1] + (d[i + 1] - pristine[i + 1]) * t;
    d[i + 2] = pristine[i + 2] + (d[i + 2] - pristine[i + 2]) * t;
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Retro OSD date stamp — matches cheap early-2000s digicams / the reference
 * frame: bottom-left, white monospace, thin black outline, YYYY/MM/DD HH:MM:SS.
 *
 * Kept small. A large crisp stamp is the usual tell of a fake Shivucam look.
 */
function drawDateStamp(ctx, w, h, text) {
  const short = Math.min(w, h);
  const size = Math.max(10, Math.round(short * 0.028));
  const marginX = Math.round(short * 0.035);
  const marginY = Math.round(short * 0.038);
  const x = marginX;
  const y = h - marginY;

  ctx.save();
  ctx.font =
    `600 ${size}px "IBM Plex Mono", "SF Mono", "Menlo", ` +
    `"Consolas", ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.imageSmoothingEnabled = false;

  // Opaque dark outline (pixel-edge style), then flat white fill — no amber glow.
  const outline = Math.max(1.25, size * 0.14);
  ctx.lineWidth = outline;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.82)';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeText(text, x, y);

  // Slight second pass offset for that chunky OSD edge.
  ctx.lineWidth = Math.max(1, outline * 0.55);
  ctx.strokeText(text, x + 0.6, y + 0.6);

  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

/* ===========================================================================
 * Rendering
 * ========================================================================= */

/**
 * Runs a pristine layer through the whole camera chain onto a canvas.
 * Dimensions never change, so the strength blend at the end can compare against
 * the pixels we started with.
 *
 * Pass `target` to reuse a canvas instead of allocating one; the live viewfinder
 * does this so it is not churning a canvas every frame.
 */
function renderTo(layer, p, target) {
  const w = layer.w;
  const h = layer.h;
  const out = target || document.createElement('canvas');
  if (out.width !== w) out.width = w;
  if (out.height !== h) out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(layer.canvas, 0, 0);

  if (p.strength > 0) {
    const scale = Math.max(w, h) / REFERENCE_LONG_EDGE;
    const pristine =
      p.strength < 100 ? ctx.getImageData(0, 0, w, h).data.slice() : null;

    let img = ctx.getImageData(0, 0, w, h);
    if (p.fringing > 0) purpleFringing(img.data, w, h, p.fringing / 100, scale);
    if (p.flash > 0) flashFalloff(img.data, w, h, p.flash / 100);
    if (p.vignette > 0) vignette(img.data, w, h, (p.vignette / 100) * 0.9);
    ctx.putImageData(img, 0, 0);

    if (p.detail > 0) {
      limitResolution(ctx, out, w, h, 1 - (p.detail / 100) * 0.6);
    }

    img = ctx.getImageData(0, 0, w, h);
    let d = img.data;

    colorGrade(d, p);
    if (p.bloom > 0) {
      bloom(d, w, h, (p.bloom / 100) * 0.62, Math.max(2, Math.round(22 * scale)));
    }
    if (p.smear > 0) ccdSmear(d, w, h, p.smear / 100, scale);
    if (p.noise > 0) sensorNoise(d, w, h, (p.noise / 100) * 26, scale);

    if (p.smudge > 0) {
      chromaSubsample(d, w, h, Math.max(2, Math.round(2.5 * scale)), (p.smudge / 100) * 0.9);
    }
    if (p.sharpen > 0 || p.smudge > 0) {
      shapeDetail(
        d, w, h,
        // Ceiling of 0.7 puts a slider at 60 on the measured median halo and a
        // slider at 100 at the worst file in the set; 1.6 sailed past both.
        (p.sharpen / 100) * 0.7,
        (p.smudge / 100) * 0.85,
        Math.max(1, Math.round(1.4 * scale)),
      );
    }
    // The camera imprinted the date at the end of its own processing and then
    // encoded the result, so the stamp has to go on before compression if it is
    // to pick up the same blocking as everything around it. A stamp added after
    // the fact stays suspiciously clean.
    if (state.dateStamp) {
      ctx.putImageData(img, 0, 0);
      drawDateStamp(ctx, w, h, stampText());
      img = ctx.getImageData(0, 0, w, h);
      d = img.data;
    }

    if (p.jpeg > 0) {
      jpegArtefacts(d, w, h, p.jpeg / 100, Math.max(3, Math.round(8 * scale)));
    }

    if (pristine) blend(d, pristine, p.strength / 100);
    ctx.putImageData(img, 0, 0);
  } else if (state.dateStamp) {
    drawDateStamp(ctx, w, h, stampText());
  }

  return out;
}

/**
 * Schedules a repaint of the preview canvas. A `draft` pass trades resolution
 * for latency while a control is being dragged; the `preview` pass runs once the
 * value settles. A pending draft is superseded by a newer request rather than
 * queued behind it, so dragging never builds a backlog.
 */
function requestPreview(quality = 'preview') {
  // The viewfinder repaints itself every frame, so it needs nothing from here.
  if (state.mode !== 'editor' || !state.preview) return;

  if (state.rendering) {
    if (quality === 'preview' || state.queued !== 'preview') state.queued = quality;
    return;
  }

  state.rendering = true;
  requestAnimationFrame(() => {
    try {
      const layer = quality === 'draft' ? state.draft : state.preview;
      const out = renderTo(layer, state.params);
      const { w, h } = state.preview;
      if (ui.preview.width !== w) ui.preview.width = w;
      if (ui.preview.height !== h) ui.preview.height = h;
      previewCtx.clearRect(0, 0, w, h);
      previewCtx.drawImage(out, 0, 0, w, h);
    } catch (err) {
      showToast('Could not render the preview.', true);
      console.error(err);
    } finally {
      state.rendering = false;
      const next = state.queued;
      state.queued = null;
      if (next) requestPreview(next);
    }
  });
}

/* ===========================================================================
 * Loading an image
 * ========================================================================= */

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('That file is not an image.', true);
    return;
  }

  stopCamera();
  setMode(state.full ? 'editor' : 'empty');
  setBusy(true, 'Loading image\u2026');
  try {
    const bitmap = await decode(file);
    const w = bitmap.width;
    const h = bitmap.height;

    state.full = makeLayer(w, h);
    state.full.ctx.drawImage(bitmap, 0, 0, w, h);

    state.preview = scaledLayer(bitmap, w, h, PREVIEW_MAX_DIM);
    state.draft = scaledLayer(bitmap, w, h, DRAFT_MAX_DIM);
    const { w: pw, h: ph } = state.preview;

    if (bitmap.close) bitmap.close();

    state.sourceName = file.name ? file.name.replace(/\.[^.]+$/, '') : 'image';
    state.sourceBytes = file.size || 0;

    ui.preview.width = pw;
    ui.preview.height = ph;
    ui.original.width = pw;
    ui.original.height = ph;
    originalCtx.drawImage(state.preview.canvas, 0, 0);

    setMode('editor');
    setSplit(50);
    updateMeta();
    pulseDevelop();
    requestPreview();
  } catch (err) {
    showToast('Could not read that image.', true);
    console.error(err);
  } finally {
    setBusy(false);
  }
}

/** Prefers createImageBitmap so EXIF rotation is honoured. */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* fall through to the element decoder below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function makeLayer(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), w, h };
}

/** A copy of `source` fitted inside `maxDim`, never upscaled. */
function scaledLayer(source, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const layer = makeLayer(
    Math.max(1, Math.round(w * scale)),
    Math.max(1, Math.round(h * scale)),
  );
  layer.ctx.imageSmoothingQuality = 'high';
  layer.ctx.drawImage(source, 0, 0, layer.w, layer.h);
  return layer;
}

/* ===========================================================================
 * Camera
 * ========================================================================= */

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('This browser cannot open a camera.', true);
    return;
  }

  setMode('camera');
  setCamBusy(true, 'Starting camera\u2026');
  ui.shutterBtn.disabled = true;
  stopStream();

  // 4:3 at around 2 MP is what these cameras actually shot; browsers treat this
  // as a hint and hand back whatever the hardware can do.
  const video = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: 'environment' };
  Object.assign(video, {
    width: { ideal: 1600 },
    height: { ideal: 1200 },
    aspectRatio: { ideal: 4 / 3 },
  });

  try {
    camera.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    setCamBusy(false);
    showToast(cameraError(err), true);
    setMode(state.full ? 'editor' : 'empty');
    return;
  }

  camera.deviceId = deviceId || null;

  if (!camera.video) {
    camera.video = document.createElement('video');
    camera.video.playsInline = true;
    camera.video.muted = true;
  }
  camera.video.srcObject = camera.stream;

  try {
    await camera.video.play();
    await waitForVideoSize(camera.video);
  } catch (err) {
    setCamBusy(false);
    showToast('The camera stream would not start.', true);
    console.error(err);
    stopStream();
    return;
  }

  const vw = camera.video.videoWidth;
  const vh = camera.video.videoHeight;
  const scale = Math.min(1, LIVE_MAX_DIM / Math.max(vw, vh));
  const lw = Math.max(1, Math.round(vw * scale));
  const lh = Math.max(1, Math.round(vh * scale));

  camera.live = makeLayer(lw, lh);
  camera.scratch = document.createElement('canvas');
  ui.camCanvas.width = lw;
  ui.camCanvas.height = lh;

  // A front-facing camera is a mirror; anything else is not.
  const facing = camera.stream.getVideoTracks()[0]?.getSettings?.().facingMode;
  if (facing === 'user') {
    camera.mirror = true;
    ui.camMirror.checked = true;
  }

  await populateCameraDevices();

  setCamBusy(false);
  ui.shutterBtn.disabled = false;
  camera.lastFrameAt = 0;
  camera.fps = 0;
  updateCamReadout();
  cameraLoop();
}

function cameraLoop() {
  if (state.mode !== 'camera' || !camera.stream) return;
  camera.frame = requestAnimationFrame(cameraLoop);

  const video = camera.video;
  if (!video || video.readyState < 2) return;

  const live = camera.live;
  live.ctx.save();
  if (camera.mirror) {
    live.ctx.translate(live.w, 0);
    live.ctx.scale(-1, 1);
  }
  live.ctx.drawImage(video, 0, 0, live.w, live.h);
  live.ctx.restore();

  const out = camera.filtered
    ? renderTo(live, state.params, camera.scratch)
    : live.canvas;
  camCtx.drawImage(out, 0, 0);

  const now = performance.now();
  if (camera.lastFrameAt) {
    const instant = 1000 / Math.max(1, now - camera.lastFrameAt);
    camera.fps = camera.fps ? camera.fps * 0.9 + instant * 0.1 : instant;
  }
  camera.lastFrameAt = now;
  if (!camera.readoutAt || now - camera.readoutAt > 500) {
    camera.readoutAt = now;
    updateCamReadout();
  }
}

/** Grabs the current frame at the sensor's full resolution and opens it. */
function capture() {
  const video = camera.video;
  if (!video || video.readyState < 2) return;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  ui.camFlash.classList.remove('is-firing');
  // Reading offsetWidth restarts the animation.
  void ui.camFlash.offsetWidth;
  ui.camFlash.classList.add('is-firing');
  ui.shutterBtn.classList.remove('is-firing');
  void ui.shutterBtn.offsetWidth;
  ui.shutterBtn.classList.add('is-firing');

  const shot = makeLayer(w, h);
  shot.ctx.save();
  if (camera.mirror) {
    shot.ctx.translate(w, 0);
    shot.ctx.scale(-1, 1);
  }
  shot.ctx.drawImage(video, 0, 0, w, h);
  shot.ctx.restore();

  stopCamera();

  state.full = shot;
  state.preview = scaledLayer(shot.canvas, w, h, PREVIEW_MAX_DIM);
  state.draft = scaledLayer(shot.canvas, w, h, DRAFT_MAX_DIM);
  state.sourceName = `photo-${stampSlug()}`;
  state.sourceBytes = 0;

  const { w: pw, h: ph } = state.preview;
  ui.preview.width = pw;
  ui.preview.height = ph;
  ui.original.width = pw;
  ui.original.height = ph;
  originalCtx.drawImage(state.preview.canvas, 0, 0);

  setMode('editor');
  setSplit(50);
  updateMeta();
  pulseDevelop();
  requestPreview();
}

function stopCamera() {
  cancelAnimationFrame(camera.frame);
  camera.frame = 0;
  stopStream();
}

function stopStream() {
  if (camera.stream) {
    for (const track of camera.stream.getTracks()) track.stop();
    camera.stream = null;
  }
  if (camera.video) camera.video.srcObject = null;
}

/** Only labels cameras once permission is granted; before that they are blank. */
async function populateCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'videoinput');
  } catch (_) {
    return;
  }

  ui.camDevice.hidden = devices.length < 2;
  if (devices.length < 2) return;

  const active = camera.stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
  ui.camDevice.textContent = '';
  devices.forEach((device, i) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${i + 1}`;
    option.selected = device.deviceId === active;
    ui.camDevice.appendChild(option);
  });
}

function updateCamReadout() {
  if (state.mode !== 'camera') return;
  const video = camera.video;
  if (!video?.videoWidth) { ui.camReadout.textContent = ''; return; }
  const mp = ((video.videoWidth * video.videoHeight) / 1e6).toFixed(1);
  const fps = camera.fps ? ` \u00b7 viewfinder ${Math.round(camera.fps)} fps` : '';
  ui.camReadout.textContent =
    `capture ${video.videoWidth}\u00d7${video.videoHeight} \u00b7 ${mp} MP${fps}`;
}

function setCamBusy(on, text) {
  if (text) ui.camBusyText.textContent = text;
  ui.camBusy.classList.toggle('is-on', on);
}

function cameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return window.isSecureContext
        ? 'Camera access was blocked. Allow it in your browser settings.'
        : 'Cameras need a secure page. Serve the folder over http://localhost.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera found on this device.';
    case 'NotReadableError':
      return 'The camera is already in use by another app.';
    default:
      console.error(err);
      return 'Could not open the camera.';
  }
}

function waitForVideoSize(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('video timed out')), 6000);
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

const stampSlug = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

/* ===========================================================================
 * Export
 * ========================================================================= */

async function download() {
  if (!state.full) return;
  const { w, h } = state.full;

  const heavy = w * h > 10e6 ? ', this may take a while' : '';
  ui.downloadBtn.disabled = true;
  setBusy(true, `Rendering ${w}\u00d7${h}${heavy}\u2026`);
  await nextFrame();

  try {
    const out = renderTo(state.full, state.params);
    const isPng = state.format === 'png';
    const blob = await toBlob(out, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 1);
    if (!blob) throw new Error('encode failed');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.sourceName}-shivucam.${isPng ? 'png' : 'jpg'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    showToast(`Saved ${w}\u00d7${h} \u00b7 ${formatBytes(blob.size)}`);
    if (!prefersReducedMotion()) {
      ui.downloadBtn.classList.remove('is-saved');
      void ui.downloadBtn.offsetWidth;
      ui.downloadBtn.classList.add('is-saved');
      ui.downloadBtn.addEventListener(
        'animationend',
        () => ui.downloadBtn.classList.remove('is-saved'),
        { once: true },
      );
    }
  } catch (err) {
    showToast('Export failed. Try JPEG, or a smaller image.', true);
    console.error(err);
  } finally {
    setBusy(false);
    ui.downloadBtn.disabled = false;
  }
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/* ===========================================================================
 * UI wiring
 * ========================================================================= */

function buildControls() {
  const frag = document.createDocumentFragment();

  for (const cfg of CONTROLS) {
    if (cfg.group) {
      const heading = document.createElement('h3');
      heading.className = 'ctrl-group';
      heading.textContent = cfg.group;
      frag.appendChild(heading);
      continue;
    }

    const wrap = document.createElement('div');
    wrap.className = cfg.master ? 'ctrl is-master' : 'ctrl';

    const row = document.createElement('div');
    row.className = 'ctrl-row';

    const label = document.createElement('label');
    label.className = 'ctrl-label';
    label.textContent = cfg.label;
    label.htmlFor = `ctrl-${cfg.key}`;

    const value = document.createElement('span');
    value.className = 'ctrl-value';

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `ctrl-${cfg.key}`;
    input.min = String(cfg.min);
    input.max = String(cfg.max);
    input.step = '1';
    input.value = String(state.params[cfg.key]);

    const sync = () => {
      const v = Number(input.value);
      value.textContent = cfg.signed && v > 0 ? `+${v}` : String(v);
      // Feeds the filled part of the slider groove.
      input.style.setProperty('--v', `${((v - cfg.min) / (cfg.max - cfg.min)) * 100}%`);
    };

    input.addEventListener('input', () => {
      state.params[cfg.key] = Number(input.value);
      sync();
      requestPreview('draft');
    });

    // Fires when the value settles, so the sharp pass runs only once.
    input.addEventListener('change', () => requestPreview('preview'));

    sync();
    row.append(label, value);
    wrap.append(row, input);
    frag.appendChild(wrap);
  }

  ui.controls.appendChild(frag);
}

function applyScene() {
  state.params = { ...SCENE };
  syncControls();
  requestPreview();
}

function syncControls() {
  for (const key of PARAM_KEYS) {
    const input = el(`ctrl-${key}`);
    if (!input) continue;
    const cfg = CONTROLS.find((c) => c.key === key);
    const v = state.params[key];
    input.value = String(v);
    input.style.setProperty('--v', `${((v - cfg.min) / (cfg.max - cfg.min)) * 100}%`);
    input.parentElement.querySelector('.ctrl-value').textContent =
      cfg.signed && v > 0 ? `+${v}` : String(v);
  }
}

function stampText() {
  const custom = state.dateText.trim();
  if (custom) return custom;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Swaps which of the three stage views is on screen and retitles the actions. */
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  ui.dropzone.classList.toggle('is-active', mode === 'empty');
  ui.viewer.classList.toggle('is-active', mode === 'editor');
  ui.cameraView.classList.toggle('is-active', mode === 'camera');

  ui.downloadBtn.disabled = mode !== 'editor';
  // Adjustments apply to the viewfinder too, so resetting them is useful there.
  ui.resetBtn.disabled = mode === 'empty';
  const camFull = ui.cameraBtn.querySelector('.label-full');
  const camShort = ui.cameraBtn.querySelector('.label-short');
  if (mode === 'camera') {
    if (camFull) camFull.textContent = 'Close camera';
    if (camShort) camShort.textContent = 'Close';
  } else {
    if (camFull) camFull.textContent = 'Use camera';
    if (camShort) camShort.textContent = 'Camera';
  }
  if (mode !== 'camera') ui.camReadout.textContent = '';
}

function pulseDevelop() {
  if (prefersReducedMotion()) return;
  ui.canvasWrap.classList.remove('is-developing');
  void ui.canvasWrap.offsetWidth;
  ui.canvasWrap.classList.add('is-developing');
  const done = () => ui.canvasWrap.classList.remove('is-developing');
  ui.canvasWrap.addEventListener('animationend', done, { once: true });
}

function setSplit(pct) {
  state.splitPct = clamp(pct, 0, 100);
  ui.canvasWrap.style.setProperty('--split', `${state.splitPct}%`);
}

function updateMeta() {
  if (!state.full) { ui.meta.textContent = ''; return; }
  const { w, h } = state.full;
  const mp = ((w * h) / 1e6).toFixed(1);
  const src = state.sourceBytes ? ` \u00b7 source ${formatBytes(state.sourceBytes)}` : '';
  const scaled = state.preview.w < w ? ' \u00b7 preview downscaled, export is full size' : '';
  ui.meta.innerHTML = `<strong>${w} \u00d7 ${h}</strong> \u00b7 ${mp} MP${src}${scaled}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function setBusy(on, text) {
  if (text) ui.busyText.textContent = text;
  ui.busy.classList.toggle('is-on', on);
}

let toastTimer = null;
function showToast(msg, isError = false) {
  ui.toast.textContent = msg;
  ui.toast.classList.toggle('is-error', isError);
  ui.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), 3200);
}

/* --- events -------------------------------------------------------------- */

function wireEvents() {
  ui.pickBtn.addEventListener('click', () => ui.fileInput.click());
  ui.dropzone.addEventListener('click', () => ui.fileInput.click());
  ui.dzPickBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.fileInput.click();
  });

  wireCamera();

  ui.fileInput.addEventListener('change', () => {
    loadFile(ui.fileInput.files[0]);
    ui.fileInput.value = '';
  });

  for (const evt of ['dragenter', 'dragover']) {
    document.addEventListener(evt, (e) => {
      e.preventDefault();
      ui.dropzone.classList.add('is-over');
    });
  }
  for (const evt of ['dragleave', 'dragend']) {
    document.addEventListener(evt, () => ui.dropzone.classList.remove('is-over'));
  }
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    ui.dropzone.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  document.addEventListener('paste', (e) => {
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        loadFile(item.getAsFile());
        return;
      }
    }
  });

  ui.downloadBtn.addEventListener('click', download);

  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'camera' || e.repeat) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if (e.target.closest('input, select, textarea, button')) return;
      e.preventDefault();
      capture();
    } else if (e.key === 'Escape') {
      stopCamera();
      setMode(state.full ? 'editor' : 'empty');
    }
  });

  ui.resetBtn.addEventListener('click', () => {
    ui.dateStampToggle.checked = false;
    state.dateStamp = false;
    ui.dateText.value = '';
    state.dateText = '';
    ui.dateText.disabled = true;
    setSplit(50);
    applyScene();
  });

  ui.compareToggle.addEventListener('change', () => {
    ui.canvasWrap.classList.toggle('no-compare', !ui.compareToggle.checked);
  });

  ui.dateStampToggle.addEventListener('change', () => {
    state.dateStamp = ui.dateStampToggle.checked;
    ui.dateText.disabled = !state.dateStamp;
    requestPreview();
  });

  ui.dateText.addEventListener('input', () => {
    state.dateText = ui.dateText.value;
    if (state.dateStamp) requestPreview();
  });

  ui.formatSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.format = btn.dataset.format;
    for (const b of ui.formatSeg.children) {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-pressed', String(b === btn));
    }
  });

  wireCompareDrag();
}

function wireCamera() {
  const toggleCamera = () => {
    if (state.mode === 'camera') {
      stopCamera();
      setMode(state.full ? 'editor' : 'empty');
    } else {
      startCamera(camera.deviceId);
    }
  };

  ui.cameraBtn.addEventListener('click', toggleCamera);

  // The action dock is hidden in camera mode, so the viewfinder carries its own exit.
  el('camCloseBtn')?.addEventListener('click', toggleCamera);

  ui.dzCameraBtn.addEventListener('click', (e) => {
    // The dropzone behind this button opens the file picker.
    e.stopPropagation();
    startCamera();
  });

  ui.shutterBtn.addEventListener('click', capture);

  ui.camMirror.addEventListener('change', () => {
    camera.mirror = ui.camMirror.checked;
  });

  ui.camFiltered.addEventListener('change', () => {
    camera.filtered = ui.camFiltered.checked;
  });

  ui.camDevice.addEventListener('change', () => {
    startCamera(ui.camDevice.value);
  });

  // Never keep a camera open in a tab the user has left.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.mode === 'camera') {
      stopCamera();
      setMode(state.full ? 'editor' : 'empty');
      showToast('Camera closed while the tab was hidden.');
    }
  });

  window.addEventListener('pagehide', stopCamera);
}

function wireCompareDrag() {
  let dragging = false;

  const moveTo = (clientX) => {
    const rect = ui.preview.getBoundingClientRect();
    if (!rect.width) return;
    setSplit(((clientX - rect.left) / rect.width) * 100);
  };

  const start = (e) => {
    if (!state.full || !ui.compareToggle.checked) return;
    dragging = true;
    ui.canvasWrap.setPointerCapture?.(e.pointerId);
    moveTo(e.clientX);
    e.preventDefault();
  };

  ui.canvasWrap.addEventListener('pointerdown', start);
  ui.canvasWrap.addEventListener('pointermove', (e) => { if (dragging) moveTo(e.clientX); });
  ui.canvasWrap.addEventListener('pointerup', () => { dragging = false; });
  ui.canvasWrap.addEventListener('pointercancel', () => { dragging = false; });
}

/* --- boot ---------------------------------------------------------------- */

buildControls();
wireEvents();
ui.dateText.disabled = true;
ui.camDevice.hidden = true;

/* On phones, collapse secondary folds so the image stays above the fold. */
(() => {
  const narrow = window.matchMedia('(max-width: 900px)');
  const apply = () => {
    for (const id of ['foldDate', 'foldExport']) {
      const node = el(id);
      if (node) node.open = !narrow.matches;
    }
  };
  apply();
  narrow.addEventListener?.('change', apply);
})();
setMode('empty');

/* --- welcome screen ------------------------------------------------------- */

/**
 * Every load starts with the camera in standby. Powering on closes an iris over
 * the welcome screen and hands off to the filter screen underneath. Clicking the
 * wordmark returns to standby.
 */
(() => {
  const boot = el('boot');
  const powerBtn = el('powerBtn');
  if (!boot) return;

  const behind = [document.querySelector('.topbar'), document.querySelector('.layout')]
    .filter(Boolean);
  const setBehindInert = (on) => {
    for (const node of behind) node.inert = on;
  };

  const IRIS_MS = 560;
  let finishTimer = 0;

  function finish() {
    clearTimeout(finishTimer);
    finishTimer = 0;
    boot.classList.add('hidden');
    boot.classList.remove('is-leaving');
    document.body.classList.remove('is-booted');
  }

  function powerOn(instant = false) {
    if (boot.dataset.state === 'off') return;
    boot.dataset.state = 'off';
    document.body.classList.remove('is-booting');
    setBehindInert(false);

    if (instant || prefersReducedMotion()) {
      finish();
      return;
    }

    document.body.classList.add('is-booted');
    boot.classList.add('is-leaving');
    // Backstop: a backgrounded tab freezes the animation clock, so animationend
    // may never arrive and would leave the overlay mounted for good.
    finishTimer = setTimeout(finish, IRIS_MS + 120);
  }

  // Only the iris counts — the entrance and sweep animations also bubble here.
  boot.addEventListener('animationend', (e) => {
    if (e.target === boot && boot.dataset.state === 'off') finish();
  });

  function showBoot() {
    clearTimeout(finishTimer);
    // Powering down must not leave the camera running behind the overlay.
    if (state.mode === 'camera') {
      stopCamera();
      setMode(state.full ? 'editor' : 'empty');
    }
    boot.classList.remove('hidden', 'is-leaving');
    boot.dataset.state = 'on';
    document.body.classList.add('is-booting');
    setBehindInert(true);
    // Reading layout restarts the entrance animations.
    void boot.offsetWidth;
    powerBtn?.focus({ preventScroll: true });
  }

  powerBtn?.addEventListener('click', () => powerOn());

  document.addEventListener('keydown', (e) => {
    if (boot.dataset.state !== 'on') return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      powerOn();
    }
  });

  // The wordmark powers the camera back down.
  const lockup = document.querySelector('.brand-lockup');
  lockup?.addEventListener('click', showBoot);
  lockup?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showBoot();
    }
  });

  setBehindInert(true);
  powerBtn?.focus({ preventScroll: true });
})();
