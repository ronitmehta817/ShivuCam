/* ===========================================================================
 * gif.js — a GIF89a encoder, just enough of one
 *
 * The booth prints two things: a sheet, and the same sheet moving. GIF is the
 * one animation a browser can write without a library and everything else can
 * play afterwards, so it is written by hand here. Nothing in this app talks to
 * the network, and a CDN for the sake of an animation would end that.
 *
 * Three things keep the file sendable:
 *
 *   One palette for the whole animation, cut from a sample of the frames.
 *   Per frame, only the rectangle that changed is written.
 *   Inside that rectangle, every pixel equal to the one before it is written as
 *   transparent, which is what gives LZW the long runs it lives on.
 *
 * The last one is only worth anything because the sensor noise is seeded: a
 * still corner of a room comes out bit-identical frame after frame, so it costs
 * almost nothing after the first. Crawling noise would have made this file
 * pointless and the animation ugly at the same time.
 * ========================================================================= */

const GIF_COLORS = 255;      // 0..254 are colours
const GIF_TRANSPARENT = 255; // the last slot is kept for "unchanged"

/** Grows on demand; a 3 second sheet lands somewhere in the low megabytes. */
class ByteWriter {
  constructor(size = 1 << 18) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }

  need(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v) { this.need(1); this.buf[this.len++] = v & 255; }

  u16(v) {
    this.need(2);
    this.buf[this.len++] = v & 255;
    this.buf[this.len++] = (v >> 8) & 255;
  }

  ascii(s) {
    this.need(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i);
  }

  block(src, from, to) {
    const n = to - from;
    this.need(n);
    this.buf.set(src.subarray(from, to), this.len);
    this.len += n;
  }

  done() { return this.buf.slice(0, this.len); }
}

/* --- palette -------------------------------------------------------------- */

/**
 * Median cut over a 15-bit histogram. Colours are counted at 5 bits a channel,
 * which is as fine as a 256 entry table can pay for and small enough that the
 * whole space fits in one array.
 */
function medianCut(hist, maxColors) {
  const keys = [];
  for (let k = 0; k < hist.length; k++) if (hist[k]) keys.push(k);
  if (!keys.length) return { table: new Uint8Array(256 * 3), colors: 1 };

  const red = (k) => (k >> 10) & 31;
  const green = (k) => (k >> 5) & 31;
  const blue = (k) => k & 31;

  const measure = (start, end) => {
    let count = 0;
    let rlo = 31, rhi = 0, glo = 31, ghi = 0, blo = 31, bhi = 0;
    for (let i = start; i < end; i++) {
      const k = keys[i];
      const r = red(k), g = green(k), b = blue(k);
      count += hist[k];
      if (r < rlo) rlo = r; if (r > rhi) rhi = r;
      if (g < glo) glo = g; if (g > ghi) ghi = g;
      if (b < blo) blo = b; if (b > bhi) bhi = b;
    }
    // Weighted the way the eye is, so a box wide in green splits before a box
    // equally wide in blue.
    const spans = [(rhi - rlo) * 1.0, (ghi - glo) * 1.2, (bhi - blo) * 0.8];
    const axis = spans.indexOf(Math.max(...spans));
    return { start, end, count, axis, span: spans[axis] };
  };

  let boxes = [measure(0, keys.length)];

  while (boxes.length < maxColors) {
    // Split whichever box has the most pixels in it and room to be split.
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.end - box.start < 2 || box.span <= 0) continue;
      if (box.count > best) { best = box.count; pick = i; }
    }
    if (pick < 0) break;

    const box = boxes[pick];
    const channel = box.axis === 0 ? red : box.axis === 1 ? green : blue;
    const range = keys.slice(box.start, box.end).sort((a, b) => channel(a) - channel(b));
    for (let i = 0; i < range.length; i++) keys[box.start + i] = range[i];

    // Cut where half the pixels are behind us, not half the colours. The cut
    // starts one bucket in and stops one short: a side with no buckets in it
    // has no colour to average, and it would still cost a palette slot.
    const half = box.count / 2;
    let seen = hist[keys[box.start]];
    let cut = box.start + 1;
    while (cut < box.end - 1 && seen + hist[keys[cut]] <= half) {
      seen += hist[keys[cut]];
      cut++;
    }

    boxes.splice(pick, 1, measure(box.start, cut), measure(cut, box.end));
  }

  const table = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let n = 0, r = 0, g = 0, b = 0;
    if (box.end <= box.start) return;
    for (let j = box.start; j < box.end; j++) {
      const k = keys[j];
      const weight = hist[k];
      n += weight;
      // Bucket centre: 5 bits back up to 8.
      r += (red(k) * 255 / 31) * weight;
      g += (green(k) * 255 / 31) * weight;
      b += (blue(k) * 255 / 31) * weight;
    }
    table[i * 3] = Math.round(r / n);
    table[i * 3 + 1] = Math.round(g / n);
    table[i * 3 + 2] = Math.round(b / n);
  });

  return { table, colors: boxes.length };
}

/**
 * RGBA to palette indices. The 15-bit cache means the nearest-colour search
 * runs once per distinct colour in the animation rather than once per pixel.
 */
function quantize(data, out, table, colors, cache) {
  for (let p = 0, o = 0; o < data.length; p++, o += 4) {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache[key];
    if (idx < 0) {
      let bestDist = Infinity;
      for (let c = 0; c < colors; c++) {
        const dr = r - table[c * 3];
        const dg = g - table[c * 3 + 1];
        const db = b - table[c * 3 + 2];
        const dist = dr * dr * 2 + dg * dg * 4 + db * db;
        if (dist < bestDist) { bestDist = dist; idx = c; }
      }
      cache[key] = idx;
    }
    out[p] = idx;
  }
}

/* --- LZW ------------------------------------------------------------------ */

/**
 * GIF's variable-width LZW. The dictionary is a flat array indexed by
 * prefix << 8 | byte rather than a map, because this loop runs once per pixel
 * of every frame and a hash lookup there is the whole cost of an export.
 */
function lzwCompress(indices, count, writer) {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;   // 256
  const endCode = clearCode + 1;        // 257
  const dict = new Int32Array(4096 * 256);

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let prefix = -1;

  let bitBuf = 0;
  let bitCount = 0;
  const chunk = new Uint8Array(255);
  let chunkLen = 0;

  const flushChunk = () => {
    if (!chunkLen) return;
    writer.u8(chunkLen);
    writer.block(chunk, 0, chunkLen);
    chunkLen = 0;
  };

  /**
   * The width grows here, after the code is written and before the entry for
   * this step is added, because a decoder is always one entry behind an encoder
   * — it cannot finish a table entry until it has seen the code that follows.
   * Growing on the encoder's own count instead widens the codes one step early
   * and every byte after that reads as garbage.
   */
  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      chunk[chunkLen++] = bitBuf & 255;
      if (chunkLen === 255) flushChunk();
      bitBuf >>= 8;
      bitCount -= 8;
    }
    if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
  };

  writer.u8(minCodeSize);
  emit(clearCode);

  for (let i = 0; i < count; i++) {
    const px = indices[i];
    if (prefix < 0) { prefix = px; continue; }

    const key = (prefix << 8) | px;
    const found = dict[key];
    if (found) { prefix = found - 1; continue; }

    emit(prefix);
    if (next < 4096) {
      dict[key] = next + 1;
      next++;
    } else {
      emit(clearCode);
      dict.fill(0);
      codeSize = minCodeSize + 1;
      next = endCode + 1;
    }
    prefix = px;
  }

  if (prefix >= 0) emit(prefix);
  emit(endCode);
  if (bitCount > 0) {
    chunk[chunkLen++] = bitBuf & 255;
    if (chunkLen === 255) flushChunk();
  }
  flushChunk();
  writer.u8(0);
}

/* --- the file ------------------------------------------------------------- */

/**
 * Frames are pulled one at a time through `getFrame(i)` rather than handed over
 * as an array: a three second sheet is forty megabytes of ImageData if it is
 * all held at once, and none of it is needed twice.
 *
 * @param {object}   spec
 * @param {number}   spec.width
 * @param {number}   spec.height
 * @param {number}   spec.count       how many frames
 * @param {Function} spec.getFrame    (i) => ImageData
 * @param {number}   spec.delay       ms per frame, rounded to GIF's 10ms grid
 * @param {Function} [spec.onProgress] (0..1) between frames
 * @returns {Promise<Uint8Array>}
 */
async function encodeGif({ width, height, count, getFrame, delay, onProgress }) {
  const pixels = width * height;

  // Palette from a spread of frames rather than the first one, or a sheet that
  // starts dark and ends bright would be quantised for the dark half only.
  const hist = new Uint32Array(32768);
  const samples = Math.min(count, 6);
  for (let s = 0; s < samples; s++) {
    const frame = getFrame(Math.floor((s * (count - 1)) / Math.max(1, samples - 1)));
    const d = frame.data;
    for (let o = 0; o < d.length; o += 8) {
      hist[((d[o] >> 3) << 10) | ((d[o + 1] >> 3) << 5) | (d[o + 2] >> 3)]++;
    }
    if (onProgress) onProgress((s / samples) * 0.15);
    await new Promise((r) => setTimeout(r, 0));
  }

  const { table, colors } = medianCut(hist, GIF_COLORS);
  const cache = new Int16Array(32768).fill(-1);

  const writer = new ByteWriter();
  writer.ascii('GIF89a');
  writer.u16(width);
  writer.u16(height);
  writer.u8(0xf7);  // global table, 8 bit colour, 256 entries
  writer.u8(0);     // background index
  writer.u8(0);     // square pixels
  writer.block(table, 0, 768);

  // Netscape 2.0: loop forever.
  writer.u8(0x21); writer.u8(0xff); writer.u8(0x0b);
  writer.ascii('NETSCAPE2.0');
  writer.u8(0x03); writer.u8(0x01); writer.u16(0); writer.u8(0);

  const cs = Math.max(2, Math.round(delay / 10));
  let current = new Uint8Array(pixels);
  let previous = null;
  const patch = new Uint8Array(pixels);

  for (let i = 0; i < count; i++) {
    quantize(getFrame(i).data, current, table, colors, cache);

    let left = 0, top = 0, w = width, h = height;
    let source = current;

    if (previous) {
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0, p = 0; y < height; y++) {
        for (let x = 0; x < width; x++, p++) {
          if (current[p] === previous[p]) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      if (maxX < 0) {
        // Nothing moved. One transparent pixel holds the frame on screen for
        // its share of the time and costs a dozen bytes.
        left = 0; top = 0; w = 1; h = 1;
        patch[0] = GIF_TRANSPARENT;
        source = patch;
      } else {
        left = minX; top = minY;
        w = maxX - minX + 1;
        h = maxY - minY + 1;
        let q = 0;
        for (let y = minY; y <= maxY; y++) {
          const row = y * width;
          for (let x = minX; x <= maxX; x++) {
            const p = row + x;
            patch[q++] = current[p] === previous[p] ? GIF_TRANSPARENT : current[p];
          }
        }
        source = patch;
      }
    }

    writer.u8(0x21); writer.u8(0xf9); writer.u8(0x04);
    writer.u8(0x05);  // leave the frame in place, transparency on
    writer.u16(cs);
    writer.u8(GIF_TRANSPARENT);
    writer.u8(0);

    writer.u8(0x2c);
    writer.u16(left); writer.u16(top); writer.u16(w); writer.u16(h);
    writer.u8(0);     // no local table, not interlaced

    lzwCompress(source, w * h, writer);

    if (!previous) previous = new Uint8Array(pixels);
    const swap = previous;
    previous = current;
    current = swap;

    if (onProgress) onProgress(0.15 + ((i + 1) / count) * 0.85);
    await new Promise((r) => setTimeout(r, 0));
  }

  writer.u8(0x3b);
  return writer.done();
}
