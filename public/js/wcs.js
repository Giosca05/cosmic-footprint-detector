/*
 * wcs.js: geometria del cielo. Funzioni PURE (nessun DOM), usabili anche in Node per i test.
 *  - wcsFromHeader(header): legge il WCS tangente (TAN) di un ritaglio FITS, oppure null.
 *  - reproject(frame, target, outN, fovDeg): ricampiona il fotogramma su una griglia comune
 *    centrata su `target`, Nord in alto ed Est a sinistra. Cosi' tutti i fotogrammi
 *    (anche di rivelatori diversi, ruotati o con puntamento diverso) sono ALLINEATI.
 *  - skyFromOffset / offsetFromSky: da/verso scostamenti in arcsec rispetto a un centro.
 *  - fmtRA / fmtDec: formattazione sessagesimale.
 * LIMITE: la distorsione SIP (se presente nel file) non e' applicata.
 */
(function (root) {
  const D2R = Math.PI / 180;

  function wcsFromHeader(h) {
    if (!h || h.CRVAL1 === undefined || h.CRVAL2 === undefined ||
        h.CRPIX1 === undefined || h.CRPIX2 === undefined) return null;
    let cd;
    if (h.CD1_1 !== undefined && h.CD2_2 !== undefined) {
      cd = [[h.CD1_1, h.CD1_2 || 0], [h.CD2_1 || 0, h.CD2_2]];
    } else if (h.CDELT1 !== undefined && h.CDELT2 !== undefined) {
      const p = [[h.PC1_1 === undefined ? 1 : h.PC1_1, h.PC1_2 || 0],
                 [h.PC2_1 || 0, h.PC2_2 === undefined ? 1 : h.PC2_2]];
      cd = [[h.CDELT1 * p[0][0], h.CDELT1 * p[0][1]], [h.CDELT2 * p[1][0], h.CDELT2 * p[1][1]]];
    } else return null;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (!isFinite(det) || det === 0) return null;
    const inv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
    return { crval1: h.CRVAL1, crval2: h.CRVAL2, crpix1: h.CRPIX1, crpix2: h.CRPIX2, x0: Number(h.CUTX0) || 0, y0: Number(h.CUTY0) || 0, cd: cd, inv: inv, sip: sipFromHeader(h) };
  }

  /** Coefficienti SIP (distorsione ottica): A_i_j e B_i_j, oppure null se il file non ne ha. */
  function sipFromHeader(h) {
    if (!h.A_ORDER || !h.B_ORDER) return null;
    const A = [], B = [];
    Object.keys(h).forEach(function (k) {
      const m = /^([AB])_(\d+)_(\d+)$/.exec(k);
      if (m) (m[1] === "A" ? A : B).push([Number(m[2]), Number(m[3]), Number(h[k])]);
    });
    return (A.length || B.length) ? { A: A, B: B } : null;
  }
  function sipTerm(terms, u, v) { let s = 0; for (let n = 0; n < terms.length; n++) s += terms[n][2] * Math.pow(u, terms[n][0]) * Math.pow(v, terms[n][1]); return s; }

  /** Versori: c = direzione del centro, e = Est, n = Nord (coordinate cartesiane unitarie). */
  function basis(raDeg, decDeg) {
    const a = raDeg * D2R, d = decDeg * D2R;
    return {
      c: [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)],
      e: [-Math.sin(a), Math.cos(a), 0],
      n: [-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)]
    };
  }
  const dot = function (u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; };

  /** (ra,dec) del punto a (est, nord) arcsec dal centro `origin` {ra,dec}. */
  function skyFromOffset(origin, eastArcsec, northArcsec) {
    const b = basis(origin.ra, origin.dec);
    const xi = eastArcsec / 3600 * D2R, eta = northArcsec / 3600 * D2R;
    const d = [b.c[0] + xi * b.e[0] + eta * b.n[0], b.c[1] + xi * b.e[1] + eta * b.n[1], b.c[2] + xi * b.e[2] + eta * b.n[2]];
    const r = Math.hypot(d[0], d[1], d[2]);
    let ra = Math.atan2(d[1], d[0]) / D2R; if (ra < 0) ra += 360;
    return { ra: ra, dec: Math.asin(d[2] / r) / D2R };
  }

  /** Inverso: scostamento (est, nord) in arcsec di (ra,dec) rispetto a `origin`. */
  function offsetFromSky(origin, ra, dec) {
    const b = basis(origin.ra, origin.dec), p = basis(ra, dec).c, cosc = dot(p, b.c);
    return { e: dot(p, b.e) / cosc / D2R * 3600, n: dot(p, b.n) / cosc / D2R * 3600 };
  }

  function sample(f, x, y) {            // x,y in pixel 0-based; interpolazione bilineare
    const w = f.width, h = f.height;
    if (!(x >= -0.5 && x <= w - 0.5 && y >= -0.5 && y <= h - 0.5)) return NaN;
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(x))), y0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
    const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
    const d = f.data, i = y0 * w + x0;
    const a = d[i], b = d[i + 1], c = d[i + w], e = d[i + w + 1];
    if (isFinite(a) && isFinite(b) && isFinite(c) && isFinite(e)) {
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
    }
    const v = d[(fy > 0.5 ? y0 + 1 : y0) * w + (fx > 0.5 ? x0 + 1 : x0)];
    return isFinite(v) ? v : NaN;
  }

  /**
   * Ricampiona `frame` ({width,height,data,wcs}) su una griglia outN x outN larga fovDeg gradi,
   * centrata su target {ra,dec}; riga 0 = Nord, colonna 0 = Est. Senza WCS assume che il
   * ritaglio copra esattamente il campo (allineamento approssimato).
   */
  function reproject(frame, target, outN, fovDeg) {
    const out = new Float32Array(outN * outN), half = (outN - 1) / 2;
    const w = frame.wcs;
    if (!w) {
      for (let j = 0; j < outN; j++) for (let i = 0; i < outN; i++) {
        out[j * outN + i] = sample(frame, (i + 0.5) / outN * frame.width - 0.5,
                                   (outN - 1 - j + 0.5) / outN * frame.height - 0.5);
      }
      return out;
    }
    const t = basis(target.ra, target.dec), f = basis(w.crval1, w.crval2);
    const scale = fovDeg * D2R / outN;
    // La trasformazione (cielo -> pixel del fotogramma, con SIP invertito per iterazione) e' costosa (~90 us a pixel) ma LISCIA:
    // si calcola solo su una griglia grossolana (ogni K pixel d'uscita) e si interpola in modo bilineare. Errore < 0.01 px
    // (verificato in tests/js), tempo ~ K^2 volte minore: prima ogni ricostruzione di un settore costava secondi.
    const K = 6, g = Math.ceil((outN - 1) / K) + 1, gx = new Float64Array(g * g), gy = new Float64Array(g * g);
    for (let gj = 0; gj < g; gj++) {
      const j = Math.min(outN - 1, gj * K), eta = (half - j) * scale;
      for (let gi = 0; gi < g; gi++) {
        const i = Math.min(outN - 1, gi * K), xi = (half - i) * scale;
        const d = [t.c[0] + xi * t.e[0] + eta * t.n[0], t.c[1] + xi * t.e[1] + eta * t.n[1], t.c[2] + xi * t.e[2] + eta * t.n[2]];
        const cosc = dot(d, f.c);
        if (cosc <= 0) { gx[gj * g + gi] = NaN; gy[gj * g + gi] = NaN; continue; }
        const xi1 = dot(d, f.e) / cosc / D2R, eta1 = dot(d, f.n) / cosc / D2R;   // gradi
        let u = w.inv[0][0] * xi1 + w.inv[0][1] * eta1, v = w.inv[1][0] * xi1 + w.inv[1][1] * eta1;
        if (w.sip) {                        // inverso della distorsione SIP per iterazione (la correzione e' piccola)
          const U = u, V = v;
          for (let it = 0; it < 12; it++) { u = U - sipTerm(w.sip.A, u, v); v = V - sipTerm(w.sip.B, u, v); }
        }
        gx[gj * g + gi] = w.crpix1 + u - 1 - (w.x0 || 0);
        gy[gj * g + gi] = w.crpix2 + v - 1 - (w.y0 || 0);
      }
    }
    for (let j = 0; j < outN; j++) {
      const fj = j / K, j0 = Math.min(g - 2, Math.floor(fj)), tj = fj - j0;
      for (let i = 0; i < outN; i++) {
        const fi = i / K, i0 = Math.min(g - 2, Math.floor(fi)), ti = fi - i0;
        const a00 = j0 * g + i0, a01 = a00 + 1, a10 = a00 + g, a11 = a10 + 1;
        const px = (1 - tj) * ((1 - ti) * gx[a00] + ti * gx[a01]) + tj * ((1 - ti) * gx[a10] + ti * gx[a11]);
        const py = (1 - tj) * ((1 - ti) * gy[a00] + ti * gy[a01]) + tj * ((1 - ti) * gy[a10] + ti * gy[a11]);
        out[j * outN + i] = (isFinite(px) && isFinite(py)) ? sample(frame, px, py) : NaN;
      }
    }
    return out;
  }

  /** Cielo (ra, dec) del pixel 0-based (x, y) di un fotogramma, con distorsione SIP. */
  function skyFromPixel(w, x, y) {
    let u = x + (w.x0 || 0) + 1 - w.crpix1, v = y + (w.y0 || 0) + 1 - w.crpix2;
    if (w.sip) { const du = sipTerm(w.sip.A, u, v), dv = sipTerm(w.sip.B, u, v); u += du; v += dv; }
    const xi = (w.cd[0][0] * u + w.cd[0][1] * v) * D2R, et = (w.cd[1][0] * u + w.cd[1][1] * v) * D2R;
    const a0 = w.crval1 * D2R, d0 = w.crval2 * D2R, r = Math.hypot(xi, et), c = Math.atan(r);
    if (r === 0) return { ra: w.crval1, dec: w.crval2 };
    const dec = Math.asin(Math.cos(c) * Math.sin(d0) + et * Math.sin(c) * Math.cos(d0) / r);
    let ra = a0 + Math.atan2(xi * Math.sin(c), r * Math.cos(d0) * Math.cos(c) - et * Math.sin(d0) * Math.sin(c));
    ra = ((ra / D2R) % 360 + 360) % 360;
    return { ra: ra, dec: dec / D2R };
  }

  function fmtRA(raDeg) {
    const h = raDeg / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m), s = (m - mm) * 60;
    return String(hh).padStart(2, "0") + "h " + String(mm).padStart(2, "0") + "m " + s.toFixed(1).padStart(4, "0") + "s";
  }
  function fmtDec(decDeg) {
    const sg = decDeg < 0 ? "-" : "+", a = Math.abs(decDeg), dd = Math.floor(a), m = (a - dd) * 60, mm = Math.floor(m), s = (m - mm) * 60;
    return sg + String(dd).padStart(2, "0") + "° " + String(mm).padStart(2, "0") + "′ " + s.toFixed(0).padStart(2, "0") + "″";
  }

  const api = { wcsFromHeader: wcsFromHeader, reproject: reproject, skyFromOffset: skyFromOffset,
                offsetFromSky: offsetFromSky, skyFromPixel: skyFromPixel, fmtRA: fmtRA, fmtDec: fmtDec };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== "undefined" ? window : globalThis);
