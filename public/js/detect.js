/*
 * detect.js: rilevazione di "contatti" (oggetti che cambiano) nelle immagini differenza.
 * Funzioni PURE (nessun DOM). Input: array di Float32Array outN*outN (immagine meno mediana,
 * gia' allineate). Servono sia al PING automatico sia al punteggio quando il giocatore tocca.
 *  - robustSigma: rumore stimato con la MAD (non si lascia ingannare dalle stelle).
 *  - peakSignificance: quanto e' significativo il picco vicino a (x,y), in quanti fotogrammi.
 *  - findBlips: picchi > soglia, raggruppati tra fotogrammi; scarta i "residui di allineamento"
 *    (picco positivo accanto a uno negativo = stella fissa non perfettamente sovrapposta).
 */
(function (root) {
  function robustSigma(arrays) {
    const v = [];
    for (const a of arrays) for (let i = 0; i < a.length; i += 3) if (isFinite(a[i])) v.push(a[i]);
    if (v.length < 10) return 1;
    v.sort(function (x, y) { return x - y; });
    const med = v[v.length >> 1];
    const dev = v.map(function (x) { return Math.abs(x - med); }).sort(function (x, y) { return x - y; });
    return Math.max(1e-9, 1.4826 * dev[dev.length >> 1]);
  }

  function localMax(a, n, x, y) {
    const v = a[y * n + x];
    if (!isFinite(v)) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const w = a[(y + dy) * n + x + dx];
      if (isFinite(w) && w > v) return false;
    }
    return true;
  }

  function peakSignificance(arrays, n, sigma, px, py, radius) {
    const cx = Math.round(px), cy = Math.round(py);
    let best = 0, worst = 0, frames = 0;
    for (let k = 0; k < arrays.length; k++) {
      let m = -Infinity, lo = Infinity;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const v = arrays[k][y * n + x];
        if (isFinite(v) && v > m) m = v;
        if (isFinite(v) && v < lo) lo = v;
      }
      if (isFinite(lo) && lo / sigma < worst) worst = lo / sigma;
      const z = m / sigma;
      if (z > best) best = z;
      if (z >= 5) frames++;
    }
    return { z: best, zneg: worst, frames: frames, nFrames: arrays.length };
  }

  function findBlips(arrays, n, sigma, thr, mergeRadius) {
    thr = thr || 5; mergeRadius = mergeRadius || 2.5;
    const clusters = [], negatives = [];
    for (let k = 0; k < arrays.length; k++) {
      const a = arrays[k];
      for (let y = 2; y < n - 2; y++) for (let x = 2; x < n - 2; x++) {
        const v = a[y * n + x];
        if (!isFinite(v)) continue;
        if (v > thr * sigma && localMax(a, n, x, y)) {
          let c = null;
          for (const q of clusters) if (Math.hypot(q.x - x, q.y - y) <= mergeRadius) { c = q; break; }
          if (!c) { c = { x: x, y: y, frames: new Set(), z: 0 }; clusters.push(c); }
          c.frames.add(k);
          if (v / sigma > c.z) { c.z = v / sigma; c.x = x; c.y = y; }
        } else if (v < -thr * sigma) negatives.push({ x: x, y: y });
      }
    }
    return clusters.filter(function (c) {
      return !negatives.some(function (q) { return Math.hypot(q.x - c.x, q.y - c.y) <= mergeRadius; });
    }).map(function (c) {
      const f = c.frames.size / arrays.length;
      return { x: c.x, y: c.y, z: c.z, frames: c.frames.size, fraction: f,
               kind: f >= 0.6 ? "variabile" : "transitorio" };
    }).sort(function (a, b) { return b.z - a.z; });
  }

  /** Massimi locali > thr*sigma di ogni immagine: [{k,x,y,z}]. */
  function findPeaks(arrays, n, sigma, thr) {
    const out = [];
    for (let k = 0; k < arrays.length; k++) {
      const a = arrays[k];
      for (let y = 2; y < n - 2; y++) for (let x = 2; x < n - 2; x++) {
        const v = a[y * n + x];
        if (isFinite(v) && v > thr * sigma && localMax(a, n, x, y)) out.push({ k: k, x: x, y: y, z: v / sigma });
      }
    }
    return out;
  }

  /** Posizione sub-pixel di un picco: parabola per asse sui 3 pixel centrali (precisione ~0.1-0.2 px invece di 0.5). */
  function refinePeak(a, n, x, y) {
    const c = a[y * n + x];
    const l = a[y * n + x - 1], r = a[y * n + x + 1], u = a[(y - 1) * n + x], d = a[(y + 1) * n + x];
    if (![c, l, r, u, d].every(isFinite)) return { x: x, y: y };
    const px = l - 2 * c + r, py = u - 2 * c + d;
    const dx = px < -1e-9 ? 0.5 * (l - r) / px : 0, dy = py < -1e-9 ? 0.5 * (u - d) / py : 0;
    return { x: x + Math.max(-0.5, Math.min(0.5, dx)), y: y + Math.max(-0.5, Math.min(0.5, dy)) };
  }

  /**
   * Cerca OGGETTI IN MOTO: serie di picchi in immagini diverse, allineati e percorsi a velocita'
   * costante (rispetto al TEMPO reale `times[k]`, in giorni). Cio' che resta fermo non conta:
   *  - i picchi che si ripetono nello stesso punto (< staticTol px) in immagini diverse sono
   *    sorgenti FISSE che cambiano con la lunghezza d'onda: scartati;
   *  - serve un minimo di `minN` immagini diverse, spostamento totale >= minDisp px.
   * Restituisce [{pts:[{k,x,y,z}], n, vx, vy (px/giorno), rms, z}] ordinate per qualita'.
   */
  function findTracks(peaks, times, opts) {
    opts = opts || {};
    const tol = opts.tol || 1.3, staticTol = opts.staticTol || 1.5, minN = opts.minN || 5;
    const minDisp = opts.minDisp || 2.5, maxPairDisp = opts.maxPairDisp || 24, maxPeaks = opts.maxPeaks || 150;
    // Fissa = ripetuta nello stesso punto in almeno 2 ALTRE immagini (un mover lento ne sfiora al massimo 1).
    const moving = peaks.filter(function (p) {
      const seen = new Set();
      peaks.forEach(function (q) { if (q.k !== p.k && Math.hypot(q.x - p.x, q.y - p.y) <= staticTol) seen.add(q.k); });
      return seen.size < 2;
    }).sort(function (a, b) { return b.z - a.z; }).slice(0, maxPeaks);
    const found = new Map();
    for (let i = 0; i < moving.length; i++) for (let j = 0; j < moving.length; j++) {
      const p = moving[i], q = moving[j], dt = times[q.k] - times[p.k];
      if (dt <= 1e-4) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < 1.0 || d > maxPairDisp) continue;
      const vx = (q.x - p.x) / dt, vy = (q.y - p.y) / dt, best = new Map();
      for (const r of moving) {
        const t = times[r.k] - times[p.k], e = Math.hypot(p.x + vx * t - r.x, p.y + vy * t - r.y);
        if (e <= tol && (!best.has(r.k) || e < best.get(r.k).e)) best.set(r.k, { r: r, e: e });
      }
      if (best.size < minN) continue;
      const pts = Array.from(best.values()).map(function (b) { return b.r; }).sort(function (a, b) { return a.k - b.k; });
      const key = pts.map(function (r) { return r.k + ":" + r.x + ":" + r.y; }).join("|");
      if (found.has(key)) continue;
      // adattamento lineare ai minimi quadrati e controllo dei residui
      const t0 = times[pts[0].k], n = pts.length;
      let st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
      pts.forEach(function (r) { const t = times[r.k] - t0; st += t; stt += t * t; sx += r.x; sy += r.y; stx += t * r.x; sty += t * r.y; });
      const den = n * stt - st * st; if (Math.abs(den) < 1e-12) continue;
      const fx = (n * stx - st * sx) / den, fy = (n * sty - st * sy) / den, cx = (sx - fx * st) / n, cy = (sy - fy * st) / n;
      let ss = 0; pts.forEach(function (r) { const t = times[r.k] - t0; ss += Math.pow(cx + fx * t - r.x, 2) + Math.pow(cy + fy * t - r.y, 2); });
      const rms = Math.sqrt(ss / n);
      const disp = Math.hypot(fx, fy) * (times[pts[n - 1].k] - t0);
      if (rms > 1.2 || disp < minDisp) continue;
      found.set(key, { pts: pts, n: n, vx: fx, vy: fy, rms: rms, z: pts.reduce(function (a, r) { return a + r.z; }, 0) / n });
    }
    const all = Array.from(found.values()).sort(function (a, b) { return b.n - a.n || a.rms - b.rms; });
    const used = new Set(), out = [];
    all.forEach(function (t) {
      const ids = t.pts.map(function (r) { return r.k + ":" + r.x + ":" + r.y; });
      if (ids.some(function (id) { return used.has(id); })) return;
      ids.forEach(function (id) { used.add(id); }); out.push(t);
    });
    return out;
  }

  /** Falsi allarmi attesi: stessa ricerca con i TEMPI rimescolati tra le immagini (nessun moto reale). */
  function nullTrackCount(peaks, times, trials, opts) {
    let total = 0, seed = 987654321;
    const rnd = function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let t = 0; t < trials; t++) {
      const sh = times.slice();
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = sh[i]; sh[i] = sh[j]; sh[j] = tmp; }
      total += findTracks(peaks, sh, opts).length;
    }
    return total / Math.max(1, trials);
  }

  const api = { robustSigma: robustSigma, peakSignificance: peakSignificance, findBlips: findBlips,
                findPeaks: findPeaks, refinePeak: refinePeak, findTracks: findTracks, nullTrackCount: nullTrackCount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== "undefined" ? window : globalThis);
