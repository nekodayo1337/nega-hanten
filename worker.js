// ネガ反転 — 変換の本体（Web Worker）
// 動画はこのパソコンの中だけで処理し、どこにも送らない。
// 色の計算は ffmpeg の
//   scale(bt709 tv→pc) → gbrp → crop → negate → colorlevels → pad(黒) → scale(→bt709 tv)
// と同じ式で行う（ブラウザの色変換には任せない）。

importScripts('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.min.js');

let FILE = null;
let INFO = null;
let ANALYSIS = null;
let DEBUG = false;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') {
      FILE = msg.file;
      INFO = await parseMp4(FILE);
      DEBUG = !!msg.debug;
      ANALYSIS = await analyze(FILE, INFO);
      if (msg.levels) ANALYSIS.lv = msg.levels; // 試験用：色の範囲を手で与える
      self.postMessage({ type: 'analyzed', result: publicAnalysis(INFO, ANALYSIS) });
    } else if (msg.type === 'encode') {
      const blob = await encode(FILE, INFO, ANALYSIS, msg.bitrateScale || 1);
      self.postMessage({ type: 'done', blob });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};

function post(type, data) { self.postMessage(Object.assign({ type }, data)); }

/* ---------------- MP4 / MOV の読み取り ---------------- */

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function fourcc(u8, p) {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

function* boxes(u8, dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(u8, p + 4);
    let hs = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hs = 16; }
    else if (size === 0) size = end - p;
    if (size < hs || p + size > end) break;
    yield { type, start: p, body: p + hs, end: p + size };
    p += size;
  }
}

function child(ctx, box, type, offset = 0) {
  for (const b of boxes(ctx.u8, ctx.dv, box.body + offset, box.end)) if (b.type === type) return b;
  return null;
}

function hex2(n) { return n.toString(16).padStart(2, '0'); }

async function parseMp4(file) {
  let pos = 0;
  let moov = null;
  while (pos + 8 <= file.size) {
    const h = await readBytes(file, pos, Math.min(pos + 16, file.size));
    const hdv = new DataView(h.buffer);
    let size = hdv.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = Number(hdv.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'moov') { moov = await readBytes(file, pos, pos + size); break; }
    pos += size;
  }
  if (!moov) throw new Error('このファイルは読めませんでした（MP4 か MOV の動画を選んでください）。');

  const ctx = { u8: moov, dv: new DataView(moov.buffer) };
  const root = { body: ctx.dv.getUint32(0) === 1 ? 16 : 8, end: moov.length };
  const info = { video: null, audio: null };

  for (const trak of boxes(ctx.u8, ctx.dv, root.body, root.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(ctx, trak, 'mdia'); if (!mdia) continue;
    const mdhd = child(ctx, mdia, 'mdhd');
    const hdlr = child(ctx, mdia, 'hdlr');
    const minf = child(ctx, mdia, 'minf');
    const stbl = minf && child(ctx, minf, 'stbl');
    if (!mdhd || !hdlr || !stbl) continue;
    const ver = ctx.u8[mdhd.body];
    const timescale = ctx.dv.getUint32(mdhd.body + (ver === 1 ? 20 : 12));
    const handler = fourcc(ctx.u8, hdlr.body + 8);
    const stsd = child(ctx, stbl, 'stsd');
    if (!stsd) continue;
    const entry = boxes(ctx.u8, ctx.dv, stsd.body + 8, stsd.end).next().value;
    if (!entry) continue;

    if (handler === 'vide' && !info.video) {
      const t = parseVideoEntry(ctx, entry);
      if (!t) continue;
      Object.assign(t, { timescale }, buildSamples(ctx, stbl));
      info.video = t;
    } else if (handler === 'soun' && !info.audio) {
      const t = parseAudioEntry(ctx, entry);
      if (!t) continue;
      Object.assign(t, { timescale }, buildSamples(ctx, stbl));
      info.audio = t;
    }
  }
  if (!info.video) throw new Error('動画の映像が見つかりませんでした。');
  return info;
}

function parseVideoEntry(ctx, entry) {
  const { u8, dv } = ctx;
  const width = dv.getUint16(entry.body + 24);
  const height = dv.getUint16(entry.body + 26);
  const kids = { body: entry.body + 78, end: entry.end };
  let codec = null, description = null, matrix = null;
  if (entry.type === 'avc1' || entry.type === 'avc3') {
    const avcC = child(ctx, kids, 'avcC');
    if (!avcC) return null;
    description = u8.slice(avcC.body, avcC.end);
    codec = entry.type + '.' + hex2(description[1]) + hex2(description[2]) + hex2(description[3]);
  } else if (entry.type === 'hvc1' || entry.type === 'hev1') {
    const hvcC = child(ctx, kids, 'hvcC');
    if (!hvcC) return null;
    description = u8.slice(hvcC.body, hvcC.end);
    codec = hevcCodecString(entry.type, description);
  } else {
    throw new Error('この動画の形式（' + entry.type + '）には対応していません。H.264 か HEVC の動画を選んでください。');
  }
  const colr = child(ctx, kids, 'colr');
  if (colr && fourcc(u8, colr.body) === 'nclx') matrix = dv.getUint16(colr.body + 8);
  return { codec, description, width, height, matrixCode: matrix };
}

function hevcCodecString(type, d) {
  const space = ['', 'A', 'B', 'C'][d[1] >> 6];
  const tier = (d[1] >> 5) & 1 ? 'H' : 'L';
  const profile = d[1] & 0x1f;
  let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  rev >>>= 0;
  const level = d[12];
  const cons = [d[6], d[7], d[8], d[9], d[10], d[11]];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  let s = type + '.' + space + profile + '.' + rev.toString(16) + '.' + tier + level;
  if (cons.length) s += '.' + cons.map((b) => b.toString(16)).join('.');
  return s;
}

function parseAudioEntry(ctx, entry) {
  const { u8, dv } = ctx;
  if (entry.type !== 'mp4a') return { unsupported: entry.type };
  const version = dv.getUint16(entry.body + 8);
  const channels = dv.getUint16(entry.body + 16);
  const sampleRate = dv.getUint32(entry.body + 24) >>> 16;
  const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
  const kids = { body: entry.body + 28 + extra, end: entry.end };
  let esds = child(ctx, kids, 'esds');
  if (!esds) {
    const wave = child(ctx, kids, 'wave');
    if (wave) esds = child(ctx, wave, 'esds');
  }
  if (!esds) return { unsupported: 'mp4a(esds なし)' };
  const asc = parseEsds(u8, esds.body, esds.end);
  if (!asc) return { unsupported: 'mp4a(設定なし)' };
  let aot = asc[0] >> 3;
  if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
  return { codec: 'mp4a.40.' + aot, description: asc, channels, sampleRate };
}

function parseEsds(u8, start, end) {
  let p = start + 4;
  const readDesc = () => {
    const tag = u8[p++];
    let len = 0;
    for (let i = 0; i < 4; i++) { const b = u8[p++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
    return { tag, len };
  };
  let d = readDesc();
  if (d.tag !== 3) return null;
  p += 2;
  const flags = u8[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + u8[p];
  if (flags & 0x20) p += 2;
  d = readDesc();
  if (d.tag !== 4) return null;
  p += 13;
  if (p >= end) return null;
  d = readDesc();
  if (d.tag !== 5) return null;
  return u8.slice(p, p + d.len);
}

function buildSamples(ctx, stbl) {
  const { dv } = ctx;
  const stsz = child(ctx, stbl, 'stsz');
  if (!stsz) throw new Error('この動画の中身の並びが読めませんでした。');
  const fixed = dv.getUint32(stsz.body + 4);
  const count = dv.getUint32(stsz.body + 8);
  const size = new Uint32Array(count);
  for (let i = 0; i < count; i++) size[i] = fixed || dv.getUint32(stsz.body + 12 + 4 * i);

  let chunkOffsets;
  const stco = child(ctx, stbl, 'stco');
  const co64 = child(ctx, stbl, 'co64');
  if (stco) {
    const n = dv.getUint32(stco.body + 4);
    chunkOffsets = new Float64Array(n);
    for (let i = 0; i < n; i++) chunkOffsets[i] = dv.getUint32(stco.body + 8 + 4 * i);
  } else if (co64) {
    const n = dv.getUint32(co64.body + 4);
    chunkOffsets = new Float64Array(n);
    for (let i = 0; i < n; i++) chunkOffsets[i] = Number(dv.getBigUint64(co64.body + 8 + 8 * i));
  } else throw new Error('この動画の中身の位置が読めませんでした。');

  const stsc = child(ctx, stbl, 'stsc');
  const scN = dv.getUint32(stsc.body + 4);
  const scFirst = [], scPer = [];
  for (let i = 0; i < scN; i++) {
    scFirst.push(dv.getUint32(stsc.body + 8 + 12 * i));
    scPer.push(dv.getUint32(stsc.body + 12 + 12 * i));
  }
  const offset = new Float64Array(count);
  let s = 0;
  for (let c = 0, e = 0; c < chunkOffsets.length && s < count; c++) {
    while (e + 1 < scN && scFirst[e + 1] <= c + 1) e++;
    let off = chunkOffsets[c];
    for (let k = 0; k < scPer[e] && s < count; k++, s++) { offset[s] = off; off += size[s]; }
  }

  const dts = new Float64Array(count);
  const dur = new Float64Array(count);
  const stts = child(ctx, stbl, 'stts');
  {
    const n = dv.getUint32(stts.body + 4);
    let i = 0, t = 0;
    for (let k = 0; k < n; k++) {
      const c = dv.getUint32(stts.body + 8 + 8 * k);
      const d = dv.getUint32(stts.body + 12 + 8 * k);
      for (let j = 0; j < c && i < count; j++, i++) { dts[i] = t; dur[i] = d; t += d; }
    }
  }
  const cts = new Float64Array(dts);
  const ctts = child(ctx, stbl, 'ctts');
  if (ctts) {
    const n = dv.getUint32(ctts.body + 4);
    let i = 0;
    for (let k = 0; k < n; k++) {
      const c = dv.getUint32(ctts.body + 8 + 8 * k);
      const o = dv.getInt32(ctts.body + 12 + 8 * k);
      for (let j = 0; j < c && i < count; j++, i++) cts[i] = dts[i] + o;
    }
  }
  const sync = new Uint8Array(count);
  const stss = child(ctx, stbl, 'stss');
  if (stss) {
    const n = dv.getUint32(stss.body + 4);
    for (let k = 0; k < n; k++) { const idx = dv.getUint32(stss.body + 8 + 4 * k) - 1; if (idx < count) sync[idx] = 1; }
  } else sync.fill(1);
  return { count, offset, size, dts, cts, dur, sync };
}

class ChunkReader {
  constructor(file, chunk = 16 * 1024 * 1024) { this.file = file; this.chunk = chunk; this.start = 0; this.buf = null; }
  async read(offset, size) {
    if (!this.buf || offset < this.start || offset + size > this.start + this.buf.length) {
      this.start = offset;
      this.buf = await readBytes(this.file, offset, Math.min(this.file.size, offset + Math.max(this.chunk, size)));
    }
    return this.buf.slice(offset - this.start, offset - this.start + size);
  }
}

/* ---------------- 色の計算 ---------------- */

// yo: 黒の Y の値（リミテッドは 16、フルレンジは 0）
const MAT = {
  bt709: { yo: 16, y: 1.164383, rv: 1.792741, gu: -0.213249, gv: -0.532909, bu: 2.112402,
    yr: 0.182586, yg: 0.614231, yb: 0.062007, ur: -0.100644, ug: -0.338572, ub: 0.439216, vr: 0.439216, vg: -0.398942, vb: -0.040274 },
  bt601: { yo: 16, y: 1.164383, rv: 1.596027, gu: -0.391762, gv: -0.812968, bu: 2.017232,
    yr: 0.256788, yg: 0.504129, yb: 0.097906, ur: -0.148223, ug: -0.290993, ub: 0.439216, vr: 0.439216, vg: -0.367788, vb: -0.071427 },
  // Safari はコマをフルレンジ（0〜255）に引き伸ばして渡してくる
  bt709full: { yo: 0, y: 1, rv: 1.5748, gu: -0.187324, gv: -0.468124, bu: 1.8556,
    yr: 0.2126, yg: 0.7152, yb: 0.0722, ur: -0.114572, ug: -0.385428, ub: 0.5, vr: 0.5, vg: -0.454153, vb: -0.045847 },
  bt601full: { yo: 0, y: 1, rv: 1.402, gu: -0.344136, gv: -0.714136, bu: 1.772 },
};

function pickMatrix(frame, video) {
  const cs = frame && frame.colorSpace;
  const m = cs && cs.matrix;
  let name;
  if (m === 'bt709') name = 'bt709';
  else if (m === 'bt470bg' || m === 'smpte170m') name = 'bt601';
  else if (video.matrixCode === 1) name = 'bt709';
  else if (video.matrixCode === 5 || video.matrixCode === 6) name = 'bt601';
  else name = video.height >= 720 ? 'bt709' : 'bt601';
  return cs && cs.fullRange ? name + 'full' : name;
}

// フレームの中身を Y・U・V の3枚（4:2:0）か RGBA で取り出す
async function getPlanes(frame) {
  const fmt = frame.format;
  const rect = frame.visibleRect;
  const w = rect.width, h = rect.height;
  if (!fmt) throw new Error('このブラウザでは動画のコマを読み出せませんでした。');
  const buf = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(buf);
  if (fmt === 'I420' || fmt === 'I420A') {
    return { kind: 'yuv', w, h,
      Y: buf.subarray(layout[0].offset), ys: layout[0].stride,
      U: buf.subarray(layout[1].offset), us: layout[1].stride,
      V: buf.subarray(layout[2].offset), vs: layout[2].stride };
  }
  if (fmt === 'NV12') {
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    const U = new Uint8Array(cw * ch), V = new Uint8Array(cw * ch);
    const uv = buf.subarray(layout[1].offset), st = layout[1].stride;
    for (let y = 0; y < ch; y++) {
      let si = y * st, di = y * cw;
      for (let x = 0; x < cw; x++, si += 2, di++) { U[di] = uv[si]; V[di] = uv[si + 1]; }
    }
    return { kind: 'yuv', w, h, Y: buf.subarray(layout[0].offset), ys: layout[0].stride, U, us: cw, V, vs: cw };
  }
  if (fmt === 'RGBA' || fmt === 'RGBX' || fmt === 'BGRA' || fmt === 'BGRX') {
    const bgr = fmt[0] === 'B';
    return { kind: 'rgb', w, h, D: buf.subarray(layout[0].offset), ds: layout[0].stride, bgr };
  }
  throw new Error('このブラウザが出す動画の形式（' + fmt + '）には対応していません。');
}

// 反転＋色の範囲を伸ばす表（ffmpeg の negate → colorlevels と同じ）
function makeLuts(lv) {
  const mk = (lo, hi) => {
    const t = new Float32Array(256);
    for (let x = 0; x < 256; x++) {
      const v = Math.round(((255 - x) - lo) * 255 / (hi - lo));
      t[x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return t;
  };
  return { R: mk(lv.r[0], lv.r[1]), G: mk(lv.g[0], lv.g[1]), B: mk(lv.b[0], lv.b[1]) };
}

// 1コマを変換して I420（BT.709 / リミテッドレンジ）で out に書く
function processFrame(P, out, W, H, crop, L, K, KO) {
  const cw = W >> 1, ch = H >> 1;
  const UO = W * H, VO = UO + cw * ch;
  const bx0 = crop.x >> 1, bx1 = (crop.x + crop.w) >> 1;
  const by0 = crop.y >> 1, by1 = (crop.y + crop.h) >> 1;
  const LR = L.R, LG = L.G, LB = L.B;
  const yo = K.yo;
  const yr = KO.yr, yg = KO.yg, yb = KO.yb, ur = KO.ur, ug = KO.ug, ub = KO.ub, vr = KO.vr, vg = KO.vg, vb = KO.vb;
  const oy = KO.yo;

  for (let by = 0; by < ch; by++) {
    const rowIn = by >= by0 && by < by1;
    const o0 = 2 * by * W, o1 = o0 + W;
    for (let bx = 0; bx < cw; bx++) {
      const ci = by * cw + bx;
      const x0 = 2 * bx;
      if (!rowIn || bx < bx0 || bx >= bx1) {
        out[o0 + x0] = oy; out[o0 + x0 + 1] = oy; out[o1 + x0] = oy; out[o1 + x0 + 1] = oy;
        out[UO + ci] = 128; out[VO + ci] = 128;
        continue;
      }
      let r0, g0, b0, r1, g1, b1, r2, g2, b2, r3, g3, b3;
      if (P.kind === 'yuv') {
        const Y = P.Y, ys = P.ys;
        const u = P.U[by * P.us + bx] - 128, v = P.V[by * P.vs + bx] - 128;
        const cr = K.rv * v, cg = K.gu * u + K.gv * v, cb = K.bu * u;
        const ky = K.y;
        const i0 = 2 * by * ys + x0, i1 = i0 + ys;
        let yy;
        yy = ky * (Y[i0] - yo); r0 = Math.round(yy + cr); g0 = Math.round(yy + cg); b0 = Math.round(yy + cb);
        yy = ky * (Y[i0 + 1] - yo); r1 = Math.round(yy + cr); g1 = Math.round(yy + cg); b1 = Math.round(yy + cb);
        yy = ky * (Y[i1] - yo); r2 = Math.round(yy + cr); g2 = Math.round(yy + cg); b2 = Math.round(yy + cb);
        yy = ky * (Y[i1 + 1] - yo); r3 = Math.round(yy + cr); g3 = Math.round(yy + cg); b3 = Math.round(yy + cb);
      } else {
        const D = P.D, ds = P.ds, ro = P.bgr ? 2 : 0, bo = P.bgr ? 0 : 2;
        const i0 = 2 * by * ds + x0 * 4, i1 = i0 + ds;
        r0 = D[i0 + ro]; g0 = D[i0 + 1]; b0 = D[i0 + bo];
        r1 = D[i0 + 4 + ro]; g1 = D[i0 + 5]; b1 = D[i0 + 4 + bo];
        r2 = D[i1 + ro]; g2 = D[i1 + 1]; b2 = D[i1 + bo];
        r3 = D[i1 + 4 + ro]; g3 = D[i1 + 5]; b3 = D[i1 + 4 + bo];
      }
      // 0〜255 に収めてから表を引く
      r0 = LR[r0 < 0 ? 0 : r0 > 255 ? 255 : r0]; g0 = LG[g0 < 0 ? 0 : g0 > 255 ? 255 : g0]; b0 = LB[b0 < 0 ? 0 : b0 > 255 ? 255 : b0];
      r1 = LR[r1 < 0 ? 0 : r1 > 255 ? 255 : r1]; g1 = LG[g1 < 0 ? 0 : g1 > 255 ? 255 : g1]; b1 = LB[b1 < 0 ? 0 : b1 > 255 ? 255 : b1];
      r2 = LR[r2 < 0 ? 0 : r2 > 255 ? 255 : r2]; g2 = LG[g2 < 0 ? 0 : g2 > 255 ? 255 : g2]; b2 = LB[b2 < 0 ? 0 : b2 > 255 ? 255 : b2];
      r3 = LR[r3 < 0 ? 0 : r3 > 255 ? 255 : r3]; g3 = LG[g3 < 0 ? 0 : g3 > 255 ? 255 : g3]; b3 = LB[b3 < 0 ? 0 : b3 > 255 ? 255 : b3];
      out[o0 + x0] = oy + yr * r0 + yg * g0 + yb * b0;
      out[o0 + x0 + 1] = oy + yr * r1 + yg * g1 + yb * b1;
      out[o1 + x0] = oy + yr * r2 + yg * g2 + yb * b2;
      out[o1 + x0 + 1] = oy + yr * r3 + yg * g3 + yb * b3;
      const sr = (r0 + r1 + r2 + r3) * 0.25, sg = (g0 + g1 + g2 + g3) * 0.25, sb = (b0 + b1 + b2 + b3) * 0.25;
      out[UO + ci] = 128 + ur * sr + ug * sg + ub * sb;
      out[VO + ci] = 128 + vr * sr + vg * sg + vb * sb;
    }
  }
}

// 元の画素1つを RGB（0〜255）で返す
function rgbAt(P, K, x, y, o) {
  if (P.kind === 'yuv') {
    const yy = K.y * (P.Y[y * P.ys + x] - K.yo);
    const u = P.U[(y >> 1) * P.us + (x >> 1)] - 128, v = P.V[(y >> 1) * P.vs + (x >> 1)] - 128;
    o[0] = clamp255(Math.round(yy + K.rv * v));
    o[1] = clamp255(Math.round(yy + K.gu * u + K.gv * v));
    o[2] = clamp255(Math.round(yy + K.bu * u));
  } else {
    const i = y * P.ds + x * 4;
    o[0] = P.D[i + (P.bgr ? 2 : 0)]; o[1] = P.D[i + 1]; o[2] = P.D[i + (P.bgr ? 0 : 2)];
  }
}
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/* ---------------- 調べる（黒帯と色の範囲） ---------------- */

// 仕上げ：測った色の範囲（反転後の 0.5%〜99.5%）に足す値 [下限, 上限]。
// 2026-11-08 に「かなり完璧」と決まった 8mm（Kodak 50D）の仕上がりに合わせてある。
// 赤と青の暗いほうを少し締める。
const LOOK = { r: [3, -1], g: [0, -1], b: [3, 0] };

function decoderConfig(v) {
  return { codec: v.codec, description: v.description, codedWidth: v.width, codedHeight: v.height };
}

async function analyze(file, info) {
  const v = info.video;
  if (typeof VideoDecoder === 'undefined') throw new Error('このブラウザは動画の変換に対応していません。');
  const sup = await VideoDecoder.isConfigSupported(decoderConfig(v));
  if (!sup.supported) throw new Error('このブラウザではこの動画（' + v.codec + '）を読めませんでした。');

  const keys = [];
  for (let i = 0; i < v.count; i++) if (v.sync[i]) keys.push(i);
  const N = Math.min(80, keys.length);
  const picks = [];
  for (let k = 0; k < N; k++) picks.push(keys[Math.floor((k + 0.5) * keys.length / N)]);

  let outputs = [];
  let decErr = null;
  const dec = new VideoDecoder({ output: (f) => outputs.push(f), error: (e) => { decErr = e; } });
  dec.configure(decoderConfig(v));

  const step = 4;
  const samples = [];
  let colBlack = null, rowBlack = null, W = 0, H = 0, matrixName = null;
  let previewCandidates = [];

  for (let k = 0; k < picks.length; k++) {
    const i = picks[k];
    const data = await readBytes(file, v.offset[i], v.offset[i] + v.size[i]);
    outputs = [];
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: Math.round(v.cts[i] * 1e6 / v.timescale), data }));
    await dec.flush();
    if (decErr) throw decErr;
    const frame = outputs.shift();
    outputs.forEach((f) => f.close());
    if (!frame) continue;
    if (!matrixName) matrixName = pickMatrix(frame, v);
    const K = MAT[matrixName];
    const P = await getPlanes(frame);
    if (DEBUG && k === Math.floor(picks.length / 2)) {
      const mean = (arr, stride, w, h) => { let s = 0; for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) s += arr[y * stride + x]; return s / (Math.ceil(h / 2) * Math.ceil(w / 2)); };
      post('debug', { info: {
        index: i, format: frame.format, colorSpace: frame.colorSpace && frame.colorSpace.toJSON ? frame.colorSpace.toJSON() : null,
        coded: [frame.codedWidth, frame.codedHeight], visible: frame.visibleRect && [frame.visibleRect.x, frame.visibleRect.y, frame.visibleRect.width, frame.visibleRect.height],
        display: [frame.displayWidth, frame.displayHeight], kind: P.kind,
        means: P.kind === 'yuv' ? [mean(P.Y, P.ys, P.w, P.h), mean(P.U, P.us, P.w >> 1, P.h >> 1), mean(P.V, P.vs, P.w >> 1, P.h >> 1)] : null,
        strides: P.kind === 'yuv' ? [P.ys, P.us, P.vs] : [P.ds],
        px: P.kind === 'yuv' ? Array.from({ length: 600 }, (_, j) => {
          const x = (37 + j * 977) % 1900, y = (11 + j * 613) % 1070;
          return [P.Y[y * P.ys + x], P.U[(y >> 1) * P.us + (x >> 1)], P.V[(y >> 1) * P.vs + (x >> 1)]];
        }) : null,
      } });
    }
    frame.close();
    if (!W) {
      // Safari は 1080 の動画を 1084 と報告することがあるので、ファイルに書かれた大きさで切る
      W = Math.min(P.w, v.width || P.w) & ~1; H = Math.min(P.h, v.height || P.h) & ~1;
      colBlack = new Uint16Array(W); rowBlack = new Uint16Array(H);
    }
    // 黒帯さがし：列・行ごとの明るさの平均（リミテッドは 24 未満、フルレンジは 10 未満を黒とみなす）
    const blackThr = P.kind === 'yuv' && K.yo === 0 ? 10 : 24;
    const lum = (x, y) => {
      if (P.kind === 'yuv') return P.Y[y * P.ys + x];
      const o = [0, 0, 0]; rgbAt(P, K, x, y, o); return 16 + (o[0] * 0.2126 + o[1] * 0.7152 + o[2] * 0.0722) * 219 / 255;
    };
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let y = 0; y < H; y += 4) { s += lum(x, y); n++; }
      if (s / n < blackThr) colBlack[x]++;
    }
    for (let y = 0; y < H; y++) {
      let s = 0, n = 0;
      for (let x = 0; x < W; x += 4) { s += lum(x, y); n++; }
      if (s / n < blackThr) rowBlack[y]++;
    }
    // 色の範囲用に間引いた RGB を取っておく
    const gw = Math.floor(W / step), gh = Math.floor(H / step);
    const rgb = new Uint8Array(gw * gh * 3);
    const o = [0, 0, 0];
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      rgbAt(P, K, gx * step, gy * step, o);
      const j = (gy * gw + gx) * 3; rgb[j] = o[0]; rgb[j + 1] = o[1]; rgb[j + 2] = o[2];
    }
    samples.push({ index: i, gw, gh, rgb });
    previewCandidates.push({ index: i, P, k });
    // プレビュー用は真ん中あたりの数コマだけ残す
    if (previewCandidates.length > 1) {
      const mid = picks.length / 2;
      previewCandidates.sort((a, b) => Math.abs(a.k - mid) - Math.abs(b.k - mid));
      previewCandidates = previewCandidates.slice(0, 7);
    }
    post('analyzeProgress', { done: k + 1, total: picks.length });
  }
  dec.close();
  if (!samples.length) throw new Error('動画のコマを読み出せませんでした。');

  // 黒帯：半分以上のコマで暗い列・行
  const half = samples.length / 2;
  let x0 = 0, x1 = W - 1, y0 = 0, y1 = H - 1;
  while (x0 < W && colBlack[x0] > half) x0++;
  while (x1 > x0 && colBlack[x1] > half) x1--;
  while (y0 < H && rowBlack[y0] > half) y0++;
  while (y1 > y0 && rowBlack[y1] > half) y1--;
  if (x1 - x0 < W / 4 || y1 - y0 < H / 4) { x0 = 0; x1 = W - 1; y0 = 0; y1 = H - 1; }
  const cx = (x0 + 1) & ~1, cy = (y0 + 1) & ~1;
  const crop = { x: cx, y: cy, w: ((x1 + 1 - cx) & ~1), h: ((y1 + 1 - cy) & ~1) };

  // 色の範囲：反転後の値で、全体の 0.5% と 99.5%（真っ白などの空のコマは除く）
  const inset = 12;
  const gx0 = Math.ceil((crop.x + inset) / step), gx1 = Math.floor((crop.x + crop.w - inset) / step);
  const gy0 = Math.ceil((crop.y + inset) / step), gy1 = Math.floor((crop.y + crop.h - inset) / step);
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const frameStats = [];
  for (const s of samples) {
    const fh = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let n = 0;
    for (let gy = gy0; gy < gy1; gy++) for (let gx = gx0; gx < gx1; gx++) {
      const j = (gy * s.gw + gx) * 3;
      fh[0][255 - s.rgb[j]]++; fh[1][255 - s.rgb[j + 1]]++; fh[2][255 - s.rgb[j + 2]]++; n++;
    }
    const spread = Math.max(...fh.map((h) => pct(h, n, 0.99) - pct(h, n, 0.01)));
    const blank = spread < 12;
    frameStats.push({ index: s.index, spread, blank });
    if (!blank) for (let c = 0; c < 3; c++) for (let x = 0; x < 256; x++) hist[c][x] += fh[c][x];
  }
  const total = hist[0].reduce((a, b) => a + b, 0);
  if (!total) throw new Error('映像の中身が見つかりませんでした（真っ白・真っ黒のコマしかありません）。');
  const lv = {};
  const dist = {};
  ['r', 'g', 'b'].forEach((c, ci) => {
    let lo = pct(hist[ci], total, 0.005) + LOOK[c][0], hi = pct(hist[ci], total, 0.995) + LOOK[c][1];
    if (hi - lo < 8) hi = Math.min(255, lo + 8);
    lv[c] = [lo, hi];
    dist[c] = [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.5, 0.95, 0.97, 0.98, 0.99, 0.995, 0.998, 0.999].map((p) => pct(hist[ci], total, p));
  });

  // プレビュー：中身の幅が一番あるコマ
  let best = previewCandidates[0];
  for (const c of previewCandidates) {
    const st = frameStats.find((f) => f.index === c.index);
    const bs = frameStats.find((f) => f.index === best.index);
    if (st && bs && !st.blank && st.spread > bs.spread) best = c;
  }
  const preview = makePreview(best.P, W, H, crop, lv, MAT[matrixName]);

  // 書き出しの設定
  let fps = 30;
  if (v.count > 1) {
    const span = (v.dts[v.count - 1] - v.dts[0]) / v.timescale;
    if (span > 0) fps = (v.count - 1) / span;
  }
  const duration = (v.dts[v.count - 1] + v.dur[v.count - 1] - v.dts[0]) / v.timescale;
  return { W, H, crop, lv, dist, matrixName, fps, duration, preview, frameStats };
}

function pct(h, n, p) {
  const t = n * p;
  let s = 0;
  for (let i = 0; i < 256; i++) { s += h[i]; if (s >= t) return i; }
  return 255;
}

function makePreview(P, W, H, crop, lv, K) {
  const out = new Uint8ClampedArray(W * H * 3 / 2);
  processFrame(P, out, W, H, crop, makeLuts(lv), K, MAT.bt709);
  const pw = 960, ph = Math.round(H * pw / W);
  const before = new Uint8ClampedArray(pw * ph * 4);
  const after = new Uint8ClampedArray(pw * ph * 4);
  const o = [0, 0, 0];
  const KO = MAT.bt709;
  const cw = W >> 1;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const sx = Math.min(W - 1, Math.floor(x * W / pw)), sy = Math.min(H - 1, Math.floor(y * H / ph));
    rgbAt(P, K, sx, sy, o);
    const j = (y * pw + x) * 4;
    before[j] = o[0]; before[j + 1] = o[1]; before[j + 2] = o[2]; before[j + 3] = 255;
    const yy = KO.y * (out[sy * W + sx] - 16);
    const ci = (sy >> 1) * cw + (sx >> 1);
    const u = out[W * H + ci] - 128, v = out[W * H + (W * H >> 2) + ci] - 128;
    after[j] = yy + KO.rv * v; after[j + 1] = yy + KO.gu * u + KO.gv * v; after[j + 2] = yy + KO.bu * u; after[j + 3] = 255;
  }
  return { w: pw, h: ph, before, after };
}

function publicAnalysis(info, a) {
  return {
    width: a.W, height: a.H, crop: a.crop, levels: a.lv, fps: a.fps, duration: a.duration,
    matrix: a.matrixName, codec: info.video.codec,
    audio: info.audio ? (info.audio.unsupported ? { unsupported: info.audio.unsupported } : { codec: info.audio.codec }) : null,
    preview: a.preview,
    blankFrames: a.frameStats.filter((f) => f.blank).length,
    sampleFrames: a.frameStats.length,
    dist: a.dist,
  };
}

/* ---------------- 書き出し ---------------- */

function avcLevel(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = mbs * fps;
  const table = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240],
    [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
  for (const [lvl, fs, ps] of table) if (mbs <= fs && mbps <= ps) return lvl;
  return 0x34;
}

async function pickEncoderConfig(W, H, fps, scale) {
  const level = hex2(avcLevel(W, H, fps));
  const bitrate = Math.round(Math.min(80e6, Math.max(4e6, W * H * fps * 0.28 * scale)));
  for (const profile of ['6400', '4d00', '4200']) {
    const cfg = { codec: 'avc1.' + profile + level, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch (_) { /* 次を試す */ }
  }
  throw new Error('このブラウザでは H.264 で書き出せませんでした。');
}

// 試しに黒い1コマを書き出して、エンコーダーが付ける範囲の印（フル／リミテッド）を調べる
async function encoderWritesFullRange(cfg) {
  let full = false;
  try {
    const W = cfg.width, H = cfg.height;
    const enc = new VideoEncoder({
      output: (chunk, meta) => { const cs = meta && meta.decoderConfig && meta.decoderConfig.colorSpace; if (cs && cs.fullRange) full = true; },
      error: () => {},
    });
    enc.configure(cfg);
    const buf = new Uint8Array(W * H * 3 / 2);
    buf.fill(16, 0, W * H); buf.fill(128, W * H);
    const f = new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: 0, duration: 33333,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } });
    enc.encode(f, { keyFrame: true });
    f.close();
    await enc.flush();
    enc.close();
  } catch (_) { /* 調べられないときはリミテッドとして扱う */ }
  return full;
}

async function encode(file, info, a, bitrateScale) {
  const v = info.video;
  const { W, H, crop, lv } = a;
  const K = MAT[a.matrixName];
  const L = makeLuts(lv);
  const encCfg = await pickEncoderConfig(W, H, a.fps, bitrateScale);
  // Safari は渡した映像をそのまま書き、フルレンジの印を付ける。印に合わせて渡す映像の範囲を決める
  const outFull = await encoderWritesFullRange(encCfg);
  const KO = outFull ? MAT.bt709full : MAT.bt709;

  const au = info.audio && !info.audio.unsupported ? info.audio : null;

  // 書き出した分は少しずつ受け取って並べておく（大きな1つの塊を作らないので長い動画でもメモリが足りる）
  const parts = [];
  let total = 0;
  const write = (data, position) => {
    if (position === total) { parts.push({ pos: position, data: data.slice() }); total += data.length; return; }
    if (position > total) {
      parts.push({ pos: total, data: new Uint8Array(position - total) });
      parts.push({ pos: position, data: data.slice() });
      total = position + data.length;
      return;
    }
    const end = position + data.length;
    for (const p of parts) {
      const pe = p.pos + p.data.length;
      if (pe <= position || p.pos >= end) continue;
      const s = Math.max(position, p.pos), e = Math.min(end, pe);
      p.data.set(data.subarray(s - position, e - position), s - p.pos);
    }
    if (end > total) { parts.push({ pos: total, data: data.slice(total - position) }); total = end; }
  };
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.StreamTarget({ onData: write, chunked: true, chunkSize: 16 * 1024 * 1024 }),
    video: { codec: 'avc', width: W, height: H },
    audio: au ? { codec: 'aac', numberOfChannels: au.channels, sampleRate: au.sampleRate } : undefined,
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });

  // 音声はそのまま写す。先に読んでおき、映像の進みに合わせて少しずつ入れる
  const audio = [];
  if (au) {
    const rd = new ChunkReader(file, 4 * 1024 * 1024);
    for (let i = 0; i < au.count; i++) {
      audio.push({ data: await rd.read(au.offset[i], au.size[i]),
        ts: Math.round(au.cts[i] * 1e6 / au.timescale), dur: Math.round(au.dur[i] * 1e6 / au.timescale) });
    }
  }
  let ai = 0;
  const feedAudio = (untilUs) => {
    while (ai < audio.length && audio[ai].ts <= untilUs) {
      const s = audio[ai];
      muxer.addAudioChunkRaw(s.data, 'key', s.ts, s.dur,
        ai === 0 ? { decoderConfig: { codec: au.codec, numberOfChannels: au.channels, sampleRate: au.sampleRate, description: au.description } } : undefined);
      ai++;
    }
  };

  let failure = null;
  const fail = (e) => { if (!failure) failure = e; wake(); };
  let waiters = [];
  const wake = () => { const ws = waiters; waiters = []; ws.forEach((f) => f()); };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        if (meta && meta.decoderConfig) {
          meta = { decoderConfig: Object.assign({}, meta.decoderConfig, { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: outFull } }) };
        }
        muxer.addVideoChunk(chunk, meta);
        feedAudio(chunk.timestamp + 500000);
      } catch (e) { fail(e); }
    },
    error: fail,
  });
  encoder.configure(encCfg);
  encoder.addEventListener('dequeue', wake);

  const out = new Uint8ClampedArray(W * H * 3 / 2);
  const colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: outFull };
  const gop = Math.max(1, Math.round(a.fps * 2));
  let chain = Promise.resolve();
  let inflight = 0, done = 0;
  const t0 = Date.now();
  let lastPost = 0;

  const handle = async (frame) => {
    try {
      if (failure) { frame.close(); return; }
      const P = await getPlanes(frame);
      const ts = frame.timestamp, dur = frame.duration || Math.round(1e6 / a.fps);
      frame.close();
      processFrame(P, out, W, H, crop, L, K, KO);
      const vf = new VideoFrame(out, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: ts, duration: dur, colorSpace });
      encoder.encode(vf, { keyFrame: done % gop === 0 });
      vf.close();
      done++;
      const now = Date.now();
      if (now - lastPost > 250 || done === v.count) {
        lastPost = now;
        post('encodeProgress', { done, total: v.count, elapsed: now - t0 });
      }
    } catch (e) {
      fail(e);
    } finally {
      inflight--;
      wake();
    }
  };

  const decoder = new VideoDecoder({
    output: (frame) => { inflight++; chain = chain.then(() => handle(frame)); },
    error: fail,
  });
  decoder.configure(decoderConfig(v));
  decoder.addEventListener('dequeue', wake);

  const reader = new ChunkReader(file);
  for (let i = 0; i < v.count; i++) {
    while (!failure && (decoder.decodeQueueSize > 4 || encoder.encodeQueueSize > 4 || inflight > 3)) {
      await new Promise((r) => waiters.push(r));
    }
    if (failure) break;
    const data = await reader.read(v.offset[i], v.size[i]);
    decoder.decode(new EncodedVideoChunk({
      type: v.sync[i] ? 'key' : 'delta',
      timestamp: Math.round(v.cts[i] * 1e6 / v.timescale),
      duration: Math.round(v.dur[i] * 1e6 / v.timescale),
      data,
    }));
  }
  if (!failure) await decoder.flush().catch(fail);
  await chain;
  if (!failure) await encoder.flush().catch(fail);
  try { decoder.close(); } catch (_) { /* 閉じ済み */ }
  try { encoder.close(); } catch (_) { /* 閉じ済み */ }
  if (failure) throw failure;
  feedAudio(Infinity);
  muxer.finalize();
  return new Blob(parts.map((p) => p.data), { type: 'video/mp4' });
}
