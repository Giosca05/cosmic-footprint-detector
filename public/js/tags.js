/*
 * tags.js: oggetti NOTI da etichettare sull'immagine (stelle, nane brune...).
 * Funzioni PURE. Ogni missione in data/missions.json ha ra/dec a una certa epoca (ep, anno) e il moto
 * proprio (pmra = mu_alpha*cos(dec), pmdec, in mas/anno): la posizione all'epoca delle osservazioni
 * SPHEREx (~2026) si ottiene spostando la stella. Senza questo, Barnard sarebbe ~270" fuori posto.
 * Un'etichetta puo' avere uno scarto fisso (dE, dN in secondi d'arco, all'epoca ep) dall'oggetto principale.
 */
(function (root) {
  /** Posizione (ra, dec in gradi) all'anno `year` dell'oggetto m con eventuale scarto della sua etichetta. */
  function positionAt(m, tag, year) {
    const dt = year - (m.ep || 2000), cos = Math.cos(m.dec * Math.PI / 180);
    const dE = (m.pmra || 0) * dt / 1000 + (tag.dE || 0), dN = (m.pmdec || 0) * dt / 1000 + (tag.dN || 0);     // arcsec
    return { ra: m.ra + dE / 3600 / cos, dec: m.dec + dN / 3600 };
  }

  /** Elenco piatto di etichette [{id, name, kind, ra, dec, approx}] per tutte le missioni. */
  function knownTags(missions, year) {
    const out = [];
    missions.forEach(function (m) {
      (m.tags && m.tags.length ? m.tags : [{ name: m.name, kind: m.tag }]).forEach(function (t, i) {
        const p = positionAt(m, t, year);
        out.push({ id: m.id + ":" + i, mission: m.id, name: t.name, kind: t.kind || m.tag || "", ra: p.ra, dec: p.dec, approx: !!t.approx, main: i === 0 });
      });
    });
    return out;
  }

  const api = { positionAt: positionAt, knownTags: knownTags };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.keys(api).forEach(function (k) { root[k] = api[k]; });
})(typeof window !== "undefined" ? window : globalThis);
