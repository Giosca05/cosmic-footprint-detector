/*
 * build-worker.js: elaborazione dei settori in un Web Worker (riproiezione, fondo cielo, allineamento fine, mediana temporale,
 * differenze, dati per il PING e moto proprio). Tutto il calcolo pesante e' qui: il thread principale pensa solo al disegno.
 *
 * Messaggi in ingresso:
 *   {type:"frame", sk, key, width, height, data, wcs}      un ritaglio del settore `sk` (copiato una volta sola)
 *   {type:"clear"}                                          dimentica basi/shift/stelle di riferimento (cambio opzioni)
 *   {type:"drop", sk} | {type:"reset"}                      libera un settore / tutto
 *   {type:"build", id, sk, ra, dec, outN, fov, bg, smooth, matched, refKey, groups:[{det, keys:[...]}], drift, pxScale}
 * Risposta a "build": {id, groups:[{det, keys, n, cov, cnt, need, sigma, raw, diff, denom}], trackArrays, aligned, shifts, noRef, drifters}
 */
importScripts("wcs.js", "align.js", "detect.js", "drift.js");

const FR = new Map();          // "sk|key" -> {width,height,data,wcs, proj, base, shift}
const SEC = new Map();         // sk -> {refPeaks}

function medianOf(values, n) {
  const a = values.slice(0, n).sort(function (x, y) { return x - y; });
  return n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Toglie il fondo cielo: mediana di blocchi 12x12 px interpolata (bilineare) e sottratta. */
function smoothSubtract(a, N) {
  const B = 12, g = Math.ceil(N / B), m = new Float32Array(g * g).fill(NaN), buf = [];
  for (let by = 0; by < g; by++) for (let bx = 0; bx < g; bx++) {
    buf.length = 0;
    for (let y = by * B; y < Math.min(N, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(N, (bx + 1) * B); x++) { const v = a[y * N + x]; if (isFinite(v)) buf.push(v); }
    if (buf.length >= 12) m[by * g + bx] = medianOf(buf, buf.length);
  }
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = Math.max(0, Math.min(g - 1, (x + 0.5) / B - 0.5)), fy = Math.max(0, Math.min(g - 1, (y + 0.5) / B - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(g - 1, x0 + 1), y1 = Math.min(g - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    let sw = 0, sv = 0;
    [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]].forEach(function (c) {
      const v = m[c[1] * g + c[0]]; if (isFinite(v) && c[2] > 0) { sw += c[2]; sv += c[2] * v; }
    });
    out[y * N + x] = sw ? sv / sw : 0;
  }
  for (let i = 0; i < N * N; i++) a[i] -= out[i];
}

/** Filtro gaussiano separabile (sigma in pixel), in place, che ignora i NaN. */
function gaussSmooth(a, N, sigma) {
  const R = Math.max(1, Math.ceil(2.5 * sigma)), k = [];
  for (let i = -R; i <= R; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const tmp = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? tmp : a, dst = pass ? a : tmp;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const c = a === src ? a[y * N + x] : tmp[y * N + x];
      if (!isFinite(c)) { dst[y * N + x] = NaN; continue; }
      let sw = 0, sv = 0;
      for (let i = -R; i <= R; i++) {
        const xx = pass ? x : x + i, yy = pass ? y + i : y;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const v = src[yy * N + xx]; if (isFinite(v)) { sw += k[i + R]; sv += k[i + R] * v; }
      }
      dst[y * N + x] = sv / sw;
    }
  }
}

function baseOf(P, f) {
  if (!f.base) {
    if (!f.proj) f.proj = reproject(f, { ra: P.ra, dec: P.dec }, P.outN, P.fov);
    f.base = Float32Array.from(f.proj);
    if (P.bg) smoothSubtract(f.base, P.outN);
  }
  return f.base;
}

/** Allineamento fine sulle stelle del fotogramma di riferimento (stessa esposizione in tutti i settori). */
function alignFrames(P, st, frames, raw, N, out) {
  const rf = FR.get(P.sk + "|" + P.refKey);
  if (!rf) { out.noRef = true; return; }
  const stars = function (a) { const sg = robustSigma([a]); return refinePeaks(a, N, findPeaks([a], N, sg, 6)); };
  if (!st.refPeaks) st.refPeaks = stars(baseOf(P, rf));
  for (let k = 0; k < raw.length; k++) {
    const f = frames[k];
    if (f.key === P.refKey) continue;
    if (!f.shift) f.shift = matchShift(st.refPeaks, stars(raw[k]));
    if (f.shift.n >= 4) { raw[k] = shiftImage(raw[k], N, f.shift.dx, f.shift.dy); out.aligned++; out.shifts.push(Math.hypot(f.shift.dx, f.shift.dy)); }
  }
}

function prepGroup(P, st, frames, N, out) {
  const size = N * N;
  const raw = frames.map(function (f) { return Float32Array.from(baseOf(P, f)); });
  alignFrames(P, st, frames, raw, N, out);
  if (P.smooth > 0) raw.forEach(function (a) { gaussSmooth(a, N, P.smooth); });
  const n = raw.length;
  const cnt = new Uint8Array(size);
  raw.forEach(function (a) { for (let i = 0; i < size; i++) if (isFinite(a[i])) cnt[i]++; });
  const need = Math.max(1, Math.ceil(0.6 * n));
  let cov = 0; for (let i = 0; i < size; i++) if (cnt[i] >= need) cov++;
  raw.forEach(function (a) { for (let i = 0; i < size; i++) if (cnt[i] < need) a[i] = NaN; });
  if (cov < size * 0.05) return null;
  const g = { n: n, cov: cov / size, cnt: cnt, need: need, raw: raw, diff: null, denom: null, sigma: 1 };
  if (n >= 3) {
    const med = new Float32Array(size), col = new Array(n);
    for (let i = 0; i < size; i++) {
      let c = 0;
      for (let k = 0; k < n; k++) { const v = raw[k][i]; if (isFinite(v)) col[c++] = v; }
      med[i] = c ? medianOf(col, c) : NaN;
    }
    const d0 = raw.map(function (a) { const d = new Float32Array(size); for (let i = 0; i < size; i++) d[i] = a[i] - med[i]; return d; });
    const s0 = robustSigma(d0);
    const denom = new Float32Array(size);
    for (let i = 0; i < size; i++) denom[i] = Math.sqrt(s0 * s0 + Math.pow(0.4 * Math.max(0, med[i]), 2));
    const diff = d0.map(function (d) { const z = new Float32Array(size); for (let i = 0; i < size; i++) z[i] = d[i] / denom[i]; return z; });
    g.sigma = robustSigma(diff); g.denom = denom; g.diff = diff;
    diff.forEach(function (d) { for (let i = 0; i < size; i++) if (!isFinite(d[i]) && isFinite(med[i])) d[i] = 0; });
  }
  return g;
}

/** Fotometria d'apertura (raggio 2.5 px, fondo = mediana della corona 4-7 px) in (x, y); NaN se mancano troppi pixel. Ritorna la somma netta (unita' dell'immagine). */
function apPhot(a, N, x, y) {
  const R = 2.5, r1 = 4, r2 = 7, ring = [];
  let sum = 0, nap = 0, ntot = 0;
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < r2 || yi < r2 || xi >= N - r2 || yi >= N - r2) return NaN;
  for (let j = -r2; j <= r2; j++) for (let i = -r2; i <= r2; i++) {
    const d = Math.hypot(xi + i - x, yi + j - y), v = a[(yi + j) * N + xi + i];
    if (d <= R) { ntot++; if (isFinite(v)) { sum += v; nap++; } }
    else if (d >= r1 && d <= r2 && isFinite(v)) ring.push(v);
  }
  if (nap < 0.8 * ntot || ring.length < 20) return NaN;
  return sum - medianOf(ring, ring.length) * nap;
}

/** Spettro a 6 bande di un oggetto in moto: flusso (mJy) misurato in ciascun rivelatore SPHEREx lungo la traiettoria misurata. */
function sedOf(P, groups, r) {
  const xl = r.xs[r.xs.length - 1], yl = r.ys[r.ys.length - 1], tl = r.t0 + Math.max.apply(null, r.ts);
  const sr = Math.pow(P.pxScale / 206264.806, 2), APC = 1.25;          // angolo solido del pixel (sr); correzione d'apertura approssimata
  const out = [];
  groups.forEach(function (g) {
    const fl = [];
    for (let k = 0; k < g.raw.length; k++) {
      const t = g.mjd[k], x = xl + r.vx * (t - tl), y = yl + r.vy * (t - tl);
      const v = apPhot(g.raw[k], P.outN, x, y);
      if (isFinite(v)) fl.push(v * sr * 1e9 * APC);                      // MJy/sr * sr = MJy -> mJy
    }
    if (fl.length < 2) { out.push({ det: g.det, flux: NaN, err: 0, n: fl.length, tried: g.raw.length, x0: xl + r.vx * (g.mjd[0] - tl), y0: yl + r.vy * (g.mjd[0] - tl), xl: xl, yl: yl, vx: r.vx }); return; }
    const m = medianOf(fl, fl.length), mad = medianOf(fl.map(function (v) { return Math.abs(v - m); }), fl.length);
    out.push({ det: g.det, flux: m, err: Math.max(1.4826 * mad, 1e-6) / Math.sqrt(fl.length), n: fl.length });
  });
  return out;
}

function build(P) {
  const N = P.outN, size = N * N;
  let st = SEC.get(P.sk); if (!st) { st = { refPeaks: null }; SEC.set(P.sk, st); }
  const out = { id: P.id, groups: [], trackArrays: [], aligned: 0, shifts: [], noRef: false, drifters: null };
  const times = [];
  P.groups.forEach(function (gr) {
    const frames = gr.keys.map(function (k) { return FR.get(P.sk + "|" + k); }).filter(Boolean);
    if (!frames.length) return;
    const g = prepGroup(P, st, frames, N, out);
    if (!g) return;
    g.det = gr.det; g.keys = gr.keys; g.mjd = gr.mjd;
    out.groups.push(g);
  });
  // dati per il PING: differenze di TUTTI i rivelatori, in unita' sigma
  out.groups.forEach(function (g) {
    g.tracks = 0;
    if (!g.diff) return;
    const inv = 1 / (g.sigma || 1);
    g.diff.forEach(function (d) {
      const z = new Float32Array(size);
      for (let i = 0; i < size; i++) z[i] = d[i] * inv;
      if (P.matched) { gaussSmooth(z, N, P.matched); const sg = robustSigma([z]); for (let i = 0; i < size; i++) z[i] /= sg; }
      out.trackArrays.push(z);
    });
  });
  // moto proprio lento: ogni rivelatore da solo, poi consistenza tra rivelatori
  if (P.drift) {
    const per = [];
    out.groups.forEach(function (g) {
      if (g.raw.length < 4) return;
      const span = Math.max.apply(null, g.mjd) - Math.min.apply(null, g.mjd);
      per.push({ det: g.det, span: span, res: findDrifters(g.raw, N, g.mjd, { pxScale: P.pxScale, all: true, minFrames: 4 }) });
    });
    out.dbgPer = per.map(function (d) { return { det: d.det, span: d.span, n: d.res.length, near: d.res.filter(function (r) { return Math.hypot(r.x - 47.5, r.y - 47.5) < 8; }).map(function (r) { return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), vx: r.vx, vy: r.vy, sp: Math.hypot(r.vx, r.vy) * 365 * P.pxScale, z: r.z, n: r.n, drift: r.drift }; }) }; });
    out.drifters = combineDetectors(per, { pxScale: P.pxScale });
    (out.drifters || []).slice(0, 6).forEach(function (r) { try { r.sed = sedOf(P, out.groups, r); } catch (e) { r.sed = null; } });
  }
  return out;
}

onmessage = function (e) {
  const m = e.data;
  try {
    if (m.type === "frame") {
      FR.set(m.sk + "|" + m.key, { key: m.key, width: m.width, height: m.height, data: m.data, wcs: m.wcs, proj: null, base: null, shift: null });
    } else if (m.type === "clear") {
      FR.forEach(function (f) { f.base = null; f.shift = null; });
      SEC.forEach(function (s) { s.refPeaks = null; });
    } else if (m.type === "drop") {
      const pre = m.sk + "|";
      Array.from(FR.keys()).forEach(function (k) { if (k.indexOf(pre) === 0) FR.delete(k); });
      SEC.delete(m.sk);
    } else if (m.type === "reset") {
      FR.clear(); SEC.clear();
    } else if (m.type === "build") {
      const r = build(m), tr = [];
      r.groups.forEach(function (g) {
        tr.push(g.cnt.buffer);
        g.raw.forEach(function (a) { tr.push(a.buffer); });
        if (g.diff) g.diff.forEach(function (a) { tr.push(a.buffer); });
        if (g.denom) tr.push(g.denom.buffer);
      });
      r.trackArrays.forEach(function (a) { tr.push(a.buffer); });
      postMessage(r, tr);
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.stack || err) });
  }
};
