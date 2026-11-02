/*
 * Minimal animated GIF (GIF89a) encoder: one global 256-colour palette,
 * LZW-compressed frames, infinite loop.
 *
 * Palette: the 256 most frequent colours across all frames, counted on a
 * 5-bit-per-channel histogram. Field plots are dominated by colormap colours
 * plus a few UI greys, so this keeps gradients smooth without dithering.
 */

export function encodeGif(frames: ImageData[], delayMs: number): Uint8Array {
  const { width, height } = frames[0];
  const palette = buildPalette(frames);
  const out = new ByteWriter();
  out.str('GIF89a');
  out.u16(width);
  out.u16(height);
  out.byte(0xf7); // global colour table, 8 bits per channel, 256 entries
  out.byte(0);
  out.byte(0);
  for (let i = 0; i < 256; i++) {
    const c = palette.colors[i] ?? 0;
    out.byte((c >> 16) & 255);
    out.byte((c >> 8) & 255);
    out.byte(c & 255);
  }
  // NETSCAPE2.0 application extension: loop forever.
  out.bytes([0x21, 0xff, 0x0b]);
  out.str('NETSCAPE2.0');
  out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

  const delay = Math.max(2, Math.round(delayMs / 10)); // centiseconds; browsers clamp below 2
  for (const f of frames) {
    out.bytes([0x21, 0xf9, 0x04, 0x00]);
    out.u16(delay);
    out.bytes([0x00, 0x00]);
    out.byte(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0); // no local colour table, not interlaced
    const indices = new Uint8Array(width * height);
    const d = f.data;
    for (let p = 0, o = 0; p < indices.length; p++, o += 4) indices[p] = palette.lookup(d[o], d[o + 1], d[o + 2]);
    out.byte(8); // LZW minimum code size
    lzw(indices, out);
  }
  out.byte(0x3b);
  return out.result();
}

function buildPalette(frames: ImageData[]) {
  const hist = new Uint32Array(32768);
  const key = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  for (const f of frames) {
    const d = f.data;
    for (let o = 0; o < d.length; o += 4) hist[key(d[o], d[o + 1], d[o + 2])]++;
  }
  const bins = [...hist.keys()].filter((k) => hist[k] > 0).sort((a, b) => hist[b] - hist[a]).slice(0, 256);
  // Bin centre back to 8 bits.
  const colors = bins.map((k) => {
    const r = (((k >> 10) & 31) << 3) | 4;
    const g = (((k >> 5) & 31) << 3) | 4;
    const b = ((k & 31) << 3) | 4;
    return (r << 16) | (g << 8) | b;
  });
  const cache = new Int16Array(32768).fill(-1);
  const lookup = (r: number, g: number, b: number) => {
    const k = key(r, g, b);
    if (cache[k] >= 0) return cache[k];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache[k] = best;
    return best;
  };
  return { colors, lookup };
}

// Variable-width LZW as GIF specifies it: codes start at 9 bits, grow to 12,
// then a clear code resets the table. Output goes in sub-blocks of <= 255 bytes.
function lzw(indices: Uint8Array, out: ByteWriter) {
  const CLEAR = 256;
  const EOI = 257;
  const block: number[] = [];
  let bitBuf = 0;
  let bitLen = 0;
  const emit = (code: number, size: number) => {
    bitBuf |= code << bitLen;
    bitLen += size;
    while (bitLen >= 8) {
      block.push(bitBuf & 255);
      bitBuf >>>= 8;
      bitLen -= 8;
      if (block.length === 255) {
        out.byte(255);
        out.bytes(block);
        block.length = 0;
      }
    }
  };
  let dict = new Map<number, number>();
  let next = 258;
  let size = 9;
  emit(CLEAR, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const keyed = (prefix << 8) | k;
    const hit = dict.get(keyed);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix, size);
    if (next < 4096) {
      dict.set(keyed, next++);
      // Grow when the next code to be assigned no longer fits.
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(CLEAR, size);
      dict = new Map();
      next = 258;
      size = 9;
    }
    prefix = k;
  }
  emit(prefix, size);
  emit(EOI, size);
  if (bitLen > 0) block.push(bitBuf & 255);
  if (block.length) {
    out.byte(block.length);
    out.bytes(block);
  }
  out.byte(0);
}

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private n = 0;
  private grow(extra: number) {
    if (this.n + extra <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + extra));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  byte(v: number) {
    this.grow(1);
    this.buf[this.n++] = v;
  }
  bytes(v: ArrayLike<number>) {
    this.grow(v.length);
    for (let i = 0; i < v.length; i++) this.buf[this.n++] = v[i];
  }
  u16(v: number) {
    this.byte(v & 255);
    this.byte((v >> 8) & 255);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result() {
    return this.buf.slice(0, this.n);
  }
}
