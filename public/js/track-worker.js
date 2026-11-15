/*
 * track-worker.js: cerca gli oggetti in moto in background (Web Worker), senza bloccare l'interfaccia.
 * Messaggio in ingresso: {id, arrays, N, sigma, times, opts}; risposta: {id, tracks, chance, nPeaks}.
 * Usa le funzioni di detect.js (findPeaks, findTracks, nullTrackCount).
 */
importScripts("detect.js");
onmessage = function (e) {
  const m = e.data;
  const peaks = findPeaks(m.arrays, m.N, m.sigma, m.opts && m.opts.thr || 5);
  // posizione sub-pixel (parabola): tracce piu' precise = tolleranza stretta = meno falsi allarmi a soglia bassa
  peaks.forEach(function (p) { const r = refinePeak(m.arrays[p.k], m.N, p.x, p.y); p.x = r.x; p.y = r.y; });
  const tracks = findTracks(peaks, m.times, m.opts);
  const chance = nullTrackCount(peaks, m.times, 6, m.opts);
  postMessage({ id: m.id, tracks: tracks, chance: chance, nPeaks: peaks.length });
};
