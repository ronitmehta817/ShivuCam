'use strict';

/* ============================================================================
 * Digicam - the look of an early-2000s point-and-shoot, applied in the browser.
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
 * full-resolution pixels before secure save.
 * ========================================================================== */

const PREVIEW_MAX_DIM = 1300;
const DRAFT_MAX_DIM = 620;

/**
 * The live viewfinder runs the full pipeline on every frame, so its resolution
 * is a frame-rate budget rather than a quality choice. Small is also honest: the
 * LCD on one of these cameras held about 110k pixels.
 */
const LIVE_MAX_DIM = 480;

/**
 * A filtered movie is the LCD feed itself: small, fast, and honest to the
 * cameras this interface imitates. Fifteen frames per second is both the period
 * look and a realistic ceiling for running the full pixel pipeline on a phone.
 * The hard stop keeps an in-memory MediaRecorder from taking a tab down.
 */
const VIDEO_FPS = 15;
const VIDEO_MAX_SECONDS = 30;
const VIDEO_BITS_PER_SECOND = 2_500_000;

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
 * The sheet
 *
 * Four cuts printed two by two, the Korean photobooth format. The sheet is
 * drawn at 1154 x 962 for a 540px cut and every measurement scales from there,
 * so one geometry serves both the on-screen preview and the print export.
 * ------------------------------------------------------------------------- */

const SHEET_CUTS = 4;
const SHEET_COLS = 2;           // four cuts, two across
const SHEET_CUT_FULL = 1200;    // cut width on export
const SHEET_CUT_PREVIEW = 460;  // cut width on screen
const SHEET_CUT_DRAFT = 230;    // cut width while a slider is moving

/**
 * Booth shots are cut down to this on the long edge the moment they are taken.
 * A cut prints at 1200px whatever it was shot at, so a 12MP frame held for a
 * 1200px crop is 40MB of nothing — and four of them at once, on a phone, mid
 * run, is how a tab gets killed. A single shot keeps every pixel.
 */
const BOOTH_SHOT_MAX = 1600;

const BOOTH_COUNT = 20;   // seconds between cuts, to move and change the pose
const BOOTH_URGENT = 3;   // when the numeral turns red and starts insisting

/* ---------------------------------------------------------------------------
 * The moving sheet
 *
 * The booth's second output. Every cut also records a few seconds from the
 * shutter onwards, and the four clips play at once on the same paper: the print
 * you are holding, alive. Small numbers on purpose — this is a GIF, and a GIF
 * pays for every pixel four times over.
 * ------------------------------------------------------------------------- */

const MOTION_FPS = 10;
const MOTION_SECONDS = 3;
const MOTION_FRAMES = MOTION_FPS * MOTION_SECONDS;
const MOTION_STEP = 1000 / MOTION_FPS;
const MOTION_CUT_W = 300;  // cut width inside the moving sheet

/** Paper stock. Ink is what the camera prints the footer in. */
const PAPERS = {
  white: { paper: '#f7f5f0', ink: '#26262a', sub: '#73737a' },
  black: { paper: '#141416', ink: '#f2f0ea', sub: '#8f8f96' },
  cream: { paper: '#f0e4cd', ink: '#463c30', sub: '#87795f' },
  pink: { paper: '#f7dbe3', ink: '#54323d', sub: '#9a6a78' },
  mint: { paper: '#d9ebe1', ink: '#2c483b', sub: '#5f8577' },
};

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */

const state = {
  mode: 'empty',  // 'empty' | 'camera' | 'editor' | 'video'
  params: { ...SCENE },
  // { cuts: [{ full, preview, draft }], cutW: { full, preview } }
  sheet: null,
  // { cuts: [[canvas x MOTION_FRAMES] x 4] } - the same sheet, moving
  motion: null,
  playing: false,
  // { blob, url, mime, ext, kind, w, h, duration, hasAudio, name }
  video: null,
  paper: 'white',  // stock the cuts print on, kept across sheets
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
  videoMode: false,
  hasAudio: false,
  recording: null,
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
  dzVideoBtn: el('dzVideoBtn'),
  dzBoothBtn: el('dzBoothBtn'),
  foldAdjustments: el('foldAdjustments'),
  foldDate: el('foldDate'),
  foldExport: el('foldExport'),
  foldVideo: el('foldVideo'),
  resetBtn: el('resetBtn'),
  downloadBtn: el('downloadBtn'),
  gifBtn: el('gifBtn'),
  playToggle: el('playToggle'),
  dropzone: el('dropzone'),
  viewer: el('viewer'),
  cameraView: el('cameraView'),
  camCanvas: el('camCanvas'),
  camFlash: el('camFlash'),
  camBusy: el('camBusy'),
  camBusyText: el('camBusyText'),
  camDevice: el('camDevice'),
  camVideo: el('camVideo'),
  camMirror: el('camMirror'),
  camFiltered: el('camFiltered'),
  camReadout: el('camReadout'),
  osdSpec: el('osdSpec'),
  shutterBtn: el('shutterBtn'),
  boothBtn: el('boothBtn'),
  boothOsd: el('boothOsd'),
  boothCount: el('boothCount'),
  boothStep: el('boothStep'),
  boothSlots: el('boothSlots'),
  videoRecOsd: el('videoRecOsd'),
  videoRecTime: el('videoRecTime'),
  foldPrint: el('foldPrint'),
  papers: el('papers'),
  canvasWrap: el('canvasWrap'),
  preview: el('previewCanvas'),
  original: el('originalCanvas'),
  compareHandle: el('compareHandle'),
  compareToggle: el('compareToggle'),
  videoView: el('videoView'),
  videoPreview: el('videoPreview'),
  animationPreview: el('animationPreview'),
  videoWrap: el('videoWrap'),
  videoScreenAction: el('videoScreenAction'),
  videoPlayToggle: el('videoPlayToggle'),
  videoMeta: el('videoMeta'),
  videoSummary: el('videoSummary'),
  videoPanelTitle: el('videoPanelTitle'),
  videoHint: el('videoHint'),
  videoRetakeBtn: el('videoRetakeBtn'),
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
 * does not pass as a digicam shot: no amount of grading fakes the absence of
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
 * Kept small. A large crisp stamp is the usual tell of a fake digicam look.
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

const hasImage = () => Boolean(state.sheet || state.preview);
const restingMode = () => state.video ? 'video' : hasImage() ? 'editor' : 'empty';

/**
 * What the current source renders to, at a given quality. A single photo is one
 * pass of the chain; a sheet is one pass per cut, then the paper.
 */
function renderOutput(quality) {
  if (state.sheet) {
    const key = quality === 'full' ? 'full' : quality === 'draft' ? 'draft' : 'preview';
    const cuts = state.sheet.cuts.map((cut) => renderTo(cut[key], state.params));
    // Drafts keep the paper and footer sharp and let only the photos soften.
    const cutW = quality === 'full' ? state.sheet.cutW.full : state.sheet.cutW.preview;
    return composeSheet(cuts, state.paper, cutW);
  }
  const layer = quality === 'full' ? state.full
    : quality === 'draft' ? state.draft
    : state.preview;
  return renderTo(layer, state.params);
}

/** Size of that render, for canvas sizing and the readout. */
function outputSize(quality) {
  if (state.sheet) {
    const cutW = quality === 'full' ? state.sheet.cutW.full : state.sheet.cutW.preview;
    const g = sheetGeometry(cutW);
    return { w: g.w, h: g.h };
  }
  const layer = quality === 'full' ? state.full : state.preview;
  return { w: layer.w, h: layer.h };
}

/**
 * Schedules a repaint of the preview canvas. A `draft` pass trades resolution
 * for latency while a control is being dragged; the `preview` pass runs once the
 * value settles. A pending draft is superseded by a newer request rather than
 * queued behind it, so dragging never builds a backlog.
 */
function requestPreview(quality = 'preview') {
  // The viewfinder repaints itself every frame, so it needs nothing from here.
  if (state.mode !== 'editor' || !hasImage()) return;

  if (state.rendering) {
    if (quality === 'preview' || state.queued !== 'preview') state.queued = quality;
    return;
  }

  state.rendering = true;
  requestAnimationFrame(() => {
    try {
      const out = renderOutput(quality);
      const { w, h } = outputSize('preview');
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

/**
 * One image opens as a photo; four open as a sheet. Anything in between is a
 * near miss worth naming, so the user knows why they got a single frame.
 */
async function loadFiles(files) {
  const selected = [...files];

  // If a key file is dropped/selected, import it directly.
  const keyFiles = selected.filter(isDigicamKeyFile);
  if (keyFiles.length) {
    await handleKeyFileImport(keyFiles[0]);
    return;
  }

  let locked = selected.filter(isDigicamSecureFile);

  // On mobile, the file picker may strip the extension or report an empty MIME.
  // Fall back to checking the file's magic bytes (DGC1 header) for any
  // unrecognized file that isn't an image or video.
  if (!locked.length) {
    const unknown = selected.filter(
      (f) => !f.type || (!f.type.startsWith('image/') && !f.type.startsWith('video/')),
    );
    for (const f of unknown) {
      if (f.size >= DGC_HEADER_SIZE) {
        try {
          const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
          if (head[0] === 0x44 && head[1] === 0x47 && head[2] === 0x43 && head[3] === 0x31) {
            locked.push(f);
          }
        } catch (_) { /* skip unreadable files */ }
      }
    }
  }

  if (locked.length) {
    if (selected.length > 1) {
      showToast('Opening the first encrypted file. Secure files are opened one at a time.');
    }
    return loadSecureFile(locked[0]);
  }

  const images = selected.filter((f) => f.type.startsWith('image/'));
  if (images.length === 0) {
    showToast('Choose an image or a saved .digicam file.', true);
    return;
  }
  if (images.length >= SHEET_CUTS) return loadSheet(images.slice(0, SHEET_CUTS));
  if (images.length > 1) {
    showToast(`A sheet needs four photos, and you picked ${images.length}. Opening the first.`);
  }
  return loadFile(images[0]);
}

async function loadSecureFile(file) {
  if (!file) return;
  stopCamera();
  setMode(restingMode());
  setBusy(true, 'Checking encryption key\u2026');

  try {
    const { blob, metadata } = await decryptDigicamFile(file, (progress) => {
      setBusy(true, `Decrypting\u2026 ${Math.round(progress * 100)}%`);
    });
    setBusy(false);
    openDecryptedMedia(blob, metadata);
  } catch (error) {
    setBusy(false);
    if (error?.code === 'KEY_MISSING') {
      showToast('No key loaded \u00b7 file destroyed. Load key before opening.', true);
      return;
    }
    showToast(secureOpenError(error), true);
    console.error(error);
  }
}

function openDecryptedMedia(blob, metadata) {
  if (metadata.kind === 'image') {
    const unlocked = new File(
      [blob],
      metadata.name || 'unlocked-image',
      {
        type: metadata.mime,
        lastModified: Date.parse(metadata.createdAt) || Date.now(),
      },
    );
    loadFile(unlocked);
    showToast('Decrypted with your key.');
    return;
  }

  openVideoOutput({
    blob,
    mime: metadata.mime,
    kind: metadata.kind,
    name: metadata.name,
    w: metadata.w || 0,
    h: metadata.h || 0,
    duration: metadata.duration || 0,
    hasAudio: metadata.hasAudio,
    unlocked: true,
  });
}

async function handleKeyFileImport(file) {
  setBusy(true, 'Importing key file\u2026');
  try {
    await importKeyFile(file);
    showToast('Key file loaded \u00b7 encryption key restored');
    updateKeyStatus();
    setBusy(false);
  } catch (error) {
    setBusy(false);
    showToast(
      error instanceof DigicamSecureError
        ? error.message
        : 'Could not read the key file.',
      true,
    );
    console.error(error);
  }
}

async function handleGenerateNewKey() {
  const existing = await getRawKeyBytes();
  if (existing) {
    showToast('A key already exists. Export it, or import a different one.', true);
    return;
  }
  setBusy(true, 'Generating new encryption key\u2026');
  try {
    await getDigicamDeviceKey({ create: true });
    updateKeyStatus();
    setBusy(false);
    showToast('New key generated \u00b7 export it now to keep a backup');
  } catch (error) {
    setBusy(false);
    showToast('Key generation failed.', true);
    console.error(error);
  }
}

function updateKeyStatus() {
  const el = document.getElementById('keyStatus');
  if (!el) return;
  getRawKeyBytes().then((bytes) => {
    if (bytes) {
      el.textContent = 'Key active \u00b7 ready to encrypt and decrypt.';
      el.style.color = '';
    } else {
      el.textContent = 'No key loaded. Generate or import one to get started.';
      el.style.color = '';
    }
  }).catch(() => {
    el.textContent = 'No key loaded. Generate or import one to get started.';
  });
}


async function exportKeyToFile() {
  try {
    const rawBytes = await getRawKeyBytes();
    if (!rawBytes) {
      showToast('No key to export. Generate or import one first.', true);
      return;
    }
    const blob = exportKeyFileBlob(rawBytes);
    const canShare = navigator.canShare && navigator.share;
    if (canShare) {
      const file = new File([blob], 'digicam.key', { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Digicam encryption key' });
          showToast('Key file saved \u00b7 keep it safe');
          localStorage.setItem('digicam-key-file-delivered', '1');
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
        }
      }
    }
    downloadBlobAsFile(blob, 'digicam.key');
    localStorage.setItem('digicam-key-file-delivered', '1');
    showToast('Key file downloaded \u00b7 keep it safe');
  } catch (error) {
    showToast('Could not export the key file.', true);
    console.error(error);
  }
}

function secureOpenError(error) {
  switch (error?.code) {
    case 'KEY_MISSING':
      return 'No encryption key found. Import your digicam.key file to restore access.';
    case 'AUTH_FAILED':
      return 'Wrong key or corrupted file. This file was encrypted with a different key.';
    case 'ORIGIN_REQUIRED':
    case 'INSECURE_CONTEXT':
      return 'Open Digicam from its original localhost or HTTPS address to use the device key.';
    case 'UNSUPPORTED_VERSION':
      return 'This .digicam file uses an unsupported secure format.';
    case 'NOT_DIGICAM':
    case 'CORRUPT_FILE':
      return 'This .digicam file is incomplete or invalid.';
    case 'KEY_INVALID':
    case 'KEY_STORAGE_FAILED':
    case 'KEY_STORAGE_UNAVAILABLE':
    case 'KEY_STORAGE_UNSUPPORTED':
    case 'KEY_STORAGE_BLOCKED':
    case 'CRYPTO_UNAVAILABLE':
      return error.message;
    default:
      return 'The locked file could not be opened on this device.';
  }
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('That file is not an image.', true);
    return;
  }

  stopCamera();
  clearVideoOutput();
  setMode(restingMode());
  setBusy(true, 'Loading image\u2026');
  try {
    const bitmap = await decode(file);
    const w = bitmap.width;
    const h = bitmap.height;

    state.sheet = null;
    syncSheetUi();
    clearMotion();

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

/** Four files, in the order they were given, onto one sheet. */
async function loadSheet(files) {
  stopCamera();
  clearVideoOutput();
  setMode(restingMode());
  setBusy(true, 'Printing four cuts\u2026');
  try {
    const bitmaps = [];
    for (const file of files) bitmaps.push(await decode(file));
    const sources = bitmaps.map((b) => ({ source: b, w: b.width, h: b.height }));
    openSheet(sources, `4cut-${stampSlug()}`);
    for (const b of bitmaps) if (b.close) b.close();
    showToast('Four cuts, two by two. Pick the paper under Print.');
  } catch (err) {
    showToast('Could not read those images.', true);
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
 * The sheet
 * ========================================================================= */

/** Every measurement on the sheet, derived from one cut width. */
function sheetGeometry(cutW) {
  const u = cutW / 540;
  const margin = Math.round(30 * u);
  const gap = Math.round(14 * u);
  const footer = Math.round(108 * u);
  const cutH = Math.round((cutW * 3) / 4);
  const cols = SHEET_COLS;
  const rows = Math.ceil(SHEET_CUTS / cols);
  return {
    u, cutW, cutH, margin, gap, footer, cols, rows,
    w: margin * 2 + cutW * cols + gap * (cols - 1),
    h: margin + cutH * rows + gap * (rows - 1) + footer,
  };
}

/**
 * Lays finished cuts onto paper.
 *
 * The cuts arrive already through the camera chain and the paper never goes
 * through it at all: a print has clean borders, so noise and vignetting have to
 * stop at the edge of each photo. That is the whole reason the sheet is composed
 * after the pipeline instead of being fed to it as one image.
 */
function composeSheet(cuts, paperName, cutW, target) {
  const g = sheetGeometry(cutW);
  const skin = PAPERS[paperName] || PAPERS.white;
  const out = target || document.createElement('canvas');
  if (out.width !== g.w) out.width = g.w;
  if (out.height !== g.h) out.height = g.h;
  const ctx = out.getContext('2d');

  ctx.fillStyle = skin.paper;
  ctx.fillRect(0, 0, g.w, g.h);

  // Reading order: cuts one and two across the top, three and four below.
  cuts.forEach((cut, i) => {
    if (!cut) return;
    const x = g.margin + (i % g.cols) * (g.cutW + g.gap);
    const y = g.margin + Math.floor(i / g.cols) * (g.cutH + g.gap);
    ctx.drawImage(cut, x, y, g.cutW, g.cutH);
  });

  const footTop = g.margin + g.rows * g.cutH + (g.rows - 1) * g.gap;
  const cx = g.w / 2;
  const spaced = 'letterSpacing' in ctx;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  if (spaced) ctx.letterSpacing = `${Math.max(1, Math.round(6 * g.u))}px`;
  ctx.fillStyle = skin.ink;
  // Type is set against the cut, not the sheet, so a caption on the wider sheet
  // stays the size a caption should be rather than growing with the paper.
  ctx.font = `700 ${Math.round(31 * g.u)}px "Archivo Narrow", "Arial Narrow", sans-serif`;
  ctx.fillText('DIGICAM CCD-03', cx, footTop + g.footer * 0.46);

  if (spaced) ctx.letterSpacing = `${Math.max(1, Math.round(3 * g.u))}px`;
  ctx.fillStyle = skin.sub;
  ctx.font = `400 ${Math.round(20 * g.u)}px "Silkscreen", ui-monospace, monospace`;
  ctx.fillText(sheetDate(), cx, footTop + g.footer * 0.8);
  if (spaced) ctx.letterSpacing = '0px';

  return out;
}

/** Booths print the date in dots. A typed stamp wins, since the user meant it. */
function sheetDate() {
  const custom = state.dateText.trim();
  if (custom) return custom;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/** One cut, cropped to 4:3 from the middle of whatever it was given. */
function cutLayer(source, sw, sh, cutW) {
  const layer = makeLayer(cutW, Math.round((cutW * 3) / 4));
  const scale = Math.max(layer.w / sw, layer.h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  layer.ctx.imageSmoothingQuality = 'high';
  layer.ctx.drawImage(source, (layer.w - dw) / 2, (layer.h - dh) / 2, dw, dh);
  return layer;
}

/**
 * Turns four sources into a loaded sheet. Each cut is cropped up front at three
 * resolutions, so the sheet is uniform by construction and no render has to
 * work out where a photo goes.
 */
function openSheet(sources, name, { fromBooth = false } = {}) {
  const usable = sources.reduce(
    (min, s) => Math.min(min, s.w, Math.round((s.h * 4) / 3)),
    Infinity,
  );
  const full = Math.max(120, Math.min(SHEET_CUT_FULL, usable));
  const preview = Math.min(full, SHEET_CUT_PREVIEW);
  const draft = Math.min(full, SHEET_CUT_DRAFT);

  // Whatever was moving belonged to the sheet that just went away.
  clearMotion();
  clearVideoOutput();

  const cuts = sources.map((s) => ({
    full: cutLayer(s.source, s.w, s.h, full),
    preview: cutLayer(s.source, s.w, s.h, preview),
    draft: cutLayer(s.source, s.w, s.h, draft),
  }));

  state.sheet = { cuts, cutW: { full, preview }, fromBooth };
  state.full = null;
  state.preview = null;
  state.draft = null;
  state.sourceName = name;
  state.sourceBytes = 0;

  syncSheetUi();
  const { w, h } = outputSize('preview');
  ui.preview.width = w;
  ui.preview.height = h;
  ui.original.width = w;
  ui.original.height = h;
  drawSheetOriginal();

  setMode('editor');
  setSplit(50);
  updateMeta();
  pulseDevelop();
  requestPreview();
}

/** The compare layer: the same sheet, printed from untouched photos. */
function drawSheetOriginal() {
  if (!state.sheet) return;
  const sheet = composeSheet(
    state.sheet.cuts.map((c) => c.preview.canvas),
    state.paper,
    state.sheet.cutW.preview,
  );
  originalCtx.clearRect(0, 0, ui.original.width, ui.original.height);
  originalCtx.drawImage(sheet, 0, 0);
}

function syncSheetUi() {
  const on = Boolean(state.sheet);
  document.body.dataset.output = on ? 'sheet' : 'photo';
  // A print out of the booth is finished work. Its look is fixed, so the deck
  // drops the sliders rather than offering edits the print is not asking for.
  if (on && state.sheet.fromBooth) document.body.dataset.origin = 'booth';
  else delete document.body.dataset.origin;
  if (ui.foldPrint) ui.foldPrint.hidden = !on || state.mode === 'video';
  if (!on) return;
  for (const btn of ui.papers.children) {
    const active = btn.dataset.paper === state.paper;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

/* ===========================================================================
 * Camera
 * ========================================================================= */

async function startCamera(deviceId, { videoMode = camera.videoMode } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('This browser cannot open a camera.', true);
    return;
  }

  if (camera.recording) discardVideoRecording();
  camera.videoMode = Boolean(videoMode);
  camera.hasAudio = false;
  syncCameraCaptureUi();
  setMode('camera');
  setCamBusy(true, 'Starting camera\u2026');
  ui.shutterBtn.disabled = true;
  ui.boothBtn.disabled = true;
  endBooth();
  stopStream();

  // Everything the sensor has. A number no camera can meet is the standard way
  // to ask for the largest mode available, since browsers read these as hints
  // and return the closest thing they can.
  //
  // 4:3 stays as a preference rather than a requirement: it is the shape these
  // cameras shot, and where a sensor offers it the browser picks a 4:3 mode. On
  // a 16:9-only camera the frame comes back 16:9 at full size instead of being
  // cropped down to fit an aesthetic.
  const video = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: 'environment' };
  Object.assign(video, {
    width: { ideal: 8192 },
    height: { ideal: 8192 },
    aspectRatio: { ideal: 4 / 3 },
  });

  const audio = camera.videoMode
    ? {
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
    : false;

  let streamError = null;
  let microphoneFallback = false;
  try {
    camera.stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (err) {
    // A denied or unavailable microphone must not take the camera with it. The
    // second request is video-only and preserves every other part of movie mode.
    if (camera.videoMode) {
      try {
        camera.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        microphoneFallback = true;
      } catch (fallbackError) {
        streamError = fallbackError;
      }
    } else {
      streamError = err;
    }
  }

  if (!camera.stream) {
    setCamBusy(false);
    showToast(cameraError(streamError), true);
    setMode(restingMode());
    return;
  }

  camera.deviceId = deviceId || null;
  camera.hasAudio = camera.stream.getAudioTracks().length > 0;

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
    setMode(restingMode());
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
  syncCameraCaptureUi();
  camera.lastFrameAt = 0;
  camera.fps = 0;
  updateCamReadout();
  cameraLoop();
  if (microphoneFallback) {
    showToast('Microphone unavailable. This video will be silent.');
  }
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

/** The current frame at the sensor's full resolution, or null if there isn't one. */
function grabFrame() {
  const video = camera.video;
  if (!video || video.readyState < 2) return null;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;

  const shot = makeLayer(w, h);
  shot.ctx.save();
  if (camera.mirror) {
    shot.ctx.translate(w, 0);
    shot.ctx.scale(-1, 1);
  }
  shot.ctx.drawImage(video, 0, 0, w, h);
  shot.ctx.restore();
  return shot;
}

function fireFlash() {
  ui.camFlash.classList.remove('is-firing');
  // Reading offsetWidth restarts the animation.
  void ui.camFlash.offsetWidth;
  ui.camFlash.classList.add('is-firing');
  ui.shutterBtn.classList.remove('is-firing');
  void ui.shutterBtn.offsetWidth;
  ui.shutterBtn.classList.add('is-firing');
}

/** Grabs the current frame and opens it as a single photo. */
function capture() {
  const shot = grabFrame();
  if (!shot) return;
  const { w, h } = shot;

  fireFlash();
  stopCamera();

  state.sheet = null;
  syncSheetUi();
  clearMotion();
  clearVideoOutput();
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

/* --- the booth ----------------------------------------------------------- */

/**
 * Four shots on a timer, the way a booth does it: countdown, flash, hold the
 * pose while it records, move on. One press runs the whole sheet.
 *
 * The twenty seconds between cuts are the point of a booth rather than dead
 * time — it is how long it takes four people to think of the next pose.
 */
const booth = { active: false, shots: [], clips: [] };

/**
 * Opens the camera straight into a run. This is the whole booth from one press,
 * for the key on the empty screen.
 */
async function openBooth() {
  if (booth.active || camera.recording) return;
  if (!camera.stream || camera.videoMode) {
    await startCamera(camera.deviceId, { videoMode: false });
  }
  // No stream means the camera was refused or is missing; startCamera said why.
  if (!camera.stream) return;
  startBooth();
}

/**
 * Settles the look before the first countdown, then runs. A booth print is not
 * an editing session: the scene goes back to standard and the viewfinder filter
 * is forced on, so four cuts taken seconds apart cannot come out looking like
 * four different cameras, and the same press gives the same print every time.
 */
function startBooth() {
  if (booth.active || camera.videoMode || camera.recording) return;
  applyScene();
  camera.filtered = true;
  ui.camFiltered.checked = true;
  runBooth();
}

async function runBooth() {
  if (booth.active || !camera.stream) return;
  booth.active = true;
  booth.shots = [];
  booth.clips = [];
  document.body.dataset.booth = 'on';
  ui.boothBtn.setAttribute('aria-pressed', 'true');
  ui.boothBtn.setAttribute('aria-label', 'Stop the booth run');
  ui.shutterBtn.disabled = true;
  // Sliders stay put for the length of the run: cut one and cut four have to be
  // the same photograph twice, not two settings.
  ui.foldAdjustments.inert = true;
  // The countdown itself is decorative; the readout is what gets announced, and
  // during a run it only changes as a cut lands.
  ui.camReadout.setAttribute('aria-live', 'polite');
  showBoothSlots();

  try {
    for (let cut = 1; cut <= SHEET_CUTS && booth.active; cut++) {
      for (let n = BOOTH_COUNT; n > 0 && booth.active; n--) {
        showBoothOsd(String(n), `cut ${cut} of ${SHEET_CUTS}`, n <= BOOTH_URGENT);
        await wait(1000);
      }
      if (!booth.active) break;

      const shot = grabFrame();
      if (!shot) throw new Error('no frame to grab');
      booth.shots.push(scaledLayer(shot.canvas, shot.w, shot.h, BOOTH_SHOT_MAX));
      fireFlash();
      showBoothSlots();

      // The still is the first frame of the clip, so the moving sheet starts on
      // the photograph that gets printed and carries on from there.
      showBoothOsd('', 'hold it');
      booth.clips.push(await recordClip());
    }

    if (booth.active && booth.shots.length === SHEET_CUTS) {
      const shots = booth.shots;
      const clips = booth.clips;
      endBooth();
      stopCamera();
      openSheet(
        shots.map((s) => ({ source: s.canvas, w: s.w, h: s.h })),
        `4cut-${stampSlug()}`,
        { fromBooth: true },
      );
      await developMotion(clips);
      showToast('Four cuts, two by two. The moving version is under GIF.');
      return;
    }
  } catch (err) {
    showToast('The booth run stopped early.', true);
    console.error(err);
  }
  endBooth();
}

/** Leaves the viewfinder running; only the sequence stops. */
function cancelBooth() {
  if (!booth.active) return;
  endBooth();
  showToast('Booth run cancelled.');
}

function endBooth() {
  booth.active = false;
  booth.shots = [];
  booth.clips = [];
  delete document.body.dataset.booth;
  ui.boothBtn.setAttribute('aria-pressed', 'false');
  ui.boothBtn.setAttribute('aria-label', 'Shoot a four cut sheet');
  ui.camReadout.removeAttribute('aria-live');
  ui.shutterBtn.disabled = !camera.stream;
  ui.foldAdjustments.inert = false;
  showBoothOsd('', '');
  showBoothSlots();
}

function showBoothOsd(count, step, urgent = false) {
  ui.boothCount.textContent = count;
  ui.boothStep.textContent = step;
  ui.boothOsd.classList.toggle('is-urgent', Boolean(count) && urgent);
  ui.boothOsd.classList.toggle('is-recording', !count && Boolean(step));
  // Restarting the class is what makes each number land on its own.
  ui.boothOsd.classList.remove('is-counting');
  if (count) {
    void ui.boothOsd.offsetWidth;
    ui.boothOsd.classList.add('is-counting');
  }
}

/* --- the moving sheet ---------------------------------------------------- */

/**
 * Records straight off the viewfinder for a few seconds after the shutter,
 * already cropped to the cut and already small. Frames are timed against the
 * clock rather than counted, so a slow phone drops one instead of stretching
 * the clip into slow motion.
 */
async function recordClip() {
  const frames = [];
  const started = performance.now();

  for (let i = 0; i < MOTION_FRAMES; i++) {
    const due = started + i * MOTION_STEP;
    const late = performance.now() - due;
    if (late < 0) await wait(-late);
    if (!booth.active) break;

    const video = camera.video;
    if (!video || video.readyState < 2 || !video.videoWidth) continue;
    frames.push(mirroredCut(video, video.videoWidth, video.videoHeight, MOTION_CUT_W));
  }

  // A clip has to be the full length or the four will not play in step.
  while (frames.length && frames.length < MOTION_FRAMES) {
    frames.push(frames[frames.length - 1]);
  }
  return frames;
}

/** One cut of the moving sheet: 4:3 from the middle, flipped if the lens was. */
function mirroredCut(source, sw, sh, cutW) {
  const layer = makeLayer(cutW, Math.round((cutW * 3) / 4));
  const scale = Math.max(layer.w / sw, layer.h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  layer.ctx.save();
  if (camera.mirror) {
    layer.ctx.translate(layer.w, 0);
    layer.ctx.scale(-1, 1);
  }
  layer.ctx.imageSmoothingQuality = 'high';
  layer.ctx.drawImage(source, (layer.w - dw) / 2, (layer.h - dh) / 2, dw, dh);
  layer.ctx.restore();
  return layer;
}

/**
 * Runs the clips through the camera chain once and keeps the result. A hundred
 * and twenty small frames take a second or two, which is worth paying here,
 * where the sheet has just appeared and nobody is waiting on a control, rather
 * than at the moment somebody presses save.
 *
 * The look cannot drift underneath them: a booth sheet has no sliders.
 */
async function developMotion(clips) {
  clearMotion();
  if (clips.length !== SHEET_CUTS || clips.some((c) => c.length !== MOTION_FRAMES)) return;

  setBusy(true, 'Developing the moving sheet\u2026');
  await nextFrame();

  try {
    const cuts = [];
    for (let c = 0; c < clips.length; c++) {
      const frames = [];
      for (let i = 0; i < MOTION_FRAMES; i++) {
        frames.push(renderTo(clips[c][i], state.params));
        // Let the raw frame go as soon as it has been developed: holding both
        // copies of two minutes of booth is a hundred and twenty canvases too
        // many for a phone.
        clips[c][i] = null;
        // Every few frames, let the screen catch up with the count. A timer
        // rather than a frame callback: this also has to finish if the phone is
        // face down or the tab is in the background, where frames stop coming.
        if (i % 8 === 7) {
          const done = (c * MOTION_FRAMES + i + 1) / (SHEET_CUTS * MOTION_FRAMES);
          setBusy(true, `Developing the moving sheet\u2026 ${Math.round(done * 100)}%`);
          await wait(0);
        }
      }
      cuts.push(frames);
    }
    state.motion = { cuts };
  } catch (err) {
    showToast('The moving sheet could not be developed.', true);
    console.error(err);
  } finally {
    setBusy(false);
    syncMotionUi();
  }
}

function clearMotion() {
  stopPlayback();
  state.motion = null;
  syncMotionUi();
}

function syncMotionUi() {
  const on = Boolean(state.motion);
  if (on) document.body.dataset.motion = 'on';
  else delete document.body.dataset.motion;
  ui.gifBtn.disabled = !on;
  ui.playToggle.checked = state.playing;
}

/** Composes one frame of the moving sheet onto the current paper. */
function motionFrame(i, target) {
  return composeSheet(
    state.motion.cuts.map((frames) => frames[i]),
    state.paper,
    MOTION_CUT_W,
    target,
  );
}

/**
 * Plays the sheet on the LCD. The compare layer steps aside while it runs —
 * a divider across a moving image is two ideas at once, and neither reads.
 */
let playTimer = 0;

function startPlayback() {
  if (!state.motion || state.playing) return;
  state.playing = true;
  ui.canvasWrap.classList.add('is-playing');
  ui.playToggle.checked = true;

  let i = 0;
  const tick = () => {
    if (!state.playing || !state.motion) return;
    const frame = motionFrame(i % MOTION_FRAMES);
    previewCtx.clearRect(0, 0, ui.preview.width, ui.preview.height);
    previewCtx.drawImage(frame, 0, 0, ui.preview.width, ui.preview.height);
    i++;
    playTimer = setTimeout(tick, MOTION_STEP);
  };
  tick();
}

function stopPlayback() {
  clearTimeout(playTimer);
  playTimer = 0;
  if (!state.playing) return;
  state.playing = false;
  ui.canvasWrap.classList.remove('is-playing');
  ui.playToggle.checked = false;
  requestPreview();
}

function showBoothSlots() {
  const filled = booth.active ? booth.shots.length : 0;
  [...ui.boothSlots.children].forEach((slot, i) => {
    slot.classList.toggle('is-filled', i < filled);
    slot.classList.toggle('is-next', booth.active && i === filled);
  });
}

/* --- video recording ----------------------------------------------------- */

/** Opens the same camera directly in movie mode from the empty LCD. */
async function openVideoCamera() {
  camera.videoMode = true;
  await startCamera(camera.deviceId, { videoMode: true });
}

/**
 * The browser decides the container it can write. MP4 comes first because it
 * saves and shares cleanly on iOS; Firefox and older Chromium fall through to
 * WebM. Feature detection is mandatory here — support is encoder-dependent.
 */
function supportedVideoType(hasAudio = false) {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'video/mp4',
    ...(hasAudio ? [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
    ] : []),
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return types.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

async function startVideoRecording() {
  if (camera.recording || booth.active || !camera.stream) return;
  if (typeof MediaRecorder === 'undefined' || typeof ui.camCanvas.captureStream !== 'function') {
    showToast('This browser cannot record the filtered viewfinder.', true);
    return;
  }

  let outputStream;
  try {
    outputStream = ui.camCanvas.captureStream(VIDEO_FPS);
  } catch (err) {
    showToast('The browser could not turn the filtered viewfinder into a video.', true);
    console.error(err);
    return;
  }
  const videoTrack = outputStream?.getVideoTracks?.()[0];
  if (!videoTrack) {
    showToast('The filtered viewfinder could not be recorded.', true);
    return;
  }

  // Audio comes from the same permission request as the camera. Clone it so
  // ending the recording cannot end the live view before the recorder flushes.
  const sourceAudio = camera.stream.getAudioTracks()[0];
  let hasAudio = false;
  if (sourceAudio) {
    try {
      outputStream.addTrack(sourceAudio.clone());
      hasAudio = true;
    } catch (_) { /* a silent clip is still a valid clip */ }
  }

  const mime = supportedVideoType(hasAudio);
  const options = { videoBitsPerSecond: VIDEO_BITS_PER_SECOND };
  if (mime) options.mimeType = mime;

  let recorder;
  try {
    recorder = new MediaRecorder(outputStream, options);
  } catch (err) {
    // Some devices advertise an encoder but cannot allocate it. Let the
    // browser choose its default once before giving up.
    try {
      recorder = new MediaRecorder(outputStream);
    } catch (fallbackError) {
      outputStream.getTracks().forEach((track) => track.stop());
      showToast('This device could not start a video encoder.', true);
      console.error(err, fallbackError);
      return;
    }
  }

  const recording = {
    recorder,
    stream: outputStream,
    chunks: [],
    startedAt: performance.now(),
    duration: 0,
    timer: 0,
    limitTimer: 0,
    stopping: false,
    discard: false,
    finalized: false,
    mime: recorder.mimeType || mime,
    w: ui.camCanvas.width,
    h: ui.camCanvas.height,
    hasAudio,
  };
  camera.recording = recording;

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) recording.chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => finalizeVideoRecording(recording), { once: true });
  recorder.addEventListener('error', (event) => {
    showToast('Video recording stopped because the encoder failed.', true);
    console.error(event.error || event);
    stopVideoRecording({ discard: true });
  });

  try {
    recorder.start(1000);
  } catch (err) {
    camera.recording = null;
    outputStream.getTracks().forEach((track) => track.stop());
    showToast('Video recording could not start.', true);
    console.error(err);
    return;
  }

  document.body.dataset.videoRecording = 'on';
  ui.videoRecTime.textContent = '00:00';
  ui.foldAdjustments.inert = true;
  ui.foldDate.inert = true;
  syncCameraCaptureUi();
  updateVideoRecordingClock();
  recording.timer = setInterval(updateVideoRecordingClock, 250);
  recording.limitTimer = setTimeout(
    () => stopVideoRecording(),
    VIDEO_MAX_SECONDS * 1000,
  );
}

function stopVideoRecording({ discard = false } = {}) {
  const recording = camera.recording;
  if (!recording || recording.stopping) return;

  recording.stopping = true;
  recording.discard = discard;
  recording.duration = Math.min(
    VIDEO_MAX_SECONDS * 1000,
    performance.now() - recording.startedAt,
  );
  clearInterval(recording.timer);
  clearTimeout(recording.limitTimer);

  if (!discard) setCamBusy(true, 'Finishing video\u2026');
  try {
    if (recording.recorder.state === 'inactive') {
      finalizeVideoRecording(recording);
    } else {
      recording.recorder.stop();
    }
  } catch (err) {
    recording.discard = true;
    finalizeVideoRecording(recording);
    console.error(err);
  }
}

function discardVideoRecording() {
  stopVideoRecording({ discard: true });
}

function finalizeVideoRecording(recording) {
  if (recording.finalized) return;
  recording.finalized = true;
  clearInterval(recording.timer);
  clearTimeout(recording.limitTimer);
  recording.stream.getTracks().forEach((track) => track.stop());
  if (camera.recording === recording) camera.recording = null;

  delete document.body.dataset.videoRecording;
  ui.foldAdjustments.inert = booth.active;
  ui.foldDate.inert = false;
  setCamBusy(false);
  syncCameraCaptureUi();

  if (recording.discard) return;

  const mime = recording.recorder.mimeType
    || recording.mime
    || recording.chunks.find((chunk) => chunk.type)?.type
    || 'video/webm';
  const blob = new Blob(recording.chunks, { type: mime });
  if (!blob.size) {
    showToast('The browser returned an empty video. Try recording again.', true);
    return;
  }

  openVideoOutput({
    blob,
    mime,
    w: recording.w,
    h: recording.h,
    duration: recording.duration,
    hasAudio: recording.hasAudio,
  });
}

function updateVideoRecordingClock() {
  const recording = camera.recording;
  if (!recording) return;
  const elapsed = Math.min(
    VIDEO_MAX_SECONDS * 1000,
    performance.now() - recording.startedAt,
  );
  ui.videoRecTime.textContent = formatClock(elapsed);
  updateCamReadout();
}

function syncCameraCaptureUi() {
  const recording = Boolean(camera.recording);
  document.body.dataset.capture = camera.videoMode ? 'video' : 'photo';
  ui.pickBtn.disabled = recording;
  ui.resetBtn.disabled = recording || state.mode === 'empty' || state.mode === 'video';
  ui.camVideo.checked = camera.videoMode;
  ui.camVideo.disabled = recording;
  ui.camMirror.disabled = recording;
  ui.camFiltered.disabled = recording;
  ui.camDevice.disabled = recording;
  ui.boothBtn.disabled = !camera.stream || camera.videoMode || recording;
  ui.shutterBtn.disabled = !camera.stream || booth.active;
  ui.shutterBtn.setAttribute(
    'aria-label',
    camera.videoMode
      ? recording ? 'Stop recording video' : 'Start recording video'
      : 'Take photo',
  );
  ui.shutterBtn.setAttribute('aria-pressed', String(recording));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stopCamera() {
  if (camera.recording) discardVideoRecording();
  endBooth();
  cancelAnimationFrame(camera.frame);
  camera.frame = 0;
  stopStream();
}

function stopStream() {
  if (camera.stream) {
    for (const track of camera.stream.getTracks()) track.stop();
    camera.stream = null;
  }
  camera.hasAudio = false;
  if (camera.video) camera.video.srcObject = null;
  syncCameraCaptureUi();
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
  updateOsdSpec();
  const video = camera.video;
  if (!video?.videoWidth) { ui.camReadout.textContent = ''; return; }
  if (camera.recording) {
    const elapsed = performance.now() - camera.recording.startedAt;
    const sound = camera.recording.hasAudio ? 'mic' : 'silent';
    ui.camReadout.textContent =
      `recording ${formatClock(elapsed)} of ${formatClock(VIDEO_MAX_SECONDS * 1000)} \u00b7 ` +
      `${camera.recording.w}\u00d7${camera.recording.h} \u00b7 ${VIDEO_FPS} fps \u00b7 ${sound}`;
    return;
  }
  if (booth.active) {
    ui.camReadout.textContent =
      `booth \u00b7 ${booth.shots.length} of ${SHEET_CUTS} cuts \u00b7 esc to stop`;
    return;
  }
  if (camera.videoMode) {
    const sound = camera.hasAudio ? 'mic ready' : 'silent';
    ui.camReadout.textContent =
      `movie ${ui.camCanvas.width}\u00d7${ui.camCanvas.height} \u00b7 ` +
      `${VIDEO_FPS} fps \u00b7 ${sound} \u00b7 30 sec max`;
    return;
  }
  const mp = formatMp(video.videoWidth * video.videoHeight);
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
 * Secure export
 * ========================================================================= */

async function lockAndDownload(blob, metadata, label) {
  const existingKey = await getDigicamDeviceKey({ create: false });
  if (!existingKey) {
    showToast('No encryption key loaded. Go to Key file panel to generate or import one.', true);
    return null;
  }

  const { blob: locked } = await encryptDigicamBlob(blob, metadata, (progress) => {
    setBusy(true, `Encrypting ${label}\u2026 ${Math.round(progress * 100)}%`);
  });
  const filename = `digicam-${stampSlug()}${DIGICAM_SECURE_EXTENSION}`;

  const canShare = navigator.canShare && navigator.share;
  if (canShare) {
    const file = new File([locked], filename, { type: DIGICAM_SECURE_MIME });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Save encrypted photo' });
        showToast(`Saved \u00b7 ${formatBytes(locked.size)}`);
        return locked;
      } catch (err) {
        if (err.name === 'AbortError') {
          showToast('Save cancelled.');
          return locked;
        }
      }
    }
  }

  downloadBlobAsFile(locked, filename);
  showToast(`Saved \u00b7 ${formatBytes(locked.size)}`);
  return locked;
}

function downloadBlobAsFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function secureSaveError(error) {
  switch (error?.code) {
    case 'ORIGIN_REQUIRED':
    case 'INSECURE_CONTEXT':
      return 'Secure save needs the same localhost or HTTPS address every time.';
    case 'KEY_STORAGE_UNAVAILABLE':
    case 'KEY_STORAGE_UNSUPPORTED':
    case 'KEY_STORAGE_FAILED':
    case 'KEY_STORAGE_BLOCKED':
    case 'KEY_INVALID':
      return error.message;
    case 'CRYPTO_UNAVAILABLE':
      return 'This browser cannot create the required AES-256 device lock.';
    case 'MEDIA_TOO_LARGE':
    case 'INVALID_MEDIA':
      return error.message;
    default:
      return 'Secure save failed. No plaintext file was downloaded.';
  }
}

function openVideoOutput({
  blob,
  mime,
  w,
  h,
  duration,
  hasAudio,
  kind = 'video',
  name,
  unlocked = false,
}) {
  clearVideoOutput();
  clearMotion();
  state.sheet = null;
  state.full = null;
  state.preview = null;
  state.draft = null;
  syncSheetUi();
  const ext = kind === 'animation' ? 'gif' : mime.includes('mp4') ? 'mp4' : 'webm';
  const sourceName = name || `${kind === 'animation' ? 'motion' : 'video'}-${stampSlug()}`;
  const url = URL.createObjectURL(blob);
  state.video = {
    blob, url, mime, ext, kind, w, h, duration, hasAudio: Boolean(hasAudio), name: sourceName,
  };
  state.sourceName = sourceName;
  state.sourceBytes = blob.size;
  document.body.dataset.mediaKind = kind;

  if (kind === 'animation') {
    ui.animationPreview.src = url;
  } else {
    ui.videoPreview.src = url;
    ui.videoPreview.load();
  }
  stopCamera();
  setMode('video');
  updateVideoMeta();
  const label = kind === 'animation' ? 'Animated sheet' : 'Video';
  showToast(
    `${unlocked ? 'Unlocked' : `${label} ready`} \u00b7 ` +
    `${formatClock(duration)} \u00b7 ${formatBytes(blob.size)}`,
  );
}

function clearVideoOutput() {
  if (ui.videoPreview) {
    ui.videoPreview.pause();
    ui.videoPreview.removeAttribute('src');
    ui.videoPreview.load();
  }
  if (ui.animationPreview) ui.animationPreview.removeAttribute('src');
  if (state.video?.url) URL.revokeObjectURL(state.video.url);
  state.video = null;
  delete document.body.dataset.mediaKind;
  syncVideoPlaybackUi();
}

function updateVideoMeta() {
  if (!state.video) {
    ui.videoMeta.textContent = '';
    ui.videoSummary.textContent = '';
    return;
  }
  const video = state.video;
  const format = video.ext.toUpperCase();
  const sound = video.kind === 'animation'
    ? 'animated sheet'
    : video.hasAudio ? 'mono microphone' : 'silent';
  ui.videoMeta.innerHTML =
    `<strong>${video.w} \u00d7 ${video.h}</strong> \u00b7 ${format} \u00b7 ` +
    `${formatClock(video.duration)} \u00b7 ${formatBytes(video.blob.size)}`;
  const fps = video.kind === 'animation' ? MOTION_FPS : VIDEO_FPS;
  ui.videoSummary.innerHTML =
    `<span><strong>${formatClock(video.duration)}</strong> running time</span>` +
    `<span><strong>${fps} fps</strong> filtered LCD</span>` +
    `<span><strong>${format}</strong> \u00b7 ${sound}</span>`;
  const isAnimation = video.kind === 'animation';
  ui.videoPanelTitle.textContent = isAnimation ? 'Animated sheet' : 'Video';
  ui.videoRetakeBtn.hidden = isAnimation;
  ui.videoHint.textContent = isAnimation
    ? 'This GIF is decrypted only in memory. Save writes an encrypted .digicam file that only opens on this device.'
    : 'The low-light look is baked into every frame. Clips run at 15 fps for up to 30 seconds. Save encrypts the video for this device before downloading.';
}

async function playVideoOutput() {
  if (!state.video || state.video.kind !== 'video') return;
  try {
    await ui.videoPreview.play();
  } catch (err) {
    ui.videoPlayToggle.checked = false;
    showToast('Playback could not start. Tap the video and try again.', true);
    console.error(err);
  }
}

function pauseVideoOutput() {
  ui.videoPreview.pause();
}

function toggleVideoOutput() {
  if (!state.video || state.video.kind !== 'video') return;
  if (ui.videoPreview.paused || ui.videoPreview.ended) {
    if (ui.videoPreview.ended) ui.videoPreview.currentTime = 0;
    playVideoOutput();
  } else {
    pauseVideoOutput();
  }
}

function syncVideoPlaybackUi() {
  const playing = Boolean(
    state.video?.kind === 'video'
    && !ui.videoPreview.paused
    && !ui.videoPreview.ended,
  );
  ui.videoPlayToggle.checked = playing;
  ui.videoWrap.classList.toggle('is-playing', playing);
  ui.videoScreenAction.setAttribute(
    'aria-label',
    playing ? 'Pause recorded video' : 'Play recorded video',
  );
}

async function downloadVideo() {
  const video = state.video;
  if (!video) return;

  ui.downloadBtn.disabled = true;
  setBusy(true, `Preparing ${video.kind === 'animation' ? 'GIF' : 'video'} save\u2026`);
  try {
    const storedName = video.name.toLowerCase().endsWith(`.${video.ext}`)
      ? video.name
      : `${video.name}-digicam.${video.ext}`;
    await lockAndDownload(
      video.blob,
      {
        kind: video.kind,
        mime: video.mime,
        name: storedName,
        w: video.w,
        h: video.h,
        duration: video.duration,
        hasAudio: video.hasAudio,
      },
      video.kind === 'animation' ? 'GIF' : 'video',
    );
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
  } catch (error) {
    showToast(secureSaveError(error), true);
    console.error(error);
  } finally {
    setBusy(false);
    ui.downloadBtn.disabled = state.mode !== 'video' || !state.video;
  }
}

async function download() {
  if (state.mode === 'video') {
    await downloadVideo();
    return;
  }
  if (!hasImage()) return;
  const { w, h } = outputSize('full');

  const heavy = w * h > 10e6 ? ', this may take a while' : '';
  ui.downloadBtn.disabled = true;
  setBusy(true, `Rendering ${w}\u00d7${h}${heavy}\u2026`);
  await nextFrame();

  try {
    const out = renderOutput('full');
    const isPng = state.format === 'png';
    const blob = await toBlob(out, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 1);
    if (!blob) throw new Error('encode failed');

    setBusy(true, 'Preparing image save\u2026');
    await lockAndDownload(
      blob,
      {
        kind: 'image',
        mime: isPng ? 'image/png' : 'image/jpeg',
        name: `${state.sourceName}-digicam.${isPng ? 'png' : 'jpg'}`,
        w,
        h,
      },
      'image',
    );

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
    showToast(
      err instanceof DigicamSecureError
        ? secureSaveError(err)
        : 'Image rendering failed. Try JPEG, or a smaller image.',
      true,
    );
    console.error(err);
  } finally {
    setBusy(false);
    ui.downloadBtn.disabled = false;
  }
}

/**
 * The second output. Same sheet, same paper, same date — the cuts move.
 *
 * Composition happens here rather than at develop time so the GIF follows the
 * paper you picked afterwards, and it costs a millisecond a frame.
 */
async function downloadGif() {
  if (!state.motion) return;

  const wasPlaying = state.playing;
  stopPlayback();

  const scratch = document.createElement('canvas');
  const sample = motionFrame(0, scratch);
  const w = sample.width;
  const h = sample.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });

  ui.gifBtn.disabled = true;
  setBusy(true, `Writing the GIF \u00b7 ${w}\u00d7${h}\u2026`);
  await nextFrame();

  try {
    const bytes = await encodeGif({
      width: w,
      height: h,
      count: MOTION_FRAMES,
      delay: MOTION_STEP,
      getFrame: (i) => {
        motionFrame(i, scratch);
        return ctx.getImageData(0, 0, w, h);
      },
      onProgress: (done) => {
        setBusy(true, `Writing the GIF \u00b7 ${w}\u00d7${h} \u00b7 ${Math.round(done * 100)}%`);
      },
    });

    const gif = new Blob([bytes], { type: 'image/gif' });
    setBusy(true, 'Preparing GIF save\u2026');
    await lockAndDownload(
      gif,
      {
        kind: 'animation',
        mime: 'image/gif',
        name: `${state.sourceName}-digicam.gif`,
        w,
        h,
        duration: MOTION_SECONDS * 1000,
      },
      'GIF',
    );
  } catch (err) {
    showToast(
      err instanceof DigicamSecureError
        ? secureSaveError(err)
        : 'The GIF could not be written.',
      true,
    );
    console.error(err);
  } finally {
    setBusy(false);
    ui.gifBtn.disabled = !state.motion;
    if (wasPlaying) startPlayback();
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

/** Swaps which of the four stage views is on screen and retitles the actions. */
function setMode(mode) {
  if (mode !== 'editor') stopPlayback();
  if (mode !== 'video') pauseVideoOutput();
  state.mode = mode;
  document.body.dataset.mode = mode;
  ui.dropzone.classList.toggle('is-active', mode === 'empty');
  ui.viewer.classList.toggle('is-active', mode === 'editor');
  ui.cameraView.classList.toggle('is-active', mode === 'camera');
  ui.videoView.classList.toggle('is-active', mode === 'video');

  ui.downloadBtn.disabled = mode !== 'editor' && !(mode === 'video' && state.video);
  ui.gifBtn.disabled = mode !== 'editor' || !state.motion;
  // Adjustments apply to the viewfinder too, so resetting them is useful there.
  ui.resetBtn.disabled = mode === 'empty' || mode === 'video';
  ui.foldVideo.hidden = mode !== 'video';
  ui.foldAdjustments.hidden = mode === 'video';
  ui.foldDate.hidden = mode === 'video';
  ui.foldExport.hidden = mode === 'video';
  syncSheetUi();

  const camFull = ui.cameraBtn.querySelector('.label-full');
  const camShort = ui.cameraBtn.querySelector('.label-short');
  if (mode === 'camera') {
    if (camFull) camFull.textContent = 'Close camera';
    if (camShort) camShort.textContent = 'Close';
  } else if (mode === 'video' && state.video?.kind === 'video') {
    if (camFull) camFull.textContent = 'Record another';
    if (camShort) camShort.textContent = 'Retake';
  } else {
    if (camFull) camFull.textContent = 'Use camera';
    if (camShort) camShort.textContent = 'Camera';
  }

  const saveFull = ui.downloadBtn.querySelector('.label-full');
  const saveShort = ui.downloadBtn.querySelector('.label-short');
  if (saveFull) saveFull.textContent = 'Secure save';
  if (saveShort) saveShort.textContent = 'Save';
  if (mode !== 'camera') ui.camReadout.textContent = '';
  updateOsdSpec();
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
  updateOsdSpec();
  if (!hasImage()) { ui.meta.textContent = ''; return; }
  const { w, h } = outputSize('full');

  if (state.sheet) {
    ui.meta.innerHTML =
      `<strong>${SHEET_CUTS} cuts \u00b7 ${SHEET_COLS} \u00d7 ${SHEET_CUTS / SHEET_COLS} sheet</strong> \u00b7 ` +
      `prints ${w} \u00d7 ${h} \u00b7 ${state.paper} paper`;
    return;
  }

  const src = state.sourceBytes ? ` \u00b7 source ${formatBytes(state.sourceBytes)}` : '';
  const scaled = state.preview.w < w ? ' \u00b7 preview downscaled, export is full size' : '';
  ui.meta.innerHTML =
    `<strong>${w} \u00d7 ${h}</strong> \u00b7 ${formatMp(w * h)} MP${src}${scaled}`;
}

/**
 * The size counter on the OSD, read off whatever the camera is actually
 * holding: the frame coming from the sensor while the viewfinder is open, the
 * size a save would write once there is a photo. FINE is the quality flag these
 * cameras printed beside it, and it is the only half that was ever fixed — the
 * number used to say 2.0M no matter what was on the screen.
 */
function updateOsdSpec() {
  if (state.mode === 'camera' && camera.videoMode && ui.camCanvas.width) {
    ui.osdSpec.textContent = `${ui.camCanvas.width}W MOV`;
    return;
  }
  if (state.mode === 'video' && state.video) {
    ui.osdSpec.textContent =
      `${state.video.w}W ${state.video.kind === 'animation' ? 'GIF' : 'MOV'}`;
    return;
  }

  let px = 0;
  if (state.mode === 'camera' && camera.video?.videoWidth) {
    px = camera.video.videoWidth * camera.video.videoHeight;
  } else if (state.mode === 'editor' && hasImage()) {
    const { w, h } = outputSize('full');
    px = w * h;
  }
  ui.osdSpec.textContent = px ? `${formatMp(px)}M FINE` : 'FINE';
}

/** 0.9, 2.1, 12 — a decimal only while it is still telling you something. */
function formatMp(px) {
  const mp = px / 1e6;
  return mp >= 10 ? String(Math.round(mp)) : mp.toFixed(1);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
  toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), isError ? 4500 : 3200);
}

/* --- events -------------------------------------------------------------- */

function wireEvents() {
  ui.pickBtn.addEventListener('click', () => ui.fileInput.click());
  ui.dropzone.addEventListener('click', () => ui.fileInput.click());
  ui.dzPickBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.fileInput.click();
  });

  // Keep the app's only disk-write path behind the authenticated lock. This
  // blocks the browser's accidental "Save image/video as" context menu; it is
  // not presented as DRM, since screenshots and a controlled browser remain
  // outside a web page's security boundary.
  for (const surface of [
    ui.preview,
    ui.original,
    ui.camCanvas,
    ui.videoPreview,
    ui.animationPreview,
  ]) {
    surface.addEventListener('contextmenu', (event) => event.preventDefault());
    surface.addEventListener('dragstart', (event) => event.preventDefault());
  }

  wireCamera();

  ui.fileInput.addEventListener('change', () => {
    loadFiles(ui.fileInput.files);
    ui.fileInput.value = '';
  });

  // Key file import wiring.
  const keyFileInput = document.getElementById('keyFileInput');
  keyFileInput?.addEventListener('change', () => {
    if (keyFileInput.files?.length) handleKeyFileImport(keyFileInput.files[0]);
    keyFileInput.value = '';
  });

  // Key management from settings panel.
  document.getElementById('generateKeyBtn')?.addEventListener('click', handleGenerateNewKey);
  document.getElementById('exportKeyBtn')?.addEventListener('click', exportKeyToFile);
  document.getElementById('importKeyBtn')?.addEventListener('click', () => {
    keyFileInput?.click();
  });

  updateKeyStatus();

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
    const files = e.dataTransfer?.files;
    if (files?.length) loadFiles(files);
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
  ui.gifBtn.addEventListener('click', downloadGif);

  ui.playToggle.addEventListener('change', () => {
    if (ui.playToggle.checked) startPlayback();
    else stopPlayback();
  });

  ui.videoPlayToggle.addEventListener('change', () => {
    if (ui.videoPlayToggle.checked) playVideoOutput();
    else pauseVideoOutput();
  });
  ui.videoScreenAction.addEventListener('click', toggleVideoOutput);
  ui.videoPreview.addEventListener('click', toggleVideoOutput);
  for (const event of ['play', 'pause', 'ended']) {
    ui.videoPreview.addEventListener(event, syncVideoPlaybackUi);
  }

  document.addEventListener('keydown', (e) => {
    if (state.mode !== 'camera' || e.repeat) return;
    if (e.key === ' ' || e.key === 'Enter') {
      if (e.target.closest('input, select, textarea, button')) return;
      e.preventDefault();
      if (booth.active) return;
      if (camera.videoMode) {
        if (camera.recording) stopVideoRecording();
        else startVideoRecording();
      } else {
        capture();
      }
    } else if (e.key === 'Escape') {
      if (camera.recording) {
        stopVideoRecording();
        return;
      }
      // Mid-run, Escape belongs to the sequence before it belongs to the camera.
      if (booth.active) {
        cancelBooth();
        return;
      }
      stopCamera();
      setMode(restingMode());
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

  ui.papers?.addEventListener('click', (e) => {
    const btn = e.target.closest('.paper');
    if (!btn || !state.sheet) return;
    state.paper = btn.dataset.paper;
    syncSheetUi();
    drawSheetOriginal();
    updateMeta();
    requestPreview();
  });

  wireCompareDrag();
}

function wireCamera() {
  const toggleCamera = () => {
    if (state.mode === 'camera') {
      if (camera.recording) {
        stopVideoRecording();
        return;
      }
      stopCamera();
      setMode(restingMode());
    } else {
      startCamera(camera.deviceId, {
        videoMode: state.mode === 'video' && state.video?.kind === 'video',
      });
    }
  };

  ui.cameraBtn.addEventListener('click', toggleCamera);

  // The action dock is hidden in camera mode, so the viewfinder carries its own exit.
  el('camCloseBtn')?.addEventListener('click', toggleCamera);

  ui.dzCameraBtn.addEventListener('click', (e) => {
    // The dropzone behind this button opens the file picker.
    e.stopPropagation();
    startCamera(undefined, { videoMode: false });
  });

  ui.dzVideoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openVideoCamera();
  });

  ui.dzBoothBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openBooth();
  });

  ui.shutterBtn.addEventListener('click', () => {
    if (camera.videoMode) {
      if (camera.recording) stopVideoRecording();
      else startVideoRecording();
    } else {
      capture();
    }
  });

  ui.boothBtn.addEventListener('click', () => {
    if (booth.active) cancelBooth();
    else startBooth();
  });

  ui.camMirror.addEventListener('change', () => {
    camera.mirror = ui.camMirror.checked;
  });

  ui.camVideo.addEventListener('change', () => {
    if (camera.recording) return;
    startCamera(camera.deviceId, { videoMode: ui.camVideo.checked });
  });

  ui.camFiltered.addEventListener('change', () => {
    camera.filtered = ui.camFiltered.checked;
  });

  ui.camDevice.addEventListener('change', () => {
    startCamera(ui.camDevice.value, { videoMode: camera.videoMode });
  });

  ui.videoRetakeBtn.addEventListener('click', openVideoCamera);

  // Never keep a camera open in a tab the user has left.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.mode === 'camera') {
      if (camera.recording) {
        stopVideoRecording();
        showToast('Recording stopped when the tab was hidden.');
        return;
      }
      stopCamera();
      setMode(restingMode());
      showToast('Camera closed while the tab was hidden.');
    } else if (document.hidden && state.mode === 'video') {
      pauseVideoOutput();
    }
  });

  window.addEventListener('pagehide', () => {
    pauseVideoOutput();
    stopCamera();
  });
}

function wireCompareDrag() {
  let dragging = false;
  let pending = null;  // a touch that has not declared itself a drag yet

  const moveTo = (clientX) => {
    const rect = ui.preview.getBoundingClientRect();
    if (!rect.width) return;
    setSplit(((clientX - rect.left) / rect.width) * 100);
  };

  const begin = (e) => {
    dragging = true;
    pending = null;
    moveTo(e.clientX);
    ui.canvasWrap.setPointerCapture?.(e.pointerId);
  };

  const end = () => {
    dragging = false;
    pending = null;
  };

  ui.canvasWrap.addEventListener('pointerdown', (e) => {
    if (!hasImage() || !ui.compareToggle.checked) return;

    // On a phone the photo fills the top of the screen, so a touch landing on it
    // is more often the start of a scroll than of a comparison. Wait for sideways
    // movement before taking the gesture; the divider itself is unambiguous.
    if (e.pointerType === 'touch' && !e.target.closest('.compare-handle')) {
      pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    begin(e);
    e.preventDefault();
  });

  ui.canvasWrap.addEventListener('pointermove', (e) => {
    if (dragging) {
      moveTo(e.clientX);
      return;
    }
    if (!pending || e.pointerId !== pending.id) return;
    const dx = e.clientX - pending.x;
    const dy = e.clientY - pending.y;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) begin(e);
  });

  ui.canvasWrap.addEventListener('pointerup', end);
  // Fired when the page takes the gesture over to scroll.
  ui.canvasWrap.addEventListener('pointercancel', end);
}

/* --- boot ---------------------------------------------------------------- */

buildControls();
wireEvents();
syncSheetUi();
syncCameraCaptureUi();
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
    pauseVideoOutput();
    // Powering down must not leave the camera running behind the overlay.
    if (state.mode === 'camera') {
      stopCamera();
      setMode(restingMode());
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
