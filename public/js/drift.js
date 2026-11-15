/*
 * drift.js: rilevatore di MOTO PROPRIO (oggetti lenti, es. stella di Barnard ~10"/anno ~ 1.7 px/anno).
 * Funzioni PURE (nessun DOM). Il rilevatore di tracce (detect.js) cerca oggetti che SALTANO tra
 * un'immagine e l'altra; qui invece si segue il CENTROIDE delle stelle luminose nel tempo e si cerca
 * chi deriva in modo lineare rispetto alle altre stelle (che fanno da riferimento: l'allineamento
 * le tiene ferme). Un oggetto e' segnalato solo se la sua deriva e' un'anomalia statistica
 * rispetto alla popolazione di stelle del campo, quindi gli errori di allineamento non contano.
 *
 * Input: arrays = immagini di UN rivelatore, allineate e senza fondo (Float32Array N*N, NaN = no dati);
 *        times = MJD di ogni immagine. Uscita: [{x, y, vx, vy, drift, z, n, snr, xs, ys, ts}] (px, px/giorno).
 */
(function (root) {
  const R = 3;                                   // raggio (px) della finestra del centroide

  /** Centroide pesato (solo pixel positivi) attorno a (x0,y0); null se il segnale e' debole. */
  function centroid(a, N, x0, y0, noise) {
    let cx = x0, cy = y0, flux = 0;
    for (let it = 0; it < 3; it++) {
      let sw = 0, sx = 0, sy = 0, n = 0, fin = 0, tot = 0;
      const ix = Math.round(cx), iy = Math.round(cy);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = ix + dx, y = iy + dy;
        if (x < 0 || y < 0 || x >= N || y >= N || dx * dx + dy * dy > R * R) continue;
        tot++;
        const v = a[y * N + x];
        if (!isFinite(v)) continue;              // pixel mancante (bordo del rivelatore o stella satura): si salta
        fin++;
        if (v > 0) { sw += v; sx += v * x; sy += v * y; n++; }
      }
      if (sw <= 0 || fin < 0.7 * tot) return null;   // troppi pixel mancanti: centroide inaffidabile
      cx = sx / sw; cy = sy / sw; flux = sw;
    }
    return { x: cx, y: cy, flux: flux };
  }

  /** Regressione lineare pesata y = a + b*t; restituisce pendenza, errore sulla pendenza e residuo rms. */
  function fitLine(t, y, w) {
    let sw = 0, st = 0, sy = 0, stt = 0, sty = 0;
    for (let i = 0; i < t.length; i++) { sw += w[i]; st += w[i] * t[i]; sy += w[i] * y[i]; stt += w[i] * t[i] * t[i]; sty += w[i] * t[i] * y[i]; }
    const d = sw * stt - st * st;
    if (d <= 0) return null;
    const b = (sw * sty - st * sy) / d, a = (sy - b * st) / sw;
    let chi = 0; for (let i = 0; i < t.length; i++) chi += w[i] * Math.pow(y[i] - a - b * t[i], 2);
    const dof = Math.max(1, t.length - 2), s2 = Math.max(1, chi / dof);       // errori rialzati se il fit e' scarso
    return { a: a, b: b, sb: Math.sqrt(s2 * sw / d), rms: Math.sqrt(chi / sw) };
  }

  /** Minimi quadrati pesati di q[key] ~ c0 + c1*u + c2*v; restituisce [c0,c1,c2] o null. */
  function affineFit(P, key) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    P.forEach(function (q) {
      const r = [1, q.u, q.v];
      for (let i = 0; i < 3; i++) { b[i] += q.w * r[i] * q[key]; for (let j = 0; j < 3; j++) A[i][j] += q.w * r[i] * r[j]; }
    });
    const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    if (Math.abs(det) < 1e-9) return null;
    const out = [];
    for (let c = 0; c < 3; c++) {                                                  // regola di Cramer
      const M = A.map(function (row, i) { const r = row.slice(); r[c] = b[i]; return r; });
      out.push((M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det);
    }
    return out;
  }

  /** Valore del campo affine c in (rx, ry); se non c'e' il fit (poche stelle) 0. */
  function corr(c, r, half) { return c ? c[0] + c[1] * (r.x - half) / half + c[2] * (r.y - half) / half : 0; }

  /**
   * Pendenza di Theil-Sen (mediana delle pendenze tra coppie con >5 giorni di distanza) + MAD dei residui.
   * g = gruppo (rivelatore/banda) di ogni misura: si usano SOLO coppie dello stesso gruppo, cosi' le differenze costanti tra bande
   * (centroide che dipende dal colore, blend) spariscono; l'intercetta e' per gruppo.
   */
  function theilSen(t, y, g) {
    const sl = [];
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if ((!g || g[i] === g[j]) && Math.abs(t[j] - t[i]) > 5) sl.push((y[j] - y[i]) / (t[j] - t[i]));
    if (sl.length < 4) return null;                                               // servono almeno 2 epoche con piu' immagini
    const b = median(sl);
    const off = {};
    (g || t.map(function () { return 0; })).forEach(function (k, i) { (off[k] = off[k] || []).push(y[i] - b * t[i]); });
    Object.keys(off).forEach(function (k) { off[k] = median(off[k]); });
    const res = y.map(function (v, i) { return Math.abs(v - b * t[i] - off[g ? g[i] : 0]); });
    return { b: b, a: 0, mad: 1.4826 * median(res), sl: sl.length };
  }

  function median(v) { const s = v.slice().sort(function (p, q) { return p - q; }); return s.length ? s[s.length >> 1] : 0; }


  /**
   * Un moto proprio vero e' COERENTE: (1) lineare nel tempo (immagini raggruppate in epoche, stacchi > 30 giorni: la posizione lungo la
   * direzione del moto avanza in modo regolare) e (2) uguale in rivelatori/bande INDIPENDENTI (un blend o un centroide che cambia col
   * colore esiste in una banda sola). Se manca la baseline o ci sono pochi gruppi la prova non e' possibile e si accetta.
   */
  function linearMotion(s, mvx, mvy) {
    const vx = s.vx - mvx, vy = s.vy - mvy, v = Math.hypot(vx, vy);
    if (v <= 0) return false;
    const ux = vx / v, uy = vy / v, n = s.ts.length, g = s.gs || s.ts.map(function () { return 0; });
    const p = s.ts.map(function (_, i) { return s.xs[i] * ux + s.ys[i] * uy; });
    // (2) pendenza (lungo la direzione del moto) in ogni gruppo con baseline: deve concordare con quella globale
    const groups = {};
    p.forEach(function (pi, i) { (groups[g[i]] = groups[g[i]] || []).push(i); });
    let gOk = 0, gTot = 0;
    Object.keys(groups).forEach(function (k) {
      const ix = groups[k], sl = [];
      for (let a = 0; a < ix.length; a++) for (let b = a + 1; b < ix.length; b++) { const dt = s.ts[ix[b]] - s.ts[ix[a]]; if (Math.abs(dt) > 30) sl.push((p[ix[b]] - p[ix[a]]) / dt); }
      if (sl.length < 3) return;
      gTot++;
      const r = median(sl) / v;
      if (r > 0.4 && r < 1.8) gOk++;
    });
    if (gTot >= 3 && gOk < Math.ceil(0.6 * gTot)) return false;
    // (1) epoche: posizioni (tolti gli scarti costanti di gruppo) devono avanzare in modo regolare
    const off = {};
    Object.keys(groups).forEach(function (k) { off[k] = median(groups[k].map(function (i) { return p[i] - v * s.ts[i]; })); });
    const idx = s.ts.map(function (_, i) { return i; }).sort(function (a, b) { return s.ts[a] - s.ts[b]; });
    const ep = [];
    idx.forEach(function (i) {
      const last = ep[ep.length - 1], q = p[i] - off[g[i]];
      if (last && s.ts[i] - last.t[last.t.length - 1] <= 30) { last.t.push(s.ts[i]); last.p.push(q); }
      else ep.push({ t: [s.ts[i]], p: [q] });
    });
    const E = ep.map(function (e) { return { t: median(e.t), p: median(e.p) }; });
    if (E.length < 3) return true;
    let ok = 0, tot = 0;
    for (let k = 1; k < E.length; k++) {
      const dt = E[k].t - E[k - 1].t, dp = E[k].p - E[k - 1].p;
      if (dt < 10) continue;
      tot++;
      const ratio = dp / (v * dt);
      if (ratio > 0.4 && ratio < 1.8) ok++;
    }
    return tot === 0 || ok === tot;
  }

  /**
   * opts: minFrames (6), minDrift (0.8 px totali sul periodo), minSnr (10: luminosita' della stella),
   *       zMin (6: anomalia rispetto alle altre stelle), all (debug: restituisce tutte le stelle), sigmaCen (errore del centroide a SNR=1, px).
   */
  function findDrifters(arrays, N, times, opts) {
    opts = opts || {};
    const minFrames = opts.minFrames || 6, minDrift = opts.minDrift || 0.8, zMin = opts.zMin || 8, minSnr = opts.minSnr || 10;
    const sigCen = opts.sigmaCen || 1.2;
    const grp = opts.groups || null;                                           // id del rivelatore di ogni immagine (stesso ordine di arrays)
    // limite fisico: nessuna stella ha un moto proprio > ~10.4"/anno (Barnard): derive piu' grandi sono errori di misura
    let maxDrift = Infinity;
    const n = arrays.length;
    if (n < minFrames) return [];
    const t0 = Math.min.apply(null, times), span = Math.max.apply(null, times) - t0;
    if (opts.pxScale) maxDrift = (opts.maxPmArcsecYr || 13.5) / opts.pxScale * span / 365;       // px (Barnard = 10.4"/anno e' il record: tolleranza fino a 13.5 per l'errore di misura)
    if (span < 20) return [];                                                    // senza una baseline lunga non c'e' moto proprio misurabile
    // immagine media = dove cercare le stelle luminose
    const mean = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) { let s = 0, c = 0; for (let k = 0; k < n; k++) { const v = arrays[k][i]; if (isFinite(v)) { s += v; c++; } } mean[i] = c > n / 2 ? s / c : NaN; }
    const noise = (function () { const v = []; for (let i = 0; i < N * N; i += 3) if (isFinite(mean[i])) v.push(mean[i]); const m = median(v); return Math.max(1e-9, 1.4826 * median(v.map(function (x) { return Math.abs(x - m); }))); })();
    // candidati: massimi locali luminosi, distanti tra loro (evita doppioni)
    const cand = [];
    for (let y = R; y < N - R; y++) for (let x = R; x < N - R; x++) {
      const v = mean[y * N + x];
      if (!isFinite(v) || v < minSnr * noise) continue;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) { const w = mean[(y + dy) * N + x + dx]; if ((dx || dy) && isFinite(w) && w > v) { ok = false; break; } }
      if (ok) cand.push({ x: x, y: y, v: v });
    }
    cand.sort(function (p, q) { return q.v - p.v; });
    // 1) centroide di ogni stella luminosa in ogni immagine (indice k = immagine)
    const raw = [];
    cand.slice(0, 60).forEach(function (c) {
      if (raw.some(function (s) { return Math.hypot(s.x0 - c.x, s.y0 - c.y) < 5; })) return;
      const cx = new Array(n).fill(NaN), cy = new Array(n).fill(NaN), cs = new Array(n).fill(0);
      let cnt = 0;
      for (let k = 0; k < n; k++) {
        const ce = centroid(arrays[k], N, c.x, c.y, noise);
        if (!ce) continue;
        const snr = ce.flux / (noise * 4);                                       // SNR approssimato della finestra
        if (snr < 4) continue;
        cx[k] = ce.x; cy[k] = ce.y; cs[k] = snr; cnt++;
      }
      if (cnt >= minFrames) raw.push({ x0: c.x, y0: c.y, cx: cx, cy: cy, cs: cs, snr: c.v / noise });
    });
    if (raw.length < 3) return [];
    // 2) errore di allineamento residuo di ogni immagine = campo di spostamento AFFINE (traslazione + rotazione/scala/shear) comune
    //    a tutte le stelle: si stima in modo robusto (IRLS) e si toglie. Un moto proprio vero resta un outlier rispetto al campo.
    const ref = raw.map(function (s) { return { x: median(s.cx.filter(isFinite)), y: median(s.cy.filter(isFinite)) }; });
    const half = (N - 1) / 2;
    function solve(use) {
    const fitX = new Array(n), fitY = new Array(n);
    for (let k = 0; k < n; k++) {
      const P = [];
      raw.forEach(function (s, i) { if (use(i) && isFinite(s.cx[k])) P.push({ u: (ref[i].x - half) / half, v: (ref[i].y - half) / half, dx: s.cx[k] - ref[i].x, dy: s.cy[k] - ref[i].y, w: 1 }); });
      if (P.length < 6) { fitX[k] = null; fitY[k] = null; continue; }                  // poche stelle: niente fit affine, solo traslazione
      for (let it = 0; it < 4; it++) {
        const cx = affineFit(P, "dx"), cy = affineFit(P, "dy");
        if (!cx || !cy) break;
        fitX[k] = cx; fitY[k] = cy;
        P.forEach(function (q) { const r = Math.hypot(q.dx - (cx[0] + cx[1] * q.u + cx[2] * q.v), q.dy - (cy[0] + cy[1] * q.u + cy[2] * q.v)); q.w = 1 / (1 + Math.pow(r / 0.25, 2)); });
      }
    }
    // 3) regressione lineare sul tempo
    const stars = [];
    raw.forEach(function (s, ri) {
      const ts = [], xs = [], ys = [], ws = [], gs = [];
      for (let k = 0; k < n; k++) if (isFinite(s.cx[k])) { gs.push(grp ? grp[k] : 0); ts.push(times[k] - t0); xs.push(s.cx[k] - corr(fitX[k], ref[ri], half, 0)); ys.push(s.cy[k] - corr(fitY[k], ref[ri], half, 0)); ws.push(1 / Math.pow(sigCen / Math.sqrt(s.cs[k]) + 0.1, 2)); }
      // Theil-Sen (mediana delle pendenze tra coppie di epoche distanti): robusta ai centroidi sbagliati (stelle vicine, blend)
      const fx = theilSen(ts, xs, grp ? gs : null), fy = theilSen(ts, ys, grp ? gs : null);
      if (!fx || !fy) return;
      const e = Math.max(0.1, 1.5 * Math.hypot(fx.mad, fy.mad));                  // errore sulla deriva totale (px), con un minimo
      stars.push({ x0: s.x0, y0: s.y0, vx: fx.b, vy: fy.b, sx: e / span, sy: 0, n: ts.length, ts: ts, xs: xs, ys: ys, gs: gs, snr: s.snr, rms: Math.hypot(fx.mad, fy.mad) });
    });
    return stars;
    }
    // 1a passata: tutte le stelle. 2a passata: il campo affine si stima SOLO con le stelle ferme (le mobili, come Barnard, non
    // devono 'trascinare' la correzione e mangiarsi parte del proprio moto: prima si misurava ~9"/anno invece di 10.4).
    let stars = solve(function () { return true; });
    if (stars.length >= 8) {
      const m1x = median(stars.map(function (q) { return q.vx; })), m1y = median(stars.map(function (q) { return q.vy; }));
      const d1 = stars.map(function (q) { return Math.hypot(q.vx - m1x, q.vy - m1y) * span; });
      const med1 = median(d1), mad1 = Math.max(0.15, 1.4826 * median(d1.map(function (d) { return Math.abs(d - med1); })));
      const still = {};
      raw.forEach(function (r, i) { still[i] = true; });
      stars.forEach(function (q, j) { if ((d1[j] - med1) / mad1 > 3) { const i = raw.findIndex(function (r) { return r.x0 === q.x0 && r.y0 === q.y0; }); if (i >= 0) still[i] = false; } });
      if (Object.keys(still).filter(function (i) { return still[i]; }).length >= 6) stars = solve(function (i) { return still[i]; });
    }
    if (stars.length < 3) return [];
    // deriva comune (residuo di allineamento) e dispersione tra le stelle: un moto proprio vero e' un'anomalia
    const mvx = median(stars.map(function (s) { return s.vx; })), mvy = median(stars.map(function (s) { return s.vy; }));
    const dev = stars.map(function (s) { return Math.hypot(s.vx - mvx, s.vy - mvy) * span; });             // px accumulati sul periodo
    const md = median(dev), mad = Math.max(0.15, 1.4826 * median(dev.map(function (d) { return Math.abs(d - md); })));   // almeno 0.15 px
    const out = [];
    stars.forEach(function (s, i) {
      const sErr = Math.hypot(s.sx, s.sy) * span;                                 // errore formale sulla deriva totale
      const z = Math.min((dev[i] - md) / mad, dev[i] / Math.max(sErr, 0.05));     // deve superare sia la popolazione sia il proprio errore
      if (opts.all || (dev[i] >= minDrift && dev[i] <= maxDrift && z >= zMin && linearMotion(s, mvx, mvy))) out.push({ x: s.x0, y: s.y0, vx: s.vx - mvx, vy: s.vy - mvy, drift: dev[i], z: z, n: s.n, snr: s.snr, xs: s.xs, ys: s.ys, ts: s.ts, gs: s.gs, span: span, t0: t0 });
    });
    out.sort(function (p, q) { return q.z - p.z; });
    return out;
  }


  /** Peso di una misura di velocita' = 1/errore^2: scarto dei punti attorno alla retta (con un minimo sistematico di 0.15 px) e baseline coperta. */
  function velPrecision(r) {
    const n = r.ts.length, g = r.gs || r.ts.map(function () { return 0; });
    const grp = {};
    for (let i = 0; i < n; i++) (grp[g[i]] = grp[g[i]] || []).push(i);
    let stt = 0, stx = 0, sty = 0;
    const mt = {}, mx = {}, my = {};
    Object.keys(grp).forEach(function (k) {
      const ix = grp[k]; let a = 0, b = 0, c = 0;
      ix.forEach(function (i) { a += r.ts[i]; b += r.xs[i]; c += r.ys[i]; });
      mt[k] = a / ix.length; mx[k] = b / ix.length; my[k] = c / ix.length;
      ix.forEach(function (i) { const dt = r.ts[i] - mt[k]; stt += dt * dt; stx += dt * (r.xs[i] - mx[k]); sty += dt * (r.ys[i] - my[k]); });
    });
    if (stt <= 0) return 1e-12;
    const bx = stx / stt, by = sty / stt;
    let chi = 0;
    for (let i = 0; i < n; i++) { const k = g[i], dt = r.ts[i] - mt[k]; chi += Math.pow(r.xs[i] - mx[k] - bx * dt, 2) + Math.pow(r.ys[i] - my[k] - by * dt, 2); }
    const rms2 = chi / Math.max(1, n - Object.keys(grp).length);
    return stt / (rms2 + 0.15 * 0.15);                              // 1/sigma_v^2 con sigma_v^2 = (rms^2 + sist^2) / sum (t - tmedio)^2
  }

  /**
   * Unisce le misure dei singoli rivelatori (ognuno con il proprio allineamento e la propria banda): un moto proprio vero compare con la
   * STESSA velocita' in piu' rivelatori, un falso positivo (blend, centroide che dipende dal colore) in uno solo.
   * perDet: [{det, res, span}] con res = findDrifters(..., {all:true}) per rivelatore. Restituisce i candidati nel formato di findDrifters.
   * opts: pxScale (arcsec/px), zMin (8), maxPmArcsecYr (13.5), minDrift (0.8 px sul periodo), minN (4 misure per rivelatore).
   */
  function combineDetectors(perDet, opts) {
    opts = opts || {};
    const ps = opts.pxScale || 1, zMin = opts.zMin || 8, cap = opts.maxPmArcsecYr || 13.5, minDrift = opts.minDrift || 0.8, minN = opts.minN || 4;
    const members = [];
    perDet.forEach(function (d) { (d.res || []).forEach(function (r) { if (r.n >= minN) members.push({ det: d.det, span: d.span, r: r }); }); });
    members.sort(function (a, b) { return b.r.z - a.r.z; });
    const clusters = [];
    members.forEach(function (m) {
      const c = clusters.find(function (k) { return Math.hypot(k.x - m.r.x, k.y - m.r.y) < 2.5 && !k.dets[m.det]; });
      if (c) { c.m.push(m); c.dets[m.det] = true; } else clusters.push({ x: m.r.x, y: m.r.y, m: [m], dets: (function () { const o = {}; o[m.det] = true; return o; })() });
    });
    const out = [], nDetData = perDet.filter(function (d) { return d.res && d.res.length; }).length;
    clusters.forEach(function (c0) {
      // precisione di ogni misura (1/errore^2) e velocita' di CONSENSO: un vicino che si fonde nell'aureola in una sola banda (centroide
      // spostato) non deve trascinare la media. Si parte dalla misura con piu' compagne concordi (entro ~3"/anno o 30%), poi media pesata.
      c0.m.forEach(function (m) { m.pw = velPrecision(m.r); });
      const pws = c0.m.map(function (m) { return m.pw; }).sort(function (x, y) { return x - y; }), pcap = 3 * (pws[pws.length >> 1] || 1);
      let best0 = null;
      c0.m.forEach(function (m) {
        const tol = Math.max(2.5 / ps, 0.3 * Math.hypot(m.r.vx, m.r.vy) * 365) / 365;           // px/giorno
        const agree = c0.m.filter(function (k) { return Math.hypot(k.r.vx - m.r.vx, k.r.vy - m.r.vy) <= tol; });
        const score = agree.length + 1e-6 * agree.reduce(function (t, k) { return t + Math.min(k.pw, pcap); }, 0) / pcap;
        if (!best0 || score > best0.score) best0 = { score: score, agree: agree };
      });
      const c = { x: c0.x, y: c0.y, m: best0.agree, nAll: c0.m.length, zAll2: c0.m.reduce(function (t, m) { return t + (m.r.z >= 1 ? m.r.z * m.r.z : 0); }, 0) };
      let sw = 0, sx = 0, sy = 0;
      c.m.forEach(function (m) { const w = Math.min(m.pw, pcap); sw += w; sx += w * m.r.vx; sy += w * m.r.vy; });
      const vx = sx / sw, vy = sy / sw, v = Math.hypot(vx, vy);
      if (v <= 0) return;
      const spanMax = Math.max.apply(null, c.m.map(function (m) { return m.span; }));
      const speed = v * 365 * ps;                                         // arcsec/anno
      if (v * spanMax < minDrift || speed > cap) return;
      let ok = 0, z2 = 0, best = null, sSum = 0, sW = 0;
      c.m.forEach(function (m) {
        const proj = (m.r.vx * vx + m.r.vy * vy) / (v * v), cosang = (m.r.vx * vx + m.r.vy * vy) / (Math.hypot(m.r.vx, m.r.vy) * v || 1);
        if (proj > 0.4 && proj < 1.8 && cosang > 0.8) { sSum += Math.min(m.pw, pcap) * Math.hypot(m.r.vx, m.r.vy); sW += Math.min(m.pw, pcap); if (!best || m.r.z > best.r.z) best = m; if (m.r.z >= 1) { ok++; z2 += m.r.z * m.r.z; } }
      });
      const Z = Math.sqrt(z2);
      const single = nDetData <= 1 && c.nAll === 1;                      // un solo rivelatore con dati: nessun confronto possibile
      if (Z < (single ? zMin * 1.5 : zMin) || (!single && (ok < 2 || z2 < 0.5 * c.zAll2)) || !best) return;
      const k = sW > 0 ? (sSum / sW) / v : 1;                              // velocita' = media pesata dei moduli (le componenti rumorose non si compensano)
      const o = Object.assign({}, best.r, { vx: vx * k, vy: vy * k, z: Z, drift: v * k * spanMax, det: c.m.map(function (m) { return m.det; }).join("+"), nDet: ok });
      out.push(o);
    });
    out.sort(function (p, q) { return q.z - p.z; });
    return out;
  }

  const api = { combineDetectors: combineDetectors, linearMotion: linearMotion, findDrifters: findDrifters, centroid: centroid, fitLine: fitLine, theilSen: theilSen };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== "undefined" ? window : globalThis);
