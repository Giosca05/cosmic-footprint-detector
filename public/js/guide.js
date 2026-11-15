/*
 * guide.js: modalita' DIVULGATIVA di Cosmic Footprint Detector.
 * I TESTI non stanno qui: stanno tutti in js/i18n.js (chiavi tour*_t/b, g*_t/d, exp_*),
 * in inglese e italiano, facili da modificare a mano. Qui c'e' solo la struttura.
 */
(function (root) {
  const I = root.I18N;                                   // caricato da i18n.js prima di questo file
  const T = I ? I.T : function (k) { return k; };

  /* 5 passi del tour; l'ultimo vola alla stella di Barnard. */
  const TOUR = [1, 2, 3, 4, 5].map(function (i) {
    const st = { t: T("tour" + i + "_t"), b: T("tour" + i + "_b") };
    if (i === 5) st.go = "barnard";
    return st;
  });

  /* Glossario: coppie [termine, definizione]. */
  const GLOSSARY = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (i) { return [T("g" + i + "_t"), T("g" + i + "_d")]; });

  /** Frase semplice per un rilevamento: oggetto noto, moto proprio (con analogia) o oggetto che salta. */
  function explainMotion(b) {
    if (b.known) return T("exp_known", b.known);
    if (b.drift) {
      const yrsMoon = Math.round(1800 / Math.max(b.speed, 0.01));
      return T("exp_drift", b.speed.toFixed(1), yrsMoon);
    }
    return T("exp_jump", (b.speed * 24).toFixed(0), b.count);
  }

  const api = { TOUR: TOUR, GLOSSARY: GLOSSARY, explainMotion: explainMotion };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Guide = api;
})(typeof window !== "undefined" ? window : globalThis);
