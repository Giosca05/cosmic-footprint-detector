/*
 * align.js: allineamento fine tra fotogrammi gia' riportati sulla stessa griglia (dopo wcs.js).
 * Il WCS di ogni esposizione ha errori di frazioni di pixel: si correggono "agganciando" le stelle
 * (picchi) di ogni fotogramma a quelle di un fotogramma di RIFERIMENTO. Funzioni PURE (usabili in Node).
 *   refinePeaks(a, N, peaks)        centroide 3x3 -> posizione sub-pixel
 *   matchShift(refPeaks, peaks)     spostamento {dx,dy,n} piu' votato (istogramma delle differenze)
 *   shiftImage(a, N, dx, dy)        nuovo[y][x] = a[y+dy][x+dx] (bilineare)
 * Convenzione: se una stella e' in (x,y) nel riferimento e in (x+dx, y+dy) nel fotogramma,
 * shiftImage(fotogramma, N, dx, dy) la riporta in (x,y).
 */
(function (root) {
  function refinePeaks(a, N, peaks) {
    return peaks.map(function (p) {
      let sw = 0, sx = 0, sy = 0, mn = Infinity;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const v = a[(p.y + j) * N + p.x + i]; if (isFinite(v) && v < mn) mn = v; }
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const v = a[(p.y + j) * N + p.x + i]; if (!isFinite(v)) continue;
        const w = v - mn; sw += w; sx += w * (p.x + i); sy += w * (p.y + j);
      }
      return sw > 0 ? { x: sx / sw, y: sy / sw, z: p.z } : { x: p.x, y: p.y, z: p.z };
    });
  }

  function matchShift(ref, pk, opts) {
    opts = opts || {};
    const R = opts.range || 6, B = 0.5, side = Math.round(2 * R / B) + 1, hist = new Float32Array(side * side);
    const refTop = ref.slice().sort(function (a, b) { return b.z - a.z; }).slice(0, 70);
    const pkTop = pk.slice().sort(function (a, b) { return b.z - a.z; }).slice(0, 70);
    const pairs = [];
    refTop.forEach(function (r) { pkTop.forEach(function (p) {
      const dx = p.x - r.x, dy = p.y - r.y;
      if (Math.abs(dx) <= R && Math.abs(dy) <= R) { pairs.push([dx, dy]); hist[Math.round((dy + R) / B) * side + Math.round((dx + R) / B)]++; }
    }); });
    let best = -1, bi = 0, bj = 0;
    for (let j = 1; j < side - 1; j++) for (let i = 1; i < side - 1; i++) {
      let s = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) s += hist[(j + b) * side + i + a];
      if (s > best) { best = s; bi = i; bj = j; }
    }
    const cx = bi * B - R, cy = bj * B - R;
    let sx = 0, sy = 0, n = 0;
    pairs.forEach(function (d) { if (Math.hypot(d[0] - cx, d[1] - cy) < 0.9) { sx += d[0]; sy += d[1]; n++; } });
    return n >= (opts.minVotes || 4) ? { dx: sx / n, dy: sy / n, n: n } : { dx: 0, dy: 0, n: 0 };
  }

  function shiftImage(a, N, dx, dy) {
    const out = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const sx = x + dx, sy = y + dy;
      if (!(sx >= 0 && sx <= N - 1 && sy >= 0 && sy <= N - 1)) { out[y * N + x] = NaN; continue; }
      const x0 = Math.min(N - 2, Math.floor(sx)), y0 = Math.min(N - 2, Math.floor(sy)), fx = sx - x0, fy = sy - y0, i = y0 * N + x0;
      const p = a[i], q = a[i + 1], r = a[i + N], s = a[i + N + 1];
      out[y * N + x] = (isFinite(p) && isFinite(q) && isFinite(r) && isFinite(s))
        ? (p * (1 - fx) + q * fx) * (1 - fy) + (r * (1 - fx) + s * fx) * fy : NaN;
    }
    return out;
  }

  const api = { refinePeaks: refinePeaks, matchShift: matchShift, shiftImage: shiftImage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== "undefined" ? window : globalThis);
