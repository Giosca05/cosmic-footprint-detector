/*
 * explorer.js: Cosmic Footprint Detector, esplorazione del cielo SPHEREx "a settori".
 *
 * IDEA: il cielo intorno al bersaglio e' diviso in SETTORI (caselle di 3', 6' o 12').
 * Volando (trascinamento, WASD, frecce) la telecamera si sposta; i settori vicini si
 * caricano e si "accendono". Ogni settore e' un piccolo film (blink) di immagini
 * SPHEREx allineate con il WCS. Si caccia cio' che cambia: PING = scansione automatica,
 * tocco = cataloga un contatto.
 *
 * Sezioni: 1 stato, 2 rete+coda, 3 elaborazione del settore, 4 camera, 5 disegno,
 *          6 contatti e ping, 7 interfaccia e input, 8 avvio.
 * Dipende da: fits.js (parseFits), wcs.js, detect.js (funzioni globali).
 */
(function () {
  "use strict";
  const $ = function (id) { return document.getElementById(id); };
  const T = window.I18N ? I18N.T : function (k) { return k; };    // testi: public/js/i18n.js
  // pixel per lato dopo il riallineamento: ~ la risoluzione nativa SPHEREx (6.15"/px)
  function outNFor(fov) { return fov >= 0.12 ? 96 : 72; }
  // I rivelatori SPHEREx sono inclinati di ~18 gradi sul cielo: un ritaglio quadrato, riportato con il Nord in alto,
  // diventa un quadrato ruotato con angoli vuoti. Si scarica quindi un ritaglio piu' grande del settore (x1.35,
  // max 0.2 gradi) cosi' il settore (quadrato allineato alla griglia) e' interamente coperto.
  function cutFor(fov) { return Math.min(0.2, fov * 1.35); }
  const BATCH = 4;                 // ritagli per richiesta a lotti (/api/cutouts)
  const MAX_NET = 8;               // richieste contemporanee verso il server
  const MAX_SECTORS = 25;          // settori tenuti in memoria
  const FALLBACK_MISSIONS = [
    { id: "wise0855", name: "WISE 0855-0714", ra: 133.795129, dec: -7.245147, tag: "NANA BRUNA", blurb: "Nana bruna fredda e vicina." }
  ];

  /* ============================== 1. STATO ============================== */
  const S = {
    missions: [], tags: [], tagYear: 2026.2, showTags: true, showGaia: true, gaia: new Map(), showWise: true, wise: new Map(), stale: false, simple: false, mission: null, origin: null, epoch: 0, sectors: new Map(),
    cam: { e: 0, n: 0, ve: 0, vn: 0 }, viewFov: 860,       // arcsec visibili sul lato corto
    tick: 0, acc: 0, playing: true, fps: 5, mode: "median", bg: true, smooth: 0.7, matched: 1.0, count: 60, detSel: "", fovDeg: 0.15, band: "", bandSet: new Set(),
    demo: false, keys: {}, contacts: [], warp: null, pings: [], floats: [], blips: [],
    seq: 0, list: null, prefetch: true, inflight: 0, queue: [], sound: false, W: 300, H: 300, dpr: 1, lastHud: 0, drag: null
  };
  
  /* ============================== 2. RETE ============================== */
  function pump() {
    while (S.inflight < MAX_NET && S.queue.length) {
      const task = S.queue.shift();
      S.inflight++;
      Promise.resolve().then(task).catch(function (e) { console.warn(e); }).finally(function () {
        S.inflight--; pump(); updateLed();
      });
    }
    updateLed();
  }
  function enqueue(task, high) { if (high) S.queue.unshift(task); else S.queue.push(task); pump(); }

  async function getJson(url) {
    const r = await fetch(url);
    const body = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(body.error || ("Errore " + r.status));
    return body;
  }

  /** Come getJson ma riprova (IRSA risponde spesso 502 per qualche secondo): pause di 3 s, 6 s, ... */
  async function getJsonRetry(url, tries) {
    let err = null;
    for (let i = 0; i < (tries || 3); i++) {
      try { return await getJson(url); } catch (e) { err = e; await new Promise(function (ok) { setTimeout(ok, 3000 * (i + 1)); }); }
    }
    throw err;
  }

  const OV = 0.18;                 // quota di sovrapposizione tra settori vicini (sfumata in fase di disegno)
  function stepArc() { return S.fovDeg * 3600 * (1 - OV); }
  function keyOf(a, b) { return a + "," + b; }
  function isCurrent(sec) { const c = camSector(); return sec.a === c.a && sec.b === c.b; }

  function ensureSector(a, b, high) {
    const key = keyOf(a, b);
    let sec = S.sectors.get(key);
    if (sec) return sec;
    const st = stepArc();
    const sky = skyFromOffset(S.origin, a * st, b * st);
    sec = { a: a, b: b, key: key, e: a * st, n: b * st, ra: sky.ra, dec: sky.dec, epoch: S.epoch,
            status: "loading", t0: performance.now(), frames: [], total: 0, loaded: 0, disp: null, diff: null, sigma: 1,
            canvases: [], version: 0, timer: null, sorted: [], fov: S.fovDeg, outN: outNFor(S.fovDeg), cut: cutFor(S.fovDeg), det: null, rot: null };
    sec.seq = ++S.seq; S.sectors.set(key, sec);
    evictFar();
    enqueue(function () { return loadSector(sec); }, high);
    return sec;
  }

  /** Sposta il centro (e la dimensione) di un URL di ritaglio: stesse osservazioni, altra zona di cielo. */
  function retarget(uri, ra, dec, size) {
    if (/center=/.test(uri)) {
      return uri.replace(/center=([^&,%]+)(?:,|%2C)([-+\d.eE]+)([a-z]*)/i, function (m, a, b, unit) { return "center=" + ra.toFixed(6) + "," + dec.toFixed(6) + (unit || "d"); })
                .replace(/size=[^&]+/, "size=" + size);
    }
    return uri.replace(/ra=[^&]+/, "ra=" + ra.toFixed(6)).replace(/dec=[^&]+/, "dec=" + dec.toFixed(6)).replace(/size=[^&]+/, "size=" + size);
  }

  function listQuery(ra, dec, cut, max, order) {
    // coordinate arrotondate a 0.01 gradi (36"): l'elenco vale per tutta la zona (le immagini sono enormi rispetto al ritaglio) e
    // cosi' la stessa query finisce in cache anche dopo aver spostato un po' la vista o ricaricato la pagina
    return "/api/images?ra=" + ra.toFixed(2) + "&dec=" + dec.toFixed(2) + "&size=" + cut + "&max=" + (max || S.count) + "&order=" + (order || "both") +
           (S.band ? "&bandpass=" + encodeURIComponent(S.band) : "");
  }

  const SPAN = /[?&]span=1/.test(location.search);   // ?span=1 attiva l'elenco per rivelatore (sperimentale)
  const LIST_ROWS = 6;             // si chiede l'elenco COMPLETO (solo metadati: costa poco), poi si scelgono i ritagli da scaricare

  /**
   * Sceglie fino a `count` osservazioni distribuite sul tempo E sui rivelatori: ogni visita (gruppo di date
   * separato da >20 giorni) e ogni rivelatore sono "celle", prese a turno. Serve al moto proprio: ogni banda
   * deve avere immagini di visite diverse (a mesi di distanza), non una sola settimana.
   * `chosen` = righe gia' scelte (le prime, scaricate subito); restituisce le NUOVE righe da aggiungere.
   */
  function pickSpread(rows, chosen, count) {
    const have = new Set(chosen.map(function (r) { return keyOfUri(r.uri); }));
    const sorted = rows.slice().sort(function (a, b) { return a.time_bounds_lower - b.time_bounds_lower; });
    let visit = 0, last = null;
    const cells = new Map();
    sorted.forEach(function (r) {
      if (last !== null && r.time_bounds_lower - last > 20) visit++;
      last = r.time_bounds_lower;
      const m = /_(\d+)D(\d+)_spx/.exec(decodeURIComponent(r.uri || "")), key = visit + ":" + (m ? m[2] : "?");
      if (!cells.has(key)) cells.set(key, []);
      if (!have.has(keyOfUri(r.uri))) cells.get(key).push(r);
    });
    const lists = Array.from(cells.values()).filter(function (l) { return l.length; });
    const want = Math.max(0, count - chosen.length), quota = lists.map(function () { return 0; });
    for (let left = want; left > 0;) {                                            // turni: una riga a testa finche' ce n'e'
      let gave = 0;
      lists.forEach(function (l, i) { if (left > 0 && quota[i] < l.length) { quota[i]++; left--; gave++; } });
      if (!gave) break;
    }
    const out = [];
    lists.forEach(function (l, i) {                                               // dentro la cella: passi regolari nel tempo
      for (let j = 0; j < quota[i]; j++) out.push(l[Math.min(l.length - 1, Math.floor((j + 0.5) * l.length / quota[i]))]);
    });
    return out;
  }

  const FIRST_ROWS = 12;           // le prime righe (ordine temporale) arrivano prima: il settore parte subito
  /** L'elenco delle osservazioni si chiede UNA volta per bersaglio e vale per tutti i settori. */
  /** Elenco su tutto il periodo: il server puo' rispondere "partial" (IRSA lenta): si ritenta, le fasce riuscite sono in cache. */
  async function fetchSpan(cut, epoch) {
    let best = null;
    for (let i = 0; i < 4; i++) {
      if (epoch !== S.epoch) return best;
      try {
        // "span" (query per rivelatore) e' sperimentale: IRSA la regge male. Predefinito: l'elenco classico (piu' vecchie + piu' recenti).
        const r = SPAN ? await getJson(listQuery(S.origin.ra, S.origin.dec, cut, LIST_ROWS, "span")) : await getJsonRetry(listQuery(S.origin.ra, S.origin.dec, cut, S.count, "both"));
        if (!best || (r.rows || []).length >= (best.rows || []).length) best = r;
        if (!r.partial) break;
      } catch (e) { /* si ritenta */ }
    }
    return best;
  }

  /** IRSA non risponde: il server usa un elenco salvato. Lo si dice (chip in alto) invece di lasciare dubbi. */
  function noteStale(res) {
    S.stale = !!(res && res.stale);
    const c = $("stale-chip"); if (c) c.hidden = !S.stale;
  }
  function getList() {
    if (!S.list) {
      const cut = cutFor(S.fovDeg), epoch = S.epoch;
      const firstP = S.list = getJsonRetry(listQuery(S.origin.ra, S.origin.dec, cut, Math.min(FIRST_ROWS, S.count)));
      firstP.then(noteStale, function () {});
      S.listFull = S.count > FIRST_ROWS ? fetchSpan(cut, epoch) : Promise.resolve(null);
      S.listFull.then(function (full) {
        if (epoch !== S.epoch) return;
        S.fullDone = true;
        // firstP e' la promessa locale: S.list puo' essere stato azzerato (errore del primo elenco) nel frattempo
        firstP.then(function (first) {
          if (epoch !== S.epoch) return;
          noteStale(first);
          if (full && full.rows) { S.extra = pickSpread(full.rows, first.rows || [], S.count); }
          S.extraReady = true;                   // SOLO ora i settori possono aggiungere le righe extra (prima S.extra era ancora vuoto: corsa)
          S.sectors.forEach(function (sec) { if (isCurrent(sec)) addExtra(sec); });
        }).catch(function () { /* primo elenco fallito: si ritenta da loadSector */ });
      }).catch(function () { S.extraReady = true; S.fullDone = true; /* elenco completo fallito: restano le prime immagini */ });
    }
    return S.list;
  }

  function sectorVisible(sec) {
    const k = pxPerArc(), half = sec.fov * 3600 / 2;
    const x0 = S.W / 2 - (sec.e + half - S.cam.e) * k, y0 = S.H / 2 - (sec.n + half - S.cam.n) * k, w = sec.fov * 3600 * k;
    return !(x0 > S.W || y0 > S.H || x0 + w < 0 || y0 + w < 0);
  }

  /** Aggiunge al settore le righe oltre le prime 12, quando l'elenco completo e' arrivato. */
  function addExtra(sec) {
    if (sec.extraAdded || !sec.total || !S.extraReady || sec.status === "error" || sec.status === "empty" || sec.epoch !== S.epoch) return;
    sec.extraAdded = true;
    if (S.extra && S.extra.length) startCutouts(sec, S.extra, !(sec.a === 0 && sec.b === 0), true);
    else scheduleBuild(sec);
  }

  async function loadSector(sec) {
    if (sec.epoch !== S.epoch) return;
    let list;
    try { list = await getList(); }
    catch (e) { S.list = null; sec.status = "error"; sec.msg = e.message; return; }
    if (sec.epoch !== S.epoch) return;
    S.demo = !!list.demo; updateLed();
    if (!S.refKey && list.rows && list.rows.length) S.refKey = keyOfUri(list.rows[0].uri);
    startCutouts(sec, list.rows || [], !(sec.a === 0 && sec.b === 0), false);
    if (isCurrent(sec)) addExtra(sec);
  }

  function keyOfUri(u) { return String(u || "").split("?")[0]; }

  function startCutouts(sec, rows, move, append) {
    if (!rows.length) { if (!append) sec.status = "empty"; return; }
    sec.total = (append ? sec.total : 0) + rows.length; if (!append) sec.loaded = 0;
    const high = isCurrent(sec);
    const list = rows.map(function (row) {
      return move ? { uri: retarget(row.uri, sec.ra, sec.dec, sec.cut), time_bounds_lower: row.time_bounds_lower } : row;
    });
    for (let i = 0; i < list.length; i += BATCH) {                 // lotti da BATCH ritagli: poche richieste, tanto parallelismo sul server
      const chunk = list.slice(i, i + BATCH);
      enqueue(function () { return loadBatch(sec, chunk); }, high);
    }
  }

  /** Se le osservazioni del bersaglio non coprono questo settore, ne chiede altre centrate qui. */
  async function ownList(sec) {
    sec.retried = true;
    try {
      const list = await getJson(listQuery(sec.ra, sec.dec, sec.cut));
      if (sec.epoch === S.epoch) startCutouts(sec, list.rows || [], false);
    } catch (e) { sec.status = "error"; sec.msg = e.message; }
  }

  /* Flag dei pixel SPHEREx (estensione FLAGS, Explanatory Supplement tab. 16): solo quelli che segnalano contaminazione
     (SOURCE e FULLSAMPLE sono informativi e non vengono mostrati). */
  const FLAG_BITS = { 0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA", 10: "HOT", 11: "COLD",
    14: "PHANMISS", 15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK", 22: "GHOST", 24: "GHOST_EXT", 25: "STREAK",
    26: "BLOOM", 27: "SNOWBALL", 28: "HALO", 29: "SATELLITE_HALO" };
  function flagsAtCenter(img) {
    if (!img.flags) return null;
    const w = img.width, h = img.height, cx = w >> 1, cy = h >> 1, r = 6; let m = 0;
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) m |= img.flags[y * w + x];
    const names = [];
    Object.keys(FLAG_BITS).forEach(function (b) { if ((m >>> Number(b)) & 1) names.push(FLAG_BITS[b]); });
    return names;
  }

  /** Trasforma i byte FITS di un ritaglio in immagine del settore (stessa logica per richiesta singola e a lotti). */
  function ingest(sec, row, buf) {
    const img = parseFits(buf);
    img.wcs = wcsFromHeader(img.header);
    img.mjd = row.time_bounds_lower; img.key = keyOfUri(row.uri);
    const m = /_(\d+)D(\d+)_spx/.exec(decodeURIComponent(row.uri || ""));
    img.det = m ? m[2] : null;                          // rivelatore (D1..D6): bande diverse, non confrontabili
    const h = img.header || {};
    const dl = h.CDELT1 !== undefined ? Number(h.CDELT1) : 1;          // CD = CDELT * PC (oppure CD diretto)
    const c12 = h.CD1_2 !== undefined ? Number(h.CD1_2) : h.PC1_2 !== undefined ? Number(h.PC1_2) * dl : null;
    const c22 = h.CD2_2 !== undefined ? Number(h.CD2_2) : h.PC2_2 !== undefined ? Number(h.PC2_2) * dl : null;
    img.rot = (c12 !== null && c22 !== null) ? Math.atan2(-c12, c22) * 180 / Math.PI : null;
    img.flagNames = flagsAtCenter(img);                 // flag SPHEREx dei pixel al bersaglio (null = non disponibili)
    sec.frames.push(img);
  }

  /** Dopo ogni ritaglio (riuscito o no): contatore, errore se non ne e' arrivato nessuno, ricostruzione del settore. */
  function afterCutout(sec) {
    sec.loaded++;
    if (sec.epoch !== S.epoch) return;
    if (sec.loaded >= sec.total && !sec.frames.length) {
      if (!sec.retried) { enqueue(function () { return ownList(sec); }, isCurrent(sec)); return; }
      sec.status = "error"; sec.msg = T("msg_no_cutouts"); return;
    }
    scheduleBuild(sec);
  }

  async function loadCutout(sec, row) {
    if (sec.epoch !== S.epoch) return;
    try {
      // IRSA sotto carico risponde 502/503: si riprova (backoff) invece di perdere il fotogramma
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) { await new Promise(function (ok) { setTimeout(ok, 1500 * attempt * attempt); }); if (sec.epoch !== S.epoch) return; }
        try { r = await fetch("/api/cutout?url=" + encodeURIComponent(row.uri)); } catch (e) { r = null; }
        if (r && (r.ok || r.status < 500)) break;
      }
      if (!r || !r.ok) throw new Error("HTTP " + (r ? r.status : "rete"));
      ingest(sec, row, await r.arrayBuffer());
    } catch (e) { console.warn("ritaglio saltato:", e.message); }
    afterCutout(sec);
  }

  /**
   * Un lotto di ritagli in UNA richiesta: il browser tiene al massimo 6 connessioni verso localhost, ma il server ne
   * apre decine in parallelo verso il Worker. Risposta: per ogni URL [stato u32][lunghezza u32][byte]. I 5xx si riprovano singolarmente.
   */
  async function loadBatch(sec, rows) {
    if (sec.epoch !== S.epoch) return;
    let buf = null;
    try {
      const r = await fetch("/api/cutouts?urls=" + encodeURIComponent(JSON.stringify(rows.map(function (x) { return x.uri; }))));
      if (r.ok) buf = await r.arrayBuffer();
    } catch (e) { buf = null; }
    if (!buf) { for (const row of rows) await loadCutout(sec, row); return; }     // server vecchio o errore: modo singolo
    const dv = new DataView(buf);
    let off = 0;
    for (let i = 0; i < rows.length; i++) {
      if (off + 8 > buf.byteLength) { await loadCutout(sec, rows[i]); continue; }
      const st = dv.getUint32(off), len = dv.getUint32(off + 4); off += 8;
      const body = buf.slice(off, off + len); off += len;
      if (st >= 500) { await loadCutout(sec, rows[i]); continue; }
      if (sec.epoch !== S.epoch) return;
      if (st === 200) { try { ingest(sec, rows[i], body); } catch (e) { console.warn("ritaglio saltato:", e.message); } }
      afterCutout(sec);
    }
  }

  function evictFar() {
    if (S.sectors.size <= MAX_SECTORS) return;
    const c = camSector();
    const arr = Array.from(S.sectors.values()).sort(function (x, y) {
      return Math.hypot(y.a - c.a, y.b - c.b) - Math.hypot(x.a - c.a, x.b - c.b);
    });
    while (S.sectors.size > MAX_SECTORS) { const v = arr.shift(); S.sectors.delete(v.key); v.epoch = -1; if (bw) bw.postMessage({ type: "drop", sk: v.key }); }
  }

  /* ===================== 3. ELABORAZIONE DEL SETTORE ===================== */
  /**
   * Le ricostruzioni dei settori (riallineamento, mediane, filtri) sono pesanti e girano sul thread principale: se partono a ogni
   * immagine in arrivo il frame rate crolla. Quindi: (1) durante il caricamento al massimo una ricostruzione ogni ~1 s per il settore
   * sotto la camera e ogni ~4 s per gli altri, (2) una sola ricostruzione alla volta (coda), con una pausa tra l'una e l'altra
   * perche' il disegno possa girare.
   */
  const BUILDQ = { q: [], busy: false };
  function buildPump() {
    if (BUILDQ.busy || !BUILDQ.q.length) return;
    BUILDQ.busy = true;
    const sec = BUILDQ.q.shift();
    setTimeout(function () {
      Promise.resolve().then(function () { return buildSector(sec); }).catch(function (e) { console.warn("ricostruzione fallita:", e); }).then(function () {
        BUILDQ.busy = false;
        setTimeout(buildPump, 120);
      });
    }, 0);
  }
  function scheduleBuild(sec) {
    if (sec.timer) return;
    const done = sec.loaded >= sec.total;
    const delay = done ? 50 : (isCurrent(sec) ? 1000 : 4000);
    sec.timer = setTimeout(function () {
      sec.timer = null;
      if (BUILDQ.q.indexOf(sec) < 0) BUILDQ.q.push(sec);
      buildPump();
    }, delay);
  }

  const yieldMain = function () { return new Promise(function (ok) { setTimeout(ok, 0); }); };   // lascia respirare disegno e input tra un pezzo e l'altro
  /* Il calcolo pesante (riproiezione, fondo, allineamento, mediane, differenze, moto proprio) gira in un Web Worker: build-worker.js */
  let bw = null, bwId = 0;
  const bwJobs = new Map();
  function buildWorker() {
    if (bw) return bw;
    bw = new Worker("js/build-worker.js");
    bw.onmessage = function (ev) {
      const r = ev.data, j = bwJobs.get(r.id); if (!j) return;
      bwJobs.delete(r.id);
      if (r.error) j.no(new Error(r.error)); else j.ok(r);
    };
    bw.onerror = function (ev) {
      const err = new Error(ev.message || "build-worker");
      bwJobs.forEach(function (j) { j.no(err); }); bwJobs.clear();
    };
    return bw;
  }
  function buildRemote(msg) {
    const w = buildWorker();
    return new Promise(function (ok, no) { bwJobs.set(msg.id, { ok: ok, no: no }); w.postMessage(msg); });
  }

  async function buildSector(sec) {
    if (sec.epoch !== S.epoch) return;
    const OUTN = sec.outN, size = OUTN * OUTN;
    const sortedAll = sec.frames.slice().sort(function (a, b) { return a.mjd - b.mjd; });
    if (!sortedAll.length) return;
    // Rivelatori diversi = bande diverse (le stelle cambiano luminosita'): ognuno e' elaborato per conto suo.
    // Si MOSTRA un rivelatore (il piu' ricco o quello scelto); il PING usa le differenze di TUTTI.
    const byDet = new Map();
    sortedAll.forEach(function (f) { const d = f.det || "?"; if (!byDet.has(d)) byDet.set(d, []); byDet.get(d).push(f); });
    const w = buildWorker();
    sortedAll.forEach(function (f) {
      if (f.sent) return;
      f.sent = true;
      w.postMessage({ type: "frame", sk: sec.key, key: f.key, width: f.width, height: f.height, data: f.data, wcs: f.wcs });
    });
    const wantDrift = sec.loaded >= sec.total && (sec.extraAdded || S.count <= FIRST_ROWS);
    const r = await buildRemote({
      type: "build", id: ++bwId, sk: sec.key, ra: sec.ra, dec: sec.dec, outN: OUTN, fov: sec.fov,
      bg: S.bg, smooth: S.smooth, matched: S.matched, refKey: S.refKey, drift: wantDrift, pxScale: sec.fov * 3600 / OUTN,
      groups: Array.from(byDet.entries()).map(function (e) { return { det: e[0], keys: e[1].map(function (f) { return f.key; }), mjd: e[1].map(function (f) { return f.mjd; }) }; })
    });
    if (sec.epoch !== S.epoch) return;
    if (r.noRef && sec.loaded >= sec.total && sec.frames.length) S.refKey = sec.frames[0].key;      // il riferimento non si carichera': ne scelgo un altro
    sec.aligned = r.aligned; sec.shifts = r.shifts; sec.dbgPer = r.dbgPer;
    const groups = r.groups;
    if (window.__cfdDebug) sec.dbg = groups;
    groups.forEach(function (g) { g.frames = byDet.get(g.det); });
    if (!groups.length) { sec.status = "empty"; sec.msg = T("msg_low_coverage"); return; }
    sec.groupsInfo = groups.map(function (g) { return g.det + "\u00d7" + g.n; }).join(" ");
    let G = null;
    groups.forEach(function (g) { if (S.detSel && g.det === S.detSel) G = g; });
    if (!G) groups.forEach(function (g) { if (!G || g.n > G.n) G = g; });
    const frames = G.frames, raw = G.raw, n = G.n, diff = G.diff, denom = G.denom, cnt = G.cnt, need = G.need;
    let sigma = G.sigma, cov = G.cov * size;
    sec.det = G.det; sec.nOther = sortedAll.length - frames.length;
    const rots = frames.map(function (f) { return f.rot; }).filter(function (r) { return r !== null && isFinite(r); });
    sec.rots = Array.from(new Set(rots.map(function (r) { return Math.round(r); })));   // orientamenti distinti (una visita = un angolo)
    sec.shifts.sort(function (a, b) { return a - b; }); sec.shiftPx = sec.shifts.length ? sec.shifts[sec.shifts.length >> 1] : 0;
    // dati per il PING (calcolati nel worker): differenze di tutti i rivelatori, con il tempo di ogni immagine
    sec.trackArrays = r.trackArrays; sec.trackTimes = [];
    groups.forEach(function (g) { if (g.diff) g.frames.forEach(function (f) { sec.trackTimes.push(f.mjd); }); });
    // 3) cosa mostrare
    let mode = S.mode;
    if (n < 3 && mode !== "stack") mode = "image";
    let arrays, diverging = false;
    if (mode === "median") { arrays = diff; diverging = true; }
    else if (mode === "prev") {
      diverging = true;
      arrays = raw.map(function (a, k) {
        const d = new Float32Array(size);
        if (k) for (let i = 0; i < size; i++) d[i] = (a[i] - raw[k - 1][i]) / (denom ? denom[i] : 1);
        return d;
      });
      sigma = robustSigma(arrays.slice(1).length ? arrays.slice(1) : arrays);
    } else if (mode === "stack") {
      const st = new Float32Array(size);
      for (const a of raw) for (let i = 0; i < size; i++) if (isFinite(a[i])) st[i] += a[i] / n;
      arrays = [st];
    } else {
      // immagini: i pixel mancanti in un singolo fotogramma si riempiono con la media degli altri (niente bande nere)
      const fm = new Float32Array(size);
      for (let i = 0; i < size; i++) { let sm = 0, c = 0; for (let k = 0; k < n; k++) { const v = raw[k][i]; if (isFinite(v)) { sm += v; c++; } } fm[i] = c ? sm / c : NaN; }
      arrays = raw.map(function (a) { const b = Float32Array.from(a); for (let i = 0; i < size; i++) if (!isFinite(b[i])) b[i] = fm[i]; return b; });
    }
    let lo, hi;
    if (diverging) { hi = 8 * sigma; lo = -hi; }
    else {
      const vv = new Float32Array(Math.ceil(size / 2) * arrays.length); let vn = 0;
      for (const a of arrays) for (let i = 0; i < size; i += 2) if (isFinite(a[i])) vv[vn++] = a[i];
      const v = vv.subarray(0, vn).sort();
      lo = v[Math.floor(v.length * 0.02)] || 0; hi = v[Math.floor(v.length * 0.995)] || 1; if (hi <= lo) hi = lo + 1;
    }
    sec.sorted = frames; sec.diff = diff; sec.sigma = sigma; sec.coverage = cov / size;
    const nd = { arrays: arrays, lo: lo, hi: hi, diverging: diverging };
    if (S.swap && S.swap.has(sec.key) && sec.disp) { sec.pend = nd; swapCheck(); }      // cambio di modalita': si aggiorna tutto insieme
    else { sec.disp = nd; sec.canvases = []; sec.version++; sec.status = "ready"; sec.blips = null; if (isCurrent(sec)) syncTimeline(); }
    if (wantDrift) { sec.drifters = r.drifters; trackSector(sec); if (S.pingWanted || S.blips.length) showTracks(); }
  }

  /* Cambio modalita'/filtri: ogni settore va ricalcolato (uno alla volta). Per non vedere un mosaico di modalita' diverse, i nuovi
   * risultati restano in attesa (sec.pend) e si mostrano TUTTI insieme quando l'ultimo settore e' pronto (o dopo 25 s al massimo). */
  function busyBadge(on) {
    let el = document.getElementById("mode-busy");
    if (!el) {
      if (!on) return;
      const st = document.createElement("style");
      st.textContent = "#mode-busy{position:absolute;left:50%;top:64px;transform:translateX(-50%);z-index:30;display:flex;align-items:center;gap:10px;"
        + "padding:8px 14px;border-radius:999px;background:rgba(6,14,32,.88);border:1px solid rgba(62,232,255,.55);color:#cfefff;"
        + "font:600 12px/1 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;pointer-events:none;opacity:0;transition:opacity .15s}"
        + "#mode-busy.on{opacity:1}#mode-busy i{width:14px;height:14px;border-radius:50%;border:2px solid rgba(62,232,255,.3);border-top-color:#3ee8ff;animation:mbspin .8s linear infinite}"
        + "@keyframes mbspin{to{transform:rotate(360deg)}}";
      document.head.appendChild(st);
      el = document.createElement("div"); el.id = "mode-busy"; el.innerHTML = "<i></i><span></span>";
      ($("scope-wrap") || document.body).appendChild(el);
    }
    el.querySelector("span").textContent = T("mode_busy");
    el.classList.toggle("on", !!on);
  }
  function swapCommit() {
    if (!S.swap) return;
    busyBadge(false);
    clearTimeout(S.swapT); S.swapT = null;
    const keys = Array.from(S.swap); S.swap = null;
    keys.forEach(function (k) {
      const sec = S.sectors.get(k);
      if (sec && sec.pend) { sec.disp = sec.pend; sec.pend = null; sec.canvases = []; sec.version++; sec.status = "ready"; sec.blips = null; }
    });
    const cs = S.sectors.get(keyOf(camSector().a, camSector().b));
    if (cs && cs.disp) syncTimeline();
  }
  function swapCheck() {
    if (!S.swap) return;
    for (const k of S.swap) { const sec = S.sectors.get(k); if (sec && sec.epoch === S.epoch && !sec.pend && sec.frames.length) return; }
    swapCommit();
  }
  function rebuildAll() {
    const c = camSector(), list = [];
    S.sectors.forEach(function (sec) { if (sec.frames.length) list.push(sec); });
    list.sort(function (x, y) { return Math.hypot(x.a - c.a, x.b - c.b) - Math.hypot(y.a - c.a, y.b - c.b); });   // prima quelli sotto la camera
    if (S.swap) swapCommit();
    const ready = list.filter(function (sec) { return sec.disp; });
    S.swap = ready.length > 1 ? new Set(ready.map(function (sec) { return sec.key; })) : null;
    if (S.swap) { busyBadge(true); S.swapT = setTimeout(swapCommit, 25000); }
    list.forEach(function (sec) { scheduleBuild(sec); });
  }

  /* Tavolozze: immagine = ghiaccio/brace, differenza = ciano (meno) / ambra-bianco (piu') */
  const LUT_IMG = (function () {
    const stops = [[0, 3, 6, 20], [0.28, 14, 40, 96], [0.55, 24, 150, 176], [0.8, 255, 196, 96], [1, 255, 252, 238]];
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[k + 1], f = (t - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * f;
    }
    return out;
  })();
  function colorDiff(u, o, data) {          // u in [-1, 1]
    const dead = 0.2;                       // zona morta: il rumore (< ~1.6 sigma) resta nero
    const m = Math.abs(u); u = m < dead ? 0 : Math.sign(u) * (m - dead) / (1 - dead);
    let r, g, b;
    if (u < 0) { const a = Math.min(1, -u); r = 4 + 20 * a; g = 8 + 210 * Math.pow(a, 0.9); b = 18 + 237 * a; }
    else { const a = Math.min(1, u); r = 4 + 251 * Math.min(1, a * 1.15); g = 8 + 190 * Math.pow(a, 1.4); b = 18 + 170 * Math.pow(a, 2.2); }
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }

  function frameCanvas(sec, k) {
    const OUTN = sec.outN;
    if (sec.canvases[k]) return sec.canvases[k];
    const c = document.createElement("canvas"); c.width = OUTN; c.height = OUTN;
    const cx = c.getContext("2d"), img = cx.createImageData(OUTN, OUTN), d = img.data;
    const a = sec.disp.arrays[k], lo = sec.disp.lo, hi = sec.disp.hi, rng = hi - lo;
    for (let i = 0; i < OUTN * OUTN; i++) {
      const v = a[i], o = i * 4;
      if (!isFinite(v)) { d[o + 3] = 0; continue; }
      if (sec.disp.diverging) colorDiff(Math.max(-1, Math.min(1, v / hi)), o, d);
      else {
        const t = Math.max(0, Math.min(1, (v - lo) / rng)), j = Math.round(t * 255) * 3;
        d[o] = LUT_IMG[j]; d[o + 1] = LUT_IMG[j + 1]; d[o + 2] = LUT_IMG[j + 2]; d[o + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return (sec.canvases[k] = c);
  }

  /* ============================== 4. CAMERA ============================== */
  function pxPerArc() { return Math.min(S.W, S.H) / S.viewFov; }
  function toScreen(e, n) { const k = pxPerArc(); return [S.W / 2 - (e - S.cam.e) * k, S.H / 2 - (n - S.cam.n) * k]; }
  function toWorld(x, y) { const k = pxPerArc(); return [S.cam.e + (S.W / 2 - x) / k, S.cam.n + (S.H / 2 - y) / k]; }
  function camSector() { const st = stepArc(); return { a: Math.round(S.cam.e / st), b: Math.round(S.cam.n / st) }; }

  function updateCamera(dt) {
    const speed = S.viewFov * 0.5;                    // arcsec/s: attraversa mezzo campo al secondo
    let te = 0, tn = 0;
    if (S.keys.ArrowLeft || S.keys.a) te += 1;        // Est a sinistra
    if (S.keys.ArrowRight || S.keys.d) te -= 1;
    if (S.keys.ArrowUp || S.keys.w) tn += 1;
    if (S.keys.ArrowDown || S.keys.s) tn -= 1;
    const len = Math.hypot(te, tn) || 1;
    const f = Math.min(1, dt * 7);
    if (!S.drag) {
      S.cam.ve += (te / len * speed * (te || tn ? 1 : 0) - S.cam.ve) * f;
      S.cam.vn += (tn / len * speed * (te || tn ? 1 : 0) - S.cam.vn) * f;
      if (!te && !tn) { S.cam.ve *= Math.pow(0.02, dt); S.cam.vn *= Math.pow(0.02, dt); }   // inerzia dopo il lancio
      S.cam.e += S.cam.ve * dt; S.cam.n += S.cam.vn * dt;
    }
    // Le immagini extra (fino a 60 per settore) si scaricano subito solo per il settore sotto la camera; per gli altri in vista
    // solo quando la rete e' quasi libera: cosi' le zone nuove compaiono prima (le prime 12 immagini bastano per vederle).
    const netFree = S.inflight + S.queue.length < 3;
    S.sectors.forEach(function (sc) { if (!sc.extraAdded && sc.total && sectorVisible(sc) && (isCurrent(sc) || netFree)) addExtra(sc); });
    // carica il settore sotto la camera e prefetch dei vicini
    const c = camSector(), cur = ensureSector(c.a, c.b, true);
    if (cur.status === "ready") {
      const st = stepArc(), fe = S.cam.e / st - c.a, fn = S.cam.n / st - c.b;
      if (Math.abs(fe) > 0.3 && Math.abs(fe) >= Math.abs(fn)) ensureSector(c.a + Math.sign(fe), c.b, false);
      else if (Math.abs(fn) > 0.3) ensureSector(c.a, c.b + Math.sign(fn), false);
      // a riposo (nessuna richiesta in corso) precarica i vicini piu' prossimi alla camera, uno alla volta
      else if (S.prefetch && S.inflight === 0 && !S.queue.length) {
        const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].filter(function (d) { return !S.sectors.has(keyOf(c.a + d[0], c.b + d[1])); });
        ring.sort(function (p, q) { return Math.hypot(fe - p[0], fn - p[1]) - Math.hypot(fe - q[0], fn - q[1]); });
        if (ring.length) ensureSector(c.a + ring[0][0], c.b + ring[0][1], false);
      }
    }
  }

  /* ============================== 5. DISEGNO ============================== */
  const scope = $("scope"), ctx = scope.getContext("2d");
  const STARS = (function () { const a = []; let s = 12345; const r = function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    for (let i = 0; i < 140; i++) a.push([r(), r(), 0.3 + r() * 0.9, 0.04 + r() * 0.16]); return a; })();

  function resize() {
    const r = $("scope-wrap").getBoundingClientRect();
    S.dpr = window.devicePixelRatio || 1; S.W = Math.max(10, r.width); S.H = Math.max(10, r.height);
    scope.width = Math.round(S.W * S.dpr); scope.height = Math.round(S.H * S.dpr);
  }

  function drawStars() {
    ctx.fillStyle = "#cfe4ff";
    for (const s of STARS) {
      const x = (((s[0] * S.W - S.cam.e * pxPerArc() * 0.08) % S.W) + S.W) % S.W;
      const y = (((s[1] * S.H + S.cam.n * pxPerArc() * 0.08) % S.H) + S.H) % S.H;
      ctx.globalAlpha = s[3]; ctx.fillRect(x, y, s[2], s[2]);
    }
    ctx.globalAlpha = 1;
  }

  /* Maschera di sfumatura (alfa 0 -> 1 verso l'interno) sui lati scelti: cross-fade tra settori vicini. */
  const MASKS = new Map();
  function maskFor(N, L, R, T, B) {
    const key = N + ":" + (L ? 1 : 0) + (R ? 1 : 0) + (T ? 1 : 0) + (B ? 1 : 0);
    if (MASKS.has(key)) return MASKS.get(key);
    const c = document.createElement("canvas"); c.width = N; c.height = N;
    const cx = c.getContext("2d"), img = cx.createImageData(N, N), d = img.data, F = Math.max(2, OV * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let a = 1;
      if (L) a = Math.min(a, (x + 0.5) / F);
      if (R) a = Math.min(a, (N - x - 0.5) / F);
      if (T) a = Math.min(a, (y + 0.5) / F);
      if (B) a = Math.min(a, (N - y - 0.5) / F);
      a = Math.max(0, Math.min(1, a)); a = a * a * (3 - 2 * a);            // smoothstep
      d[(y * N + x) * 4 + 3] = Math.round(a * 255);
    }
    cx.putImageData(img, 0, 0); MASKS.set(key, c); return c;
  }

  function sectorRect(sec) {
    const k = pxPerArc(), half = sec.fov * 3600 / 2;
    return { x0: S.W / 2 - (sec.e + half - S.cam.e) * k, y0: S.H / 2 - (sec.n + half - S.cam.n) * k, w: sec.fov * 3600 * k };
  }

  /** Settore pronto. Colonna 0 = Est = sinistra: il vicino a+1 e' a sinistra, b+1 in alto. Si sfuma solo verso
   *  vicini pronti e creati PRIMA (quello sotto resta opaco: nessun calo di luminosita' nella fascia comune). */
  function drawReady(sec) {
    const r = sectorRect(sec);
    if (r.x0 > S.W || r.y0 > S.H || r.x0 + r.w < 0 || r.y0 + r.w < 0) return;
    const idx = sec.disp.arrays.length === 1 ? 0 : S.tick % sec.disp.arrays.length, fr = frameCanvas(sec, idx);
    const nb = function (da, db) { const o = S.sectors.get(keyOf(sec.a + da, sec.b + db)); return !!o && o.status === "ready" && o.seq < sec.seq; };
    const L = nb(1, 0), R = nb(-1, 0), T = nb(0, 1), B = nb(0, -1);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (!(L || R || T || B)) { ctx.drawImage(fr, r.x0, r.y0, r.w + 0.5, r.w + 0.5); return; }
    const N = sec.outN, tmp = sec.tmp || (sec.tmp = document.createElement("canvas")), tc = tmp.getContext("2d");
    tmp.width = N; tmp.height = N;
    tc.drawImage(fr, 0, 0); tc.globalCompositeOperation = "destination-in"; tc.drawImage(maskFor(N, L, R, T, B), 0, 0);
    ctx.drawImage(tmp, r.x0, r.y0, r.w + 0.5, r.w + 0.5);
  }

  /** Settore in arrivo: velo scuro con una linea di scansione, senza bordi ne' griglia. */
  function drawPending(sec, t) {
    const r = sectorRect(sec), x0 = r.x0, y0 = r.y0, w = r.w;
    if (x0 > S.W || y0 > S.H || x0 + w < 0 || y0 + w < 0) return;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, w); ctx.clip();
    ctx.fillStyle = "rgba(10,24,52,.35)"; ctx.fillRect(x0, y0, w, w);
    if (sec.status === "loading") { const sweep = ((t / 1400) % 1) * w; ctx.fillStyle = "rgba(62,232,255,.12)"; ctx.fillRect(x0, y0 + sweep - 8, w, 16); }
    ctx.restore();
  }
  function drawPendingLabel(sec) {
    if (sec.status === "ready") return;
    const r = sectorRect(sec), cx = r.x0 + r.w / 2, cy = r.y0 + r.w / 2;
    if (cx < 0 || cy < 0 || cx > S.W || cy > S.H) return;
    ctx.fillStyle = "#9fc2ee"; ctx.font = "12px ui-monospace, Consolas, monospace"; ctx.textAlign = "center";
    const waitS = sec.t0 ? (performance.now() - sec.t0) / 1000 : 0;          // l'elenco delle osservazioni arriva da IRSA: puo' metterci minuti
    ctx.fillText(sec.status === "loading" ? T("scanning") + (sec.total ? sec.loaded + "/" + sec.total : (waitS > 20 ? T("list_slow", Math.round(waitS)) : "…"))
      : sec.status === "empty" ? T("no_data_here") : T("error_prefix") + (sec.msg || ""), cx, cy);
    ctx.textAlign = "left";
  }

  function niceScale(arc) {                   // lunghezza "tonda" della barra di scala, in arcsec
    const opts = [5, 10, 20, 30, 60, 120, 300, 600]; let best = opts[0];
    for (const o of opts) if (o * pxPerArc() <= S.W * 0.28) best = o;
    return best;
  }

  function drawHud(t) {
    const W = S.W, H = S.H, m = 14, L = 22;
    ctx.strokeStyle = "rgba(62,232,255,.85)"; ctx.lineWidth = 2;
    [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(function (c) {
      ctx.beginPath(); ctx.moveTo(c[0], c[1] + c[3] * L); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0] + c[2] * L, c[1]); ctx.stroke();
    });
    // mirino centrale
    const cx = W / 2, cy = H / 2, r = 20;
    ctx.strokeStyle = "rgba(255,179,71,.9)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function (d) { ctx.beginPath(); ctx.moveTo(cx + d[0] * (r + 3), cy + d[1] * (r + 3)); ctx.lineTo(cx + d[0] * (r + 14), cy + d[1] * (r + 14)); ctx.stroke(); });
    // barra di scala
    const bar = niceScale(), bw = bar * pxPerArc();
    ctx.strokeStyle = "#cfe4ff"; ctx.fillStyle = "#cfe4ff"; ctx.lineWidth = 2; ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.beginPath(); ctx.moveTo(m + 4, H - m - 26); ctx.lineTo(m + 4 + bw, H - m - 26); ctx.stroke();
    ctx.fillText(bar >= 60 ? (bar / 60) + "′" : bar + "″", m + 4, H - m - 32);
    // bussola
    ctx.strokeStyle = "rgba(125,147,184,.9)"; ctx.fillStyle = "rgba(125,147,184,.95)"; ctx.lineWidth = 1.5;
    const bx = W - m - 46, by = m + 46;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - 28); ctx.moveTo(bx, by); ctx.lineTo(bx - 28, by); ctx.stroke();
    ctx.fillText("N", bx - 3, by - 32); ctx.fillText("E", bx - 42, by + 4);
    // anelli del ping
    S.pings = S.pings.filter(function (p) { return t - p.t0 < 1400; });
    S.pings.forEach(function (p) {
      const f = Math.max(0, (t - p.t0) / 1400), rad = f * Math.max(W, H) * 0.7;
      ctx.strokeStyle = "rgba(62,232,255," + (0.7 * (1 - f)) + ")"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 7); ctx.stroke();
    });
  }

  /** Tracce di oggetti in moto trovate dal PING: percorso nel cielo + rombo sull'ultima posizione. */
  function drawBlips(t) {
    S.blips.forEach(function (b) {
      const col = b.done ? "rgba(125,255,170,.95)" : "rgba(255,79,163,.95)";
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
      b.path.forEach(function (q, i) { const p = toScreen(q[0], q[1]); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
      const p = toScreen(b.e, b.n), s = 12 * (1 + 0.15 * Math.sin(t / 180 + b.e));
      if (p[0] < -40 || p[1] < -40 || p[0] > S.W + 40 || p[1] > S.H + 40) return;
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p[0], p[1] - s); ctx.lineTo(p[0] + s, p[1]); ctx.lineTo(p[0], p[1] + s); ctx.lineTo(p[0] - s, p[1]); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = col; ctx.font = "10px ui-monospace, Consolas, monospace";
      let lx = p[0] + s + 3;
      if (b.done) { ctx.beginPath(); ctx.moveTo(lx, p[1] - 3); ctx.lineTo(lx + 3, p[1] + 1); ctx.lineTo(lx + 9, p[1] - 6); ctx.lineWidth = 1.6; ctx.stroke(); lx += 14; }
      ctx.fillText((b.known ? "(" + b.known + ") " : "") + (b.drift ? T("blip_pm", b.speed.toFixed(1)) : T("blip_jump", b.count, b.speed.toFixed(1))) + (b.catText ? " · " + b.catText : ""), lx, p[1] - 2);
    });
  }

  /** Etichette degli oggetti noti (stelle, nane brune...): anello + nome + tipo, dove cadono nella vista. */
  function drawTags() {
    if (!S.showTags || !S.origin) return;
    ctx.save(); ctx.font = "11px ui-monospace, Consolas, monospace"; ctx.textBaseline = "middle";
    S.tags.forEach(function (tg) {
      const dra = (tg.ra - S.origin.ra + 540) % 360 - 180;
      if (Math.abs(dra * Math.cos(S.origin.dec * Math.PI / 180)) > 0.4 || Math.abs(tg.dec - S.origin.dec) > 0.4) return;     // lontano (> ~0.4 gradi)
      const o = offsetFromSky(S.origin, tg.ra, tg.dec), p = toScreen(o.e, o.n);
      if (p[0] < -60 || p[1] < -30 || p[0] > S.W + 60 || p[1] > S.H + 30) return;
      const r = 17;
      ctx.strokeStyle = "rgba(255,214,102,.95)"; ctx.lineWidth = 1.5; ctx.setLineDash(tg.approx ? [4, 3] : []);
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(p[0] + r * 0.7, p[1] - r * 0.7); ctx.lineTo(p[0] + r + 14, p[1] - r - 12); ctx.stroke();
      const label = (tg.approx ? "≈ " : "") + (window.I18N ? I18N.Ttag(tg) : tg.name), sub = (window.I18N ? I18N.Tkind(tg.kind) : tg.kind) || "";
      const x = p[0] + r + 16, y = p[1] - r - 12, w = Math.max(ctx.measureText(label).width, ctx.measureText(sub).width) + 10;
      ctx.fillStyle = "rgba(6,16,36,.78)"; ctx.fillRect(x - 4, y - 10, w, sub ? 28 : 16);
      ctx.fillStyle = "#ffd666"; ctx.fillText(label, x, y);
      if (sub) { ctx.fillStyle = "rgba(200,225,255,.85)"; ctx.fillText(sub, x, y + 13); }
    });
    ctx.restore();
  }

  /* ===== Spettro a 6 bande: flusso del contatto in ciascun rivelatore SPHEREx (0.75-5 micron) ===== */
  const BANDS = { 1: [0.75, 1.09], 2: [1.09, 1.62], 3: [1.62, 2.42], 4: [2.42, 3.82], 5: [3.82, 4.42], 6: [4.42, 5.00] };
  /** Giudizio indicativo dal colore: rapporto tra il flusso a ~4 micron e quello a ~1.4 micron (flussi per unita' di frequenza). */
  function sedInfo(sed) {
    if (!sed) return null;
    const by = {}; sed.forEach(function (p) { by[p.det] = p; });
    const a = by[2] || by[1], b = by[5] || by[4];
    if (!a || !b || !(a.flux > 0) || !(b.flux > 0)) return null;
    const ratio = b.flux / a.flux;
    return { cls: ratio < 0.5 ? "star" : (ratio < 2 ? "flat" : "cold"), idx: Math.log10(ratio) };   // idx > 0.3: piu' brillante a 4 micron che a 1.4 micron = freddo
  }
  function sedVerdict(sed) {
    const i = sedInfo(sed);
    return !i ? "" : T(i.cls === "star" ? "sed_star" : (i.cls === "flat" ? "sed_flat" : "sed_red"));
  }
  function validSed(p) { return typeof p.flux === "number" && isFinite(p.flux); }
  function drawSed() {
    let best = null, bd = 90;
    S.blips.forEach(function (b) {
      if (!b.sed || b.sed.filter(validSed).length < 2) return;
      const p = toScreen(b.e, b.n), d = Math.hypot(p[0] - S.W / 2, p[1] - S.H / 2);
      if (d < bd) { bd = d; best = b; }
    });
    if (!best) return;
    const sed = best.sed.filter(validSed);
    const W = 236, H = 132, x0 = 14, y0 = 74, px = x0 + 34, pw = W - 46, py = y0 + 22, ph = H - 54;
    const pos = sed.filter(function (p) { return p.flux > 0; });
    ctx.save();
    ctx.fillStyle = "rgba(6,16,36,.82)"; ctx.strokeStyle = "rgba(62,232,255,.5)"; ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, W, H); ctx.strokeRect(x0, y0, W, H);
    ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.fillStyle = "#cfe4ff"; ctx.textBaseline = "alphabetic";
    ctx.fillText(T("sed_title"), x0 + 8, y0 + 14);
    if (pos.length < 2) { ctx.fillStyle = "rgba(200,225,255,.7)"; ctx.fillText(T("sed_noise"), x0 + 8, y0 + 50); ctx.restore(); return; }
    const lx = function (l) { return px + (Math.log(l) - Math.log(0.7)) / (Math.log(5.2) - Math.log(0.7)) * pw; };
    let lo = Infinity, hi = -Infinity;
    pos.forEach(function (p) { lo = Math.min(lo, p.flux - p.err > 0 ? p.flux - p.err : p.flux / 2); hi = Math.max(hi, p.flux + p.err); });
    lo = Math.log10(lo) - 0.15; hi = Math.log10(hi) + 0.15; if (hi - lo < 1) { const c = (hi + lo) / 2; lo = c - 0.5; hi = c + 0.5; }
    const fy = function (f) { return py + ph - (Math.log10(f) - lo) / (hi - lo) * ph; };
    ctx.strokeStyle = "rgba(160,200,255,.35)"; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py + ph); ctx.lineTo(px + pw, py + ph); ctx.stroke();
    [1, 2, 3, 4, 5].forEach(function (l) { const x = lx(l); ctx.beginPath(); ctx.moveTo(x, py + ph); ctx.lineTo(x, py + ph + 3); ctx.stroke(); ctx.fillStyle = "rgba(200,225,255,.7)"; ctx.fillText(String(l), x - 3, py + ph + 13); });
    ctx.fillText("μm", px + pw - 10, py + ph - 4);
    for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) [1, 2, 5].forEach(function (m) {
      const v = m * Math.pow(10, e), l = Math.log10(v); if (l < lo || l > hi) return;
      const y = fy(v); ctx.fillStyle = "rgba(200,225,255,.7)";
      ctx.fillText(v >= 1 ? String(v) : v.toFixed(Math.max(0, -e)), x0 + 4, y + 3); ctx.beginPath(); ctx.moveTo(px - 3, y); ctx.lineTo(px, y); ctx.stroke();
    });
    ctx.strokeStyle = "#3ee8ff"; ctx.fillStyle = "#3ee8ff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); pos.forEach(function (p, i) { const b = BANDS[p.det], x = lx(Math.sqrt(b[0] * b[1])), y = fy(p.flux); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
    pos.forEach(function (p) {
      const b = BANDS[p.det], x = lx(Math.sqrt(b[0] * b[1])), y = fy(p.flux);
      ctx.beginPath(); ctx.moveTo(lx(b[0]), y); ctx.lineTo(lx(b[1]), y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, fy(p.flux + p.err)); ctx.lineTo(x, p.flux - p.err > 0 ? fy(p.flux - p.err) : py + ph); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 2.8, 0, 6.2832); ctx.fill();
    });
    ctx.fillStyle = "#ffb347"; ctx.fillText(sedVerdict(sed) || (pos.length < 4 ? T("sed_missing", pos.length) : ""), x0 + 8, y0 + H - 6);
    ctx.restore();
  }

  /* ===== Livello Gaia DR3 (MAST/STScI): stelle catalogate con la freccia del moto proprio, come i cataloghi sovrapposti in WiseView ===== */
  function gaiaCellKey(sky) { return (Math.round(sky.ra / 0.04) * 0.04).toFixed(2) + "," + (Math.round(sky.dec / 0.04) * 0.04).toFixed(2); }
  function ensureGaia(sky) {
    if (S.demo || !window.fetch) return;
    const key = gaiaCellKey(sky);
    if (S.gaia.has(key)) return;
    const cell = { state: "loading", stars: [] }; S.gaia.set(key, cell);
    getJson("/api/gaia?ra=" + sky.ra.toFixed(4) + "&dec=" + sky.dec.toFixed(4)).then(function (r) {
      cell.stars = (r.stars || []).map(function (g) { const o = offsetFromSky(S.origin, g.ra, g.dec); g.e0 = o.e; g.n0 = o.n; return g; }); cell.state = "ok"; cell.origin = S.origin;
    }).catch(function () { cell.state = "err"; setTimeout(function () { if (S.gaia.get(key) === cell) S.gaia.delete(key); }, 30000); });
  }
  /* ===== NEOSSat (CSA, immagini al CADC): epoche piu' vecchie di SPHEREx per allungare la baseline ===== */
  function mjdYear(mjd) { return 2000 + (mjd - 51544.5) / 365.25; }
  function neoLoad() {
    S.neo = null;
    if (S.demo || !window.fetch || !S.origin) return;
    const o = S.origin, neo = { state: "loading", obs: [], origin: o }; S.neo = neo; neoReport();
    getJson("/api/neossat?ra=" + o.ra.toFixed(4) + "&dec=" + o.dec.toFixed(4)).then(function (r) {
      if (S.neo !== neo) return;
      neo.obs = r.obs || []; neo.state = "ok"; neoReport();
    }).catch(function () { if (S.neo === neo) { neo.state = "err"; neoReport(); } });
  }
  function neoSummary() {
    const n = S.neo; if (!n || n.state !== "ok" || !n.obs.length) return null;
    const ys = n.obs.map(function (o) { return mjdYear(o.mjd); }), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    const m = S.mission, pm = m ? Math.hypot(m.pmra || 0, m.pmdec || 0) / 1000 : 0;       // mas/anno -> arcsec/anno
    return { n: n.obs.length, y0: y0, y1: y1, ymid: (y0 + y1) / 2, years: S.tagYear - y0, shift: pm * (S.tagYear - (y0 + y1) / 2), pm: pm, first: n.obs[0] };
  }
  function neoReport() {
    const box = $("neo-box"), n = S.neo; if (!box) return;
    box.hidden = false; box.innerHTML = "";
    const h = document.createElement("b"); h.textContent = T("neo_title"); box.appendChild(h);
    const p = document.createElement("p"); p.className = "note";
    const sm = neoSummary();
    if (!n || n.state === "loading") p.textContent = T("neo_loading");
    else if (n.state === "err") p.textContent = T("neo_err");
    else if (!sm) p.textContent = T("neo_none");
    else {
      p.textContent = sm.pm > 0 ? T("neo_found_pm", sm.n, sm.y0.toFixed(1), sm.years.toFixed(1), sm.shift.toFixed(0), (sm.shift / (S.fovDeg * 3600 / 96)).toFixed(0))
                                : T("neo_found", sm.n, sm.y0.toFixed(1), sm.y1.toFixed(1));
      const a = document.createElement("a"); a.href = sm.first.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = " " + T("neo_open");
      p.appendChild(a);
      if (!S.neoToasted) { S.neoToasted = true; toast(T("neo_toast", sm.n, sm.y0.toFixed(1))); }
    }
    box.appendChild(p);
    if (sm && sm.pm > 0 && !S.demo) {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "ghost";
      btn.innerHTML = '<span class="ms">center_focus_strong</span> '; btn.appendChild(document.createTextNode(T("neo_verify")));
      btn.disabled = !!(S.neoRes && S.neoRes.busy); btn.addEventListener("click", neoVerify); box.appendChild(btn);
      neoShowResult(box);
    }
    tmRender(); twRender();
  }
  /* ===== Macchina del tempo: dove era / sara' la stella ogni anno, e quali dati reali esistono per quell'epoca ===== */
  function spherexYears() {
    let lo = Infinity, hi = -Infinity;
    S.sectors.forEach(function (sc) { (sc.frames || []).forEach(function (f) { if (isFinite(f.mjd)) { lo = Math.min(lo, f.mjd); hi = Math.max(hi, f.mjd); } }); });
    return hi > lo ? [mjdYear(lo), mjdYear(hi)] : null;
  }
  function tmEpochs() {
    const out = [{ k: "tm_gaia", y: 2016.0 }], sm = neoSummary(), sx = spherexYears();
    if (sm) out.push({ k: "tm_neo", y: sm.ymid });
    out.push({ k: "tm_sx", y: sx ? (sx[0] + sx[1]) / 2 : S.tagYear });
    return out;
  }
  function tmInfo(y) {
    const m = S.mission; if (!m) return "";
    const a = positionAt(m, {}, 2016.0), b = positionAt(m, {}, y), o = offsetFromSky({ ra: a.ra, dec: a.dec }, b.ra, b.dec);
    const dist = Math.hypot(o.e, o.n), eps = tmEpochs().slice().sort(function (p, q) { return Math.abs(p.y - y) - Math.abs(q.y - y); })[0];
    return T("tm_info", y.toFixed(1), dist.toFixed(0), (dist / (S.fovDeg * 3600 / 96)).toFixed(0), T(eps.k), eps.y.toFixed(1), Math.abs(eps.y - y).toFixed(1)) + " " + T("tm_pos", b.ra.toFixed(5), b.dec.toFixed(5));
  }
  /* data <-> anno decimale (per il selettore di data del browser) */
  function dateToYear(str) {
    const p = String(str).split("-").map(Number); if (p.length !== 3 || !p[0]) return null;
    const t0 = Date.UTC(p[0], 0, 1), t1 = Date.UTC(p[0] + 1, 0, 1), t = Date.UTC(p[0], p[1] - 1, p[2]);
    return p[0] + (t - t0) / (t1 - t0);
  }
  function yearToDate(y) {
    const yr = Math.floor(y), t0 = Date.UTC(yr, 0, 1), t1 = Date.UTC(yr + 1, 0, 1), d = new Date(t0 + (y - yr) * (t1 - t0));
    return d.toISOString().slice(0, 10);
  }
  function tmRender() {
    const box = $("tm-box"), m = S.mission; if (!box) return;
    const sm = neoSummary();
    if (!m || !(m.pmra || m.pmdec) || S.demo) { box.hidden = true; S.tm = null; return; }
    box.hidden = false; box.innerHTML = "";
    const h = document.createElement("b"); h.textContent = T("tm_title"); box.appendChild(h);
    const info = document.createElement("p"); info.className = "note"; info.id = "tm-info";
    const rng = document.createElement("input"); rng.type = "range"; rng.min = "2016"; rng.max = String(Math.ceil(S.tagYear * 10) / 10); rng.step = "0.1"; rng.value = String(S.tm == null ? S.tagYear : S.tm);
    const dt = document.createElement("input"); dt.type = "date"; dt.min = "1990-01-01"; dt.max = "2100-12-31"; dt.className = "tm-date"; dt.title = T("tm_date");
    dt.value = yearToDate(S.tm == null ? S.tagYear : S.tm);
    rng.addEventListener("input", function () { S.tm = parseFloat(rng.value); dt.value = yearToDate(S.tm); info.textContent = tmInfo(S.tm); });
    dt.addEventListener("change", function () {
      const y = dateToYear(dt.value); if (y == null) return;
      S.tm = y; rng.value = String(Math.min(Math.max(y, +rng.min), +rng.max)); info.textContent = tmInfo(y);
    });
    box.appendChild(rng);
    const dl = document.createElement("label"); dl.className = "tm-datelabel"; dl.appendChild(document.createTextNode(T("tm_date") + " ")); dl.appendChild(dt); box.appendChild(dl);
    const row = document.createElement("div"); row.className = "tm-snap";
    tmEpochs().forEach(function (e) {
      const b = document.createElement("button"); b.type = "button"; b.className = "ghost"; b.textContent = T(e.k) + " " + e.y.toFixed(1);
      b.addEventListener("click", function () { S.tm = e.y; rng.value = String(e.y); dt.value = yearToDate(e.y); info.textContent = tmInfo(e.y); }); row.appendChild(b);
    });
    box.appendChild(row);
    info.textContent = S.tm == null ? T("tm_hint") : tmInfo(S.tm); box.appendChild(info);
  }
  function drawTm() {
    const m = S.mission; if (S.tm == null || !m || !(m.pmra || m.pmdec) || !S.origin) return;
    const at = function (y) { const sk = positionAt(m, {}, y), o = offsetFromSky(S.origin, sk.ra, sk.dec); return toScreen(o.e, o.n); };
    ctx.save(); ctx.strokeStyle = "rgba(62,232,255,.5)"; ctx.fillStyle = "rgba(62,232,255,.7)"; ctx.lineWidth = 1;
    const a = at(2016.0), b = at(S.tagYear);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    for (let y = 2016; y <= S.tagYear; y++) { const q = at(y); ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3); }
    const p = at(S.tm); ctx.lineWidth = 2; ctx.strokeStyle = "#3ee8ff"; ctx.beginPath(); ctx.arc(p[0], p[1], 11, 0, 6.2832); ctx.stroke();
    ctx.font = "bold 11px ui-monospace, Consolas, monospace"; ctx.fillStyle = "#3ee8ff"; ctx.fillText(S.tm.toFixed(1), p[0] + 15, p[1] - 12);
    ctx.restore();
  }
  /* ===== Gemelle: compagne in moto proprio comune (Gaia DR3) ===== */
  function twRender() {
    const box = $("tw-box"), m = S.mission; if (!box) return;
    if (!m || !m.plx || S.demo) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = "";
    const h = document.createElement("b"); h.textContent = T("tw_title"); box.appendChild(h);
    const p = document.createElement("p"); p.className = "note"; p.textContent = T("tw_note"); box.appendChild(p);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "ghost";
    btn.innerHTML = '<span class="ms">group</span> '; btn.appendChild(document.createTextNode(T("tw_btn")));
    btn.addEventListener("click", twSearch); box.appendChild(btn);
    const st = document.createElement("p"); st.className = "note"; st.id = "tw-status"; box.appendChild(st);
    const ul = document.createElement("ul"); ul.className = "cards"; ul.id = "tw-list"; box.appendChild(ul);
    if (S.tw && S.tw.mission === m.id) twShow(S.tw.res);
  }
  function twSearch() {
    const m = S.mission; if (!m || !m.plx) return;
    const p = positionAt(m, {}, 2016.0), mine = m.id, st = $("tw-status"); st.textContent = T("tw_loading");
    getJson("/api/gaia_twins?ra=" + p.ra.toFixed(6) + "&dec=" + p.dec.toFixed(6) + "&pmra=" + m.pmra + "&pmdec=" + m.pmdec + "&plx=" + m.plx).then(function (r) {
      if (!S.mission || S.mission.id !== mine) return;
      S.tw = { mission: mine, res: r }; twShow(r);
    }).catch(function (e) { const s = $("tw-status"); if (s) s.textContent = T("tw_err", e.message); });
  }
  function twShow(r) {
    const st = $("tw-status"), ul = $("tw-list"); if (!st || !ul) return;
    ul.innerHTML = ""; const list = r.twins || [];
    st.textContent = list.length ? T("tw_found", list.length, (r.radius || 1).toFixed(2)) : T("tw_none", (r.radius || 1).toFixed(2));
    list.forEach(function (t) {
      const li = document.createElement("li"); li.className = "card";
      const b = document.createElement("button"); b.className = "go"; b.type = "button";
      const h = document.createElement("h3"); h.textContent = t.id;
      const p = document.createElement("p"); p.textContent = T("tw_card", t.mag.toFixed(1), t.sep.toFixed(0), Math.round(t.au));
      b.append(h, p); b.addEventListener("click", function () { twGo(t); }); li.appendChild(b); ul.appendChild(li);
    });
  }
  function twGo(t) {
    getJson("/api/baseline?ra=" + ghNow(t).ra.toFixed(4) + "&dec=" + ghNow(t).dec.toFixed(4)).then(function (r) { t.base = r; }).catch(function () { t.base = { days: 0, n: 0 }; })
      .then(function () { ghBaseText(t); ghGo(t); });
  }
  /* ===== Selettore delle bande: scarica SOLO i rivelatori scelti (piu' fotogrammi utili per banda = piu' sensibilita') ===== */
  function bandRender() {
    const bar = $("band-bar"); if (!bar) return;
    bar.innerHTML = "";
    const sel = S.bandSet, mk = function (label, title, on, fn) {
      const b = document.createElement("button"); b.type = "button"; b.className = "chip-btn" + (on ? " on" : ""); b.textContent = label; b.title = title;
      b.setAttribute("aria-pressed", String(on)); b.addEventListener("click", fn); bar.appendChild(b); return b;
    };
    mk(T("band_chip_all"), T("band_all"), sel.size === 0, function () { bandSet([]); });
    for (let d = 1; d <= 6; d++) (function (d) {
      mk("D" + d, T("band_tip", d, BANDS[d][0], BANDS[d][1]), sel.has(d), function () {
        const n = new Set(sel); if (n.has(d)) n.delete(d); else n.add(d); bandSet(Array.from(n));
      });
    })(d);
    mk(T("band_near"), T("band_near_tip"), sel.size === 3 && [1, 2, 3].every(function (d) { return sel.has(d); }), function () { bandSet([1, 2, 3]); });
    mk(T("band_thermal"), T("band_thermal_tip"), sel.size === 2 && sel.has(5) && sel.has(6), function () { bandSet([5, 6]); });
  }
  function bandSet(list) {
    list = list.filter(function (d) { return d >= 1 && d <= 6; }).sort();
    S.bandSet = new Set(list);
    S.band = list.length && list.length < 6 ? list.map(function (d) { return "SPHEREx-D" + d; }).join(",") : "";
    const sel = $("o-band"); if (sel) sel.value = list.length === 1 ? "SPHEREx-D" + list[0] : "";
    bandRender();
    if (S.mission) warpTo(S.mission);
  }
  /** Verifica sui pixel: il server ricostruisce le coordinate di un'immagine NEOSSat con Gaia e misura dove cade la stella. */
  function neoVerify() {
    const m = S.mission, n = S.neo; if (!m || !n || n.state !== "ok" || S.neoRes && S.neoRes.busy) return;
    const p16 = positionAt(m, {}, 2016.0);
    const cand = n.obs.map(function (o) {                                   // prima le immagini il cui centro e' piu' vicino alla stella alla loro epoca
      const q = positionAt(m, {}, mjdYear(o.mjd)), dE = (o.ra - q.ra) * Math.cos(q.dec * Math.PI / 180), dN = o.dec - q.dec;
      return { o: o, d: Math.hypot(dE, dN) };
    }).filter(function (c) { return c.d < 0.12; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 6);
    const st = S.neoRes = { busy: true, tried: 0, total: cand.length, epoch: S.epoch };
    neoReport();
    if (!cand.length) { st.busy = false; st.fail = "outside"; neoReport(); return; }
    (function next(i) {
      if (i >= cand.length || S.neoRes !== st) { st.busy = false; if (!st.res) st.fail = st.fail || "outside"; neoReport(); return; }
      st.tried = i + 1; neoReport();
      const u = "/api/neossat_check?obs=" + encodeURIComponent(cand[i].o.id) + "&ra=" + p16.ra.toFixed(6) + "&dec=" + p16.dec.toFixed(6) + "&pmra=" + m.pmra + "&pmdec=" + m.pmdec;
      getJson(u).then(function (r) {
        if (S.neoRes !== st) return;
        if (r.ok) { st.res = r; st.busy = false; neoReport(); } else { st.fail = r.reason || "outside"; next(i + 1); }
      }).catch(function () { st.fail = "err"; st.busy = false; neoReport(); });
    })(0);
  }
  function neoShowResult(box) {
    const st = S.neoRes; if (!st) return;
    const d = document.createElement("div"); d.className = "neo-res";
    if (st.busy) { d.textContent = T("neo_verifying", st.tried, st.total); box.appendChild(d); return; }
    if (!st.res) { d.textContent = T("neo_fail_" + (st.fail === "err" ? "err" : st.fail === "no_solution" || st.fail === "few_peaks" ? "solve" : "outside")); box.appendChild(d); return; }
    const r = st.res, k = 4, cv = document.createElement("canvas"), c = r.crop;
    cv.width = c.w * k; cv.height = c.h * k; cv.className = "neo-crop";
    const g = cv.getContext("2d"), im = g.createImageData(c.w, c.h);
    for (let i = 0; i < c.data.length; i++) { const v = c.data[i]; im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    const tmp = document.createElement("canvas"); tmp.width = c.w; tmp.height = c.h; tmp.getContext("2d").putImageData(im, 0, 0);
    g.imageSmoothingEnabled = false; g.drawImage(tmp, 0, 0, cv.width, cv.height);
    const at = function (pt) { return [(pt[0] - c.x0 + 0.5) * k, (pt[1] - c.y0 + 0.5) * k]; };
    const a = at(r.pred), b = at(r.pred2016);
    g.lineWidth = 1.5; g.strokeStyle = "#ff78c8"; g.beginPath(); g.arc(a[0], a[1], 9, 0, 6.2832); g.stroke();
    g.setLineDash([3, 3]); g.strokeStyle = "#ffd666"; g.beginPath(); g.arc(b[0], b[1], 9, 0, 6.2832); g.moveTo(b[0], b[1]); g.lineTo(a[0], a[1]); g.stroke(); g.setLineDash([]);
    if (r.found) { const m = at(r.measured); g.strokeStyle = "#5dffa0"; g.beginPath(); g.moveTo(m[0] - 6, m[1]); g.lineTo(m[0] + 6, m[1]); g.moveTo(m[0], m[1] - 6); g.lineTo(m[0], m[1] + 6); g.stroke(); }
    d.appendChild(cv);
    const t = document.createElement("p"); t.className = "note";
    t.textContent = r.found ? T("neo_res_ok", r.year.toFixed(1), r.offset_arcsec.toFixed(1), r.arcsec_2016.toFixed(0), r.n, r.rms.toFixed(1))
                            : T("neo_res_none", r.year.toFixed(1), r.n, r.rms.toFixed(1));
    d.appendChild(t); box.appendChild(d);
  }
  function drawNeo() {
    const sm = neoSummary(), m = S.mission;
    if (!sm || !m || !(sm.pm > 0) || !S.origin) return;
    const at = function (y) { const sk = positionAt(m, {}, y), o = offsetFromSky(S.origin, sk.ra, sk.dec); return toScreen(o.e, o.n); };
    const a = at(sm.ymid), b = at(S.tagYear);
    ctx.save(); ctx.strokeStyle = "rgba(255,120,200,.9)"; ctx.fillStyle = "rgba(255,120,200,.95)"; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(a[0], a[1], 7, 0, 6.2832); ctx.stroke();
    ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.fillText("NEOSSat " + sm.ymid.toFixed(1), a[0] + 11, a[1] + 3);
    ctx.restore();
  }
  /* ===== Livello AllWISE (IRSA): sorgenti WISE con moto proprio; epoca 2010.56, per vedere dove sono finite oggi ===== */
  function ensureWise(sky) {
    if (S.demo || !window.fetch) return;
    const key = gaiaCellKey(sky);
    if (S.wise.has(key)) return;
    const cell = { state: "loading", stars: [] }; S.wise.set(key, cell);
    getJson("/api/wise?ra=" + sky.ra.toFixed(4) + "&dec=" + sky.dec.toFixed(4)).then(function (r) {
      cell.stars = (r.stars || []).map(function (g) { const o = offsetFromSky(S.origin, g.ra, g.dec); g.e0 = o.e; g.n0 = o.n; return g; }); cell.state = "ok"; cell.origin = S.origin;
    }).catch(function () { cell.state = "err"; setTimeout(function () { if (S.wise.get(key) === cell) S.wise.delete(key); }, 30000); });
  }
  function drawWise() {
    if (!S.showWise || !S.origin) return;
    ensureWise(skyFromOffset(S.origin, S.cam.e, S.cam.n));
    const dt = S.tagYear - 2010.56, k = pxPerArc();
    ctx.save(); ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.textBaseline = "middle";
    const seen = new Set();
    S.wise.forEach(function (cell) {
      if (cell.state !== "ok" || cell.origin !== S.origin) return;
      cell.stars.forEach(function (g) {
        if (seen.has(g.id)) return; seen.add(g.id);
        const pm = Math.hypot(g.pmra, g.pmdec);
        const e1 = g.e0 + g.pmra * dt, n1 = g.n0 + g.pmdec * dt, p = toScreen(e1, n1);
        if (p[0] < -40 || p[1] < -40 || p[0] > S.W + 40 || p[1] > S.H + 40) return;
        ctx.strokeStyle = "rgba(120,255,160,.9)"; ctx.lineWidth = 1.5;
        ctx.strokeRect(p[0] - 6, p[1] - 6, 12, 12);                            // quadrato verde = WISE (Gaia: cerchio)
        const q = toScreen(e1 + g.pmra * 5, n1 + g.pmdec * 5);
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        if (k > 0) { ctx.fillStyle = "rgba(120,255,160,.9)"; ctx.fillText("W2 " + (g.w2 !== null && g.w2 !== undefined ? g.w2.toFixed(1) : "?") + " · " + pm.toFixed(1) + "″/yr", p[0] + 10, p[1] + 14); }
      });
    });
    ctx.restore();
  }

  function drawGaia() {
    if (!S.showGaia || !S.origin) return;
    ensureGaia(skyFromOffset(S.origin, S.cam.e, S.cam.n));
    const year = S.tagYear, dt = year - 2016.0, k = pxPerArc();
    ctx.save(); ctx.font = "10px ui-monospace, Consolas, monospace"; ctx.textBaseline = "middle";
    const seen = new Set();
    S.gaia.forEach(function (cell) {
      if (cell.state !== "ok" || cell.origin !== S.origin) return;
      cell.stars.forEach(function (g) {
        if (seen.has(g.id)) return; seen.add(g.id);
        const pm = Math.hypot(g.pmra, g.pmdec);
        if (pm < 0.5) return;                                                   // solo i movers: le stelle fisse sarebbero migliaia di pallini inutili
        // e = arcsec verso EST, n = verso NORD (stessa convenzione di offsetFromSky): il moto proprio si somma direttamente
        const e1 = g.e0 + (g.pmra || 0) * dt, n1 = g.n0 + (g.pmdec || 0) * dt;
        const p = toScreen(e1, n1);
        if (p[0] < -40 || p[1] < -40 || p[0] > S.W + 40 || p[1] > S.H + 40) return;
        const mover = pm >= 2.0;
        const r = Math.max(3, Math.min(10, 11 - (g.mag || 18) * 0.5));
        ctx.strokeStyle = mover ? "rgba(255,214,102,.95)" : "rgba(120,200,255,.6)"; ctx.lineWidth = mover ? 1.6 : 1;
        ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.2832); ctx.stroke();
        if (true) {                                                              // freccia: dove sara' tra 5 anni
          const q = toScreen(e1 + (g.pmra || 0) * 5, n1 + (g.pmdec || 0) * 5);
          ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
        }
        if (mover) {                                                             // previsione: dove era/sara' ogni anno dal 2016 (epoca Gaia)
          ctx.fillStyle = "rgba(255,214,102,.55)";
          for (let y = 2016; y <= Math.floor(year); y++) { const q = toScreen(g.e0 + (g.pmra || 0) * (y - 2016), g.n0 + (g.pmdec || 0) * (y - 2016)); ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3); }
        }
        if (mover && k > 0) { ctx.fillStyle = "rgba(255,214,102,.9)"; ctx.fillText("G " + (g.mag ? g.mag.toFixed(1) : "?") + " · " + pm.toFixed(1) + "″/yr", p[0] + r + 4, p[1] - 8); }
      });
    });
    ctx.restore();
  }

  function drawWarp(t) {
    if (!S.warp) return;
    const f = (t - S.warp.t0) / S.warp.dur;
    if (f >= 1) { S.warp = null; return; }
    const cx = S.W / 2, cy = S.H / 2, maxr = Math.hypot(cx, cy), strength = Math.sin(Math.PI * f);
    ctx.save(); ctx.lineWidth = 1.5;
    for (let i = 0; i < 90; i++) {
      const ang = (i / 90) * 6.2832 + i * 0.37, r0 = ((i * 53) % 100) / 100;
      const a = maxr * (0.05 + f * r0 * 1.2), b = a + strength * maxr * (0.15 + 0.5 * r0);
      ctx.strokeStyle = "rgba(160,225,255," + (0.15 + 0.6 * strength) + ")";
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(ang) * a, cy + Math.sin(ang) * a); ctx.lineTo(cx + Math.cos(ang) * b, cy + Math.sin(ang) * b); ctx.stroke();
    }
    ctx.fillStyle = "rgba(200,240,255," + (0.35 * strength * strength) + ")"; ctx.fillRect(0, 0, S.W, S.H);
    ctx.restore();
  }

  function drawFloats(t) {
    S.floats = S.floats.filter(function (f) { return t - f.t0 < 1600; });
    S.floats.forEach(function (f) {
      const u = (t - f.t0) / 1600;
      ctx.globalAlpha = 1 - u; ctx.fillStyle = f.color; ctx.font = "bold 16px ui-monospace, Consolas, monospace";
      ctx.fillText(f.text, f.x - 14, f.y - 24 - u * 40); ctx.globalAlpha = 1;
    });
  }

  function draw(t) {
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = "#02040a"; ctx.fillRect(0, 0, S.W, S.H);
    drawStars();
    S.sectors.forEach(function (sec) { if (sec.status !== "ready") drawPending(sec, t); });
    S.sectors.forEach(function (sec) { if (sec.status === "ready" && sec.disp) drawReady(sec); });
    S.sectors.forEach(drawPendingLabel);
    drawBlips(t); drawTags(); drawGaia(); drawWise(); drawNeo(); drawTm(); drawSed(); drawHud(t); drawWarp(t); drawFloats(t);
  }

  /* ============================== 6. GIOCO ============================== */
  function saveContacts() { try { localStorage.setItem("cfd.contacts.v2", JSON.stringify(S.contacts)); } catch (e) { /* senza storage */ } }
  function loadContacts() { try { S.contacts = JSON.parse(localStorage.getItem("cfd.contacts.v2") || "[]"); } catch (e) { S.contacts = []; } }

  function beep(freq, dur) {
    if (!S.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext, ac = beep.ac || (beep.ac = new AC());
      const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = freq; o.type = "sine";
      g.gain.setValueAtTime(0.0001, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur); o.connect(g); g.connect(ac.destination);
      o.start(); o.stop(ac.currentTime + dur + 0.02);
    } catch (e) { /* audio non disponibile */ }
  }

  /** Riquadro di spiegazione in linguaggio semplice (in basso a sinistra). */
  function say(text, force) {
    const b = $("story"); if (!b) return;
    if (!text || (!S.simple && !force)) { if (!text) b.hidden = true; return; }
    $("story-t").textContent = text; b.hidden = false;
  }
  function tourOpen(i) {
    if (!window.Guide) return;
    S.tourI = Math.max(0, Math.min(i, Guide.TOUR.length - 1));
    const st = Guide.TOUR[S.tourI];
    $("tour").hidden = false;
    $("tour-n").textContent = T("tour_step", S.tourI + 1, Guide.TOUR.length);
    $("tour-t").textContent = st.t; $("tour-b").textContent = st.b;
    $("tour-dots").innerHTML = Guide.TOUR.map(function (_, k) { return '<i class="' + (k === S.tourI ? "on" : "") + '"></i>'; }).join("");
    $("tour-prev").disabled = S.tourI === 0;
    $("tour-next-t").textContent = st.go ? T("tour_go") : (S.tourI === Guide.TOUR.length - 1 ? T("tour_done") : T("tour_next"));
  }
  function tourClose() { $("tour").hidden = true; try { localStorage.setItem("cfd.toured", "1"); } catch (e) { /* senza storage */ } }
  function bindGuide() {
    $("b-guide").addEventListener("click", function () { tourOpen(0); });
    $("b-tour").addEventListener("click", function () { tourOpen(0); });
    $("tour-skip").addEventListener("click", tourClose);
    $("tour-prev").addEventListener("click", function () { tourOpen(S.tourI - 1); });
    $("tour-next").addEventListener("click", function () {
      const st = Guide.TOUR[S.tourI];
      if (st.go) { const m = S.missions.find(function (x) { return x.id === st.go; }); tourClose(); if (m) { warpTo(m); setSimple(true); } return; }
      if (S.tourI >= Guide.TOUR.length - 1) tourClose(); else tourOpen(S.tourI + 1);
    });
    $("story-x").addEventListener("click", function () { $("story").hidden = true; });
    $("b-simple").addEventListener("click", function () { setSimple(!S.simple); });
    $("o-sens").addEventListener("change", function (e) {
      TRACK_OPTS.thr = parseFloat(e.target.value) || 4;
      S.sectors.forEach(function (sec) { sec.tracks = undefined; sec.trackStamp = null; });
      S.blips = []; toast(T("toast_sens", TRACK_OPTS.thr <= 3.5 ? T("sens_high") : TRACK_OPTS.thr >= 5 ? T("sens_cautious") : T("sens_normal")));
    });
    $("o-tags").addEventListener("change", function (e) { S.showTags = e.target.checked; });
    $("o-gaia").addEventListener("change", function (e) { S.showGaia = e.target.checked; });
    $("o-wise").addEventListener("change", function (e) { S.showWise = e.target.checked; });
    ghInit();
    $("glossary").innerHTML = Guide.GLOSSARY.map(function (g) { return "<dt>" + g[0] + "</dt><dd>" + g[1] + "</dd>"; }).join("");
    window.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("tour").hidden) tourClose(); else if (e.key === "?" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) tourOpen(0); });
  }
  function setSimple(on) {
    S.simple = !!on; document.body.classList.toggle("simple", S.simple); $("b-simple").classList.toggle("on", S.simple); $("b-simple").setAttribute("aria-pressed", String(S.simple));
    try { localStorage.setItem("cfd.simple", S.simple ? "1" : "0"); } catch (e) { /* senza storage */ }
    const ms = S.mission && window.I18N ? I18N.Tm(S.mission, "story") : (S.mission && S.mission.story);
    if (S.simple && ms) say(ms, true); else if (!S.simple) say("");
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("on"); }, 2600);
  }

  /**
   * L'utente tocca (x, y). Si guadagnano punti SOLO su un oggetto in moto trovato dal PING
   * (almeno 5 immagini, percorso rettilineo a velocita' costante): niente piu' punti per il rumore.
   */
  function attemptContact(x, y) {
    const w = toWorld(x, y);
    let hit = null, hd = 1e9;
    S.blips.forEach(function (b) {
      const sec = S.sectors.get(b.sec), scale = sec ? sec.fov * 3600 / sec.outN : 6;
      b.path.forEach(function (q) { const d = Math.hypot(q[0] - w[0], q[1] - w[1]); if (d < hd && d < Math.max(8, 3 * scale)) { hd = d; hit = b; } });
    });
    if (!hit) { toast(S.blips.length ? T("toast_tap_diamond") : T("toast_press_ping")); return; }
    if (hit.done) { toast(T("toast_already")); return; }
    const pts = 10 + 2 * (hit.count - 5), sky = skyFromOffset(S.origin, hit.e, hit.n);
    hit.done = true;
        S.contacts.unshift({ id: Date.now(), kind: hit.known ? T("contact_kind_id", hit.known) : T("contact_kind_moving"), pts: pts, ra: sky.ra, dec: sky.dec, mission: S.mission.id,
                         name: S.mission.name, frames: hit.count, nFrames: hit.total, speed: hit.speed, drift: !!hit.drift,
                         sed: hit.sed ? hit.sed.filter(validSed).map(function (q) { return { det: q.det, flux: q.flux, err: q.err }; }) : null, known: hit.known || null, year: hit.year || null });
    saveContacts(); renderContacts(); updateRank(); beep(880, 0.18);
    say(window.Guide ? Guide.explainMotion(hit) : "");
    toast(T("toast_contact", hit.known ? hit.known : T("contact_kind_moving"), hit.count, hit.speed.toFixed(1) + (hit.drift ? T("unit_pm_yr") : T("unit_jump_h"))));
  }

  /** PING: cerca tracce di moto nel settore sotto la camera e stima quante ne uscirebbero per puro caso. */
  /** Cerca le tracce in background appena il settore e' completo: il PING poi le mostra soltanto. */
  let worker = null, jobId = 0;
  const jobs = new Map();
  const TRACK_OPTS = { thr: 4, minN: 5, minDisp: 1.2, staticTol: 0.5, maxPairDisp: 12, tol: 0.9 };   // soglia 4σ + posizioni sub-pixel: nel banco sintetico trova oggetti ~25% piu' deboli con 0 falsi allarmi (tests/js/bench_tracks.js)

  function trackSector(sec) {
    if (!sec.trackArrays || sec.trackTimes.length < 5 || !window.Worker) return;
    const stamp = sec.version + ":" + sec.trackTimes.length + ":" + TRACK_OPTS.thr;
    if (sec.trackStamp === stamp) return;
    sec.trackStamp = stamp; sec.tracks = undefined;
    try { worker = worker || new Worker("js/track-worker.js"); } catch (e) { return; }
    worker.onmessage = function (ev) {
      const r = ev.data, job = jobs.get(r.id); jobs.delete(r.id);
      if (!job || job.sec.epoch !== S.epoch || job.sec.trackStamp !== job.stamp) return;
      job.sec.tracks = r.tracks.slice(0, 12); job.sec.chance = r.chance; job.sec.nPeaks = r.nPeaks;
      if (S.pingWanted) showTracks();
    };
    const id = ++jobId; jobs.set(id, { sec: sec, stamp: stamp });
    worker.postMessage({ id: id, arrays: sec.trackArrays, N: sec.outN, sigma: 1, times: sec.trackTimes, opts: TRACK_OPTS });
  }

  function isCatalogued(e, n) {
    const sky = skyFromOffset(S.origin, e, n);
    return S.contacts.some(function (c) { return c.mission === S.mission.id && Math.hypot((c.ra - sky.ra) * Math.cos(sky.dec * Math.PI / 180) * 3600, (c.dec - sky.dec) * 3600) < 4; });
  }

  /** Nome dell'oggetto noto entro 12" da (e, n), o null: un rilevamento su una stella nota non e' una scoperta. */
  function knownNear(e, n) {
    let best = null;
    S.tags.forEach(function (tg) { const o = offsetFromSky(S.origin, tg.ra, tg.dec); if (Math.hypot(o.e - e, o.n - n) < 12) best = window.I18N ? I18N.Ttag(tg) : tg.name; });
    return best;
  }

  function visibleReady() { return Array.from(S.sectors.values()).filter(function (sc) { return sc.status === "ready" && sc.trackTimes && sc.trackTimes.length >= 5 && sectorVisible(sc); }); }

  /**
   * Controparti in Gaia DR3 (server: /api/catalog, dati MAST/STScI) per gli oggetti con moto proprio: una stella nota ha un moto proprio
   * catalogato uguale a quello misurato nelle immagini SPHEREx; se Gaia non la conosce e' un candidato nuovo.
   */
  S.catRes = new Map();
  window.__ds = S;                                      // per ispezione dalla console
  function catKey(b) { return b.ra.toFixed(4) + "," + b.dec.toFixed(4); }
  /** Modalita' sfida: se il PING ritrova la stella Gaia scelta, il punteggio dipende da quanto la nostra misura si avvicina al moto proprio di Gaia. */
  function challengeCheck(b, m) {
    const c = S.challenge;
    if (!c || c.done || m.id !== c.id || m.dpm === undefined) return;
    c.done = true;
    const score = Math.max(10, Math.round(100 * (1 - m.dpm / Math.max(0.5, 0.3 * m.pm))));
    S.contacts.unshift({ id: Date.now(), challenge: true, kind: T("gh_challenge_kind"), pts: score, ra: b.ra, dec: b.dec, mission: S.mission.id, name: c.id,
                         frames: b.count, nFrames: b.total, speed: b.speed, drift: true });
    saveContacts(); renderContacts(); updateRank(); beep(880, 0.18);
    S.floats.push({ t0: performance.now(), x: S.W / 2, y: S.H / 2 - 40, text: score + "%", color: "#ff4fa3" });
    toast(T("gh_challenge_done", c.id, b.speed.toFixed(1), m.pm.toFixed(1), m.dpm.toFixed(1), score));
  }
  function applyCat(b, res) {
    const okm = (res.matches || []).filter(function (m) { return m.dpm === undefined || m.dpm <= Math.max(3, 0.5 * Math.hypot(b.pme, b.pmn)); });
    if (okm.length) {
      const m = okm[0]; b.cat = m;
      b.catText = T("cat_known", m.cat, m.pm.toFixed(1));
      if (!b.known) b.known = m.id;
      b.novel = false;
      challengeCheck(b, m);
    } else if (res.complete) {
      b.catText = T("cat_none"); b.novel = true;
    }
  }
  /** "Nuovo candidato" solo se Gaia ha risposto e non ha nessuna controparte coerente. */
  function catMatch(b) {
    if (b.ra === undefined || !window.fetch) return;
    const key = catKey(b), c = S.catRes.get(key);
    if (c && c.res) { applyCat(b, c.res); return; }
    if (c) return;                                                            // richiesta in corso
    const entry = { res: null }; S.catRes.set(key, entry);
    const base = "/api/catalog?ra=" + b.ra.toFixed(5) + "&dec=" + b.dec.toFixed(5) + "&year=" + b.year.toFixed(2) + "&pme=" + b.pme.toFixed(2) + "&pmn=" + b.pmn.toFixed(2) + "&tol=10";
    const push = function (res) { entry.res = res; S.blips.forEach(function (x) { if (x.drift && catKey(x) === key) applyCat(x, res); }); };
    getJson(base).then(function (g) {
      const ok = !Object.keys(g.errors || {}).length;
      push({ matches: g.matches || [], complete: ok });
      if (!ok) S.catRes.delete(key);                                          // servizio non raggiungibile: si ritenta piu' tardi
    }).catch(function () { S.catRes.delete(key); });
  }

  /** Per una stella con moto proprio noto: quanto si sposta durante le osservazioni SPHEREx disponibili? Sotto ~1.5 px (misurato) il PING non la vede in modo affidabile. */
  function baselineNote(vis) {
    const m = S.mission; if (!m || !(m.pmra || m.pmdec) || !vis.length) return "";
    let lo = Infinity, hi = -Infinity;
    vis.forEach(function (sc) { (sc.frames || []).forEach(function (f) { if (isFinite(f.mjd)) { lo = Math.min(lo, f.mjd); hi = Math.max(hi, f.mjd); } }); });
    if (!(hi > lo)) return "";
    const days = hi - lo, shift = Math.hypot(m.pmra, m.pmdec) / 1000 * days / 365.25, px = shift / (S.fovDeg * 3600 / 96);
    return T(px < 1.5 ? "toast_baseline_short" : "toast_baseline", Math.round(days), shift.toFixed(2), px.toFixed(1));
  }

  /** Controllo contro la verita' Gaia: quanti astri di Gaia con moto proprio >= 1"/anno cadono nei settori analizzati e quanti il PING ha ritrovato. */
  function gaiaRecovery(vis) {
    const seen = new Set(); let n = 0, hit = 0;
    S.gaia.forEach(function (cell) {
      if (cell.state !== "ok" || cell.origin !== S.origin) return;
      cell.stars.forEach(function (g) {
        if (seen.has(g.id) || Math.hypot(g.pmra, g.pmdec) < 1.0 || !(g.mag < 19)) return; seen.add(g.id);
        const inside = vis.some(function (sc) { const h = sc.fov * 3600 / 2 - 8; return Math.abs(g.e0 - sc.e) < h && Math.abs(g.n0 - sc.n) < h; });
        if (!inside) return;
        n++;
        if (S.blips.some(function (b) {
          if (!b.drift || b.year === undefined) return false;
          const dt = b.year - 2016.0;
          return Math.hypot(b.e - (g.e0 + g.pmra * dt), b.n - (g.n0 + g.pmdec * dt)) < 14;
        })) hit++;
      });
    });
    return { n: n, hit: hit };
  }

  /** Mostra le tracce gia' trovate in TUTTI i settori (non solo quello sotto la camera). */
  function showTracks(quiet) {
    S.blips = [];
    S.sectors.forEach(function (sec) {
      const N = sec.outN, scale = sec.fov * 3600 / N, half = (N - 1) / 2;
      (sec.drifters || []).slice(0, 6).forEach(function (r) {                  // moto proprio lento: percorso dai centroidi misurati
        const pts = r.xs.map(function (x, i) { return [sec.e + (half - x) * scale, sec.n + (half - r.ys[i]) * scale]; });
        const last = pts[pts.length - 1];
        if (S.blips.some(function (b) { return Math.hypot(b.e - last[0], b.n - last[1]) < 8; })) return;
        const mjdEnd = r.t0 + Math.max.apply(null, r.ts), sk = skyFromOffset(S.origin, last[0], last[1]);
        S.blips.push({ sec: sec.key, e: last[0], n: last[1], path: pts, count: r.n, total: r.n, rms: 0, drift: true,
                       speed: Math.hypot(r.vx, r.vy) * 365 * scale, done: isCatalogued(last[0], last[1]), known: knownNear(last[0], last[1]),
                       ra: sk.ra, dec: sk.dec, year: 2000 + (mjdEnd - 51544.5) / 365.25, pme: -r.vx * 365 * scale, pmn: -r.vy * 365 * scale, sed: r.sed || null });
      });
      if (!sec.tracks) return;
      sec.tracks.slice(0, 8).forEach(function (t) {
        const pts = t.pts.map(function (r) { return [sec.e + (half - r.x) * scale, sec.n + (half - r.y) * scale]; });
        const last = pts[pts.length - 1];
        if (S.blips.some(function (b) { return Math.hypot(b.e - last[0], b.n - last[1]) < 8; })) return;      // doppione nella sovrapposizione
        S.blips.push({ sec: sec.key, e: last[0], n: last[1], path: pts, count: t.n, total: sec.trackTimes.length, rms: t.rms,
                       speed: Math.hypot(t.vx, t.vy) * scale / 24, done: isCatalogued(last[0], last[1]), known: knownNear(last[0], last[1]) });
      });
    });
    S.blips.forEach(function (b) { if (b.drift) catMatch(b); });
    const vis = visibleReady(), pending = vis.filter(function (sc) { return sc.tracks === undefined; }).length;
    S.pingWanted = pending > 0;
    if (quiet) return;
    const chance = vis.reduce(function (a, sc) { return a + (sc.chance || 0); }, 0);
    const exp = chance < 0.05 ? T("chance_none") : T("chance_some", chance.toFixed(1));
    const gr = gaiaRecovery(vis);
    toast((S.blips.length ? T("toast_ping_found", S.blips.length, exp) : T("toast_ping_none", 0, exp)) +
          (pending ? T("toast_ping_more", pending) : "") + (gr.n ? T("toast_gaia_check", gr.hit, gr.n) : "") + baselineNote(vis));
  }

  function doPing() {
    S.pings.push({ t0: performance.now() }); beep(300, 0.4);
    const vis = visibleReady();
    if (!vis.length) { toast(T("toast_need_zones")); return; }
    vis.forEach(function (sc) { if (sc.tracks === undefined) trackSector(sc); });
    showTracks();
  }

  function updateRank() { $("n-contacts").textContent = S.contacts.length; }

  function renderContacts() {
    const ul = $("contact-list"); ul.innerHTML = "";
    if (!S.contacts.length) { const li = document.createElement("li"); li.className = "note"; li.textContent = T("contacts_empty"); ul.appendChild(li); }
    S.contacts.slice(0, 40).forEach(function (c) {
      const li = document.createElement("li"); li.className = "card contact";
      const a = document.createElement("b"); a.textContent = c.kind;
      const p = document.createElement("span"); p.className = "pts"; p.textContent = c.challenge ? T("acc_pct", c.pts) : "";
      const co = document.createElement("span"); co.className = "co";
      co.textContent = c.name + " · " + fmtRA(c.ra) + " " + fmtDec(c.dec) + " · " + T("contact_images", c.frames, c.nFrames) + " · " + c.speed.toFixed(1) + (c.drift ? T("unit_yr") : T("unit_jump_h"));
      li.title = T("contact_fly_title");
      li.addEventListener("click", function () { const o = offsetFromSky(S.origin, c.ra, c.dec); S.cam.e = o.e; S.cam.n = o.n; S.cam.ve = S.cam.vn = 0; S.viewFov = Math.min(S.viewFov, 300); toast(T("toast_fly_contact")); });
      li.append(a, p, co);
      const si = sedInfo(c.sed);
      if (si) { const sp = document.createElement("span"); sp.className = "co sed-" + si.cls; sp.textContent = T("sed_title") + ": " + T(si.cls === "star" ? "sed_star" : (si.cls === "flat" ? "sed_flat" : "sed_red")) + " (" + (si.idx >= 0 ? "+" : "") + si.idx.toFixed(2) + ")"; li.appendChild(sp); }
      ul.appendChild(li);
    });
  }

  /* ========================= 7. INTERFACCIA E INPUT ========================= */
  function updateLed() {
    const led = $("led"), txt = $("led-text");
    const busy = S.inflight > 0 || S.queue.length > 0;
    led.className = "led " + (busy ? "busy" : S.demo ? "demo" : "live");
    txt.textContent = busy ? T("led_scanning", S.inflight + S.queue.length) : S.demo ? T("led_demo") : T("led_live");
  }

  /** Riga riassuntiva dei flag per le impostazioni: quante immagini hanno pixel segnalati al bersaglio, e quali. */
  function flagSummary(sec) {
    const known = sec.sorted.filter(function (x) { return x.flagNames; });
    if (!known.length) return " " + T("flag_nodata");
    const bad = known.filter(function (x) { return x.flagNames.length; }), cnt = {};
    bad.forEach(function (x) { x.flagNames.forEach(function (n) { cnt[n] = (cnt[n] || 0) + 1; }); });
    const top = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 3).join(", ");
    return " " + T("flag_sum", bad.length, known.length, top || "—");
  }

  function syncTimeline() {
    const c = camSector(), sec = S.sectors.get(keyOf(c.a, c.b)), t = $("timeline");
    const n = sec && sec.disp ? sec.disp.arrays.length : 0;
    t.max = Math.max(0, n - 1); t.disabled = n < 2;
    if (n) t.value = S.tick % n;
    const f = sec && sec.sorted.length ? sec.sorted[Math.min(S.tick % sec.sorted.length, sec.sorted.length - 1)] : null;
    $("frame-info").textContent = !sec ? "—" : sec.status === "loading" ? T("frame_scanning", sec.loaded, sec.total || "?")
      : f ? (n === 1 ? T("frame_stacked", sec.sorted.length) : ((S.tick % n) + 1) + "/" + n + " · " + new Date((f.mjd - 40587) * 86400000).toISOString().slice(0, 10)) + (f.flagNames && f.flagNames.length ? " · " + T("flag_at", f.flagNames.slice(0, 2).join(", ") + (f.flagNames.length > 2 ? "…" : "")) : "") : "—";
    $("o-info").textContent = sec && sec.status === "ready"
      ? T("info_line", sec.det || "?", sec.sorted.length, sec.groupsInfo || "—", sec.aligned || 0, (sec.shiftPx || 0).toFixed(2)) +
        (sec.rots && sec.rots.length ? T("info_tilt", sec.rots.join(" / ")) : "") + T("info_coverage", Math.round(sec.coverage * 100)) + flagSummary(sec)
      : "";
    const lb = $("loadbar");
    if (lb) {                                              // barra di avanzamento sottile sotto la barra superiore
      const fr = sec && sec.status === "loading" && sec.total ? sec.loaded / sec.total : 0;
      lb.firstElementChild.style.width = Math.round(fr * 100) + "%";
      lb.classList.toggle("on", fr > 0 && fr < 1);
    }
    $("r-date").textContent = f ? new Date((f.mjd - 40587) * 86400000).toISOString().slice(0, 10) : "—";
  }

  function updateReadout() {
    const sky = skyFromOffset(S.origin, S.cam.e, S.cam.n);
    $("r-ra").textContent = fmtRA(sky.ra); $("r-dec").textContent = fmtDec(sky.dec);
    syncTimeline();
  }

  /* ===== Cacciatore Gaia: cerca in Gaia DR3 (MAST) stelle con moto proprio notevole e vola a vederle con SPHEREx ===== */
  const GH = { stars: [], busy: false, run: 0 };
  function ghMission(g) {
    const pm = g.pm / 1000;
    return { id: "gaia-" + g.id.replace(/\D/g, ""), name: g.id, ra: g.ra, dec: g.dec, ep: 2016, pmra: g.pmra, pmdec: g.pmdec, plx: g.plx,
             tag: T("gh_tag"), blurb: T("gh_card", pm.toFixed(2), g.mag.toFixed(1), Math.round(g.ly)),
             tags: [{ name: g.id, kind: T("gh_tag") }], story: T("gh_story", g.id, pm.toFixed(2), Math.round(g.ly), g.mag.toFixed(1), Math.round(g.vt)) };
  }
  function ghGo(g, challenge) {
    const m = ghMission(g);
    S.challenge = challenge ? { id: g.id, done: false } : null;
    S.tags = S.tags.filter(function (t) { return t.mission.indexOf("gaia-") !== 0; }).concat(knownTags([m], S.tagYear));
    warpTo(m); closePanelOnPhone();
    if (!g.detectable && !challenge) { const wmsg = T(g.mag < GH_MIN_G ? "gh_warn_bright" : "gh_warn_data"); say(wmsg + " " + m.story, true); toast(wmsg); }
  }
  /** Posizione della stella oggi (epoca delle osservazioni SPHEREx), non quella del catalogo (2016): le osservazioni vanno cercate li'. */
  function ghNow(g) { return positionAt({ ra: g.ra, dec: g.dec, ep: 2016, pmra: g.pmra, pmdec: g.pmdec }, {}, S.tagYear); }
  const GH_MIN_G = 7.0;
  function ghBaseText(g) {
    const px = g.pm / 1000 * g.base.days / 365.25 / (S.fovDeg * 3600 / 96);
    g.detectable = px >= 1.5 && g.mag >= GH_MIN_G;                         // le stelle troppo luminose saturano i rivelatori: il centroide non e' misurabile
    return T(g.detectable ? "gh_base_ok" : "gh_base_no", Math.round(g.base.days), px.toFixed(1));
  }
  /** Controlla in coda (3 alla volta) per quanti giorni SPHEREx ha osservato ogni stella: nell'elenco compaiono SOLO quelle con una baseline abbastanza lunga da vedere il moto proprio. */
  function ghBaselines() {
    const my = ++GH.run, queue = GH.stars.slice(); let done = 0, found = 0;
    const total = queue.length;
    const status = function () { $("gh-status").textContent = done < total ? T("gh_checking", done, total, found) : (found ? T("gh_found", found, total - found) : T("gh_none_detectable", total)); };
    function pump() {
      if (GH.run !== my) return;
      const g = queue.shift(); if (!g) return;
      getJson("/api/baseline?ra=" + ghNow(g).ra.toFixed(4) + "&dec=" + ghNow(g).dec.toFixed(4)).then(function (r) { g.base = r; })
        .catch(function () { g.base = { days: 0, n: 0 }; })
        .then(function () {
          if (GH.run !== my) return;
          done++; ghBaseText(g);
          if (g.detectable) found++;
          ghAddCard(g);
          status(); pump();
        });
    }
    status(); pump(); pump(); pump();
  }
  function ghAddCard(g) {
    const ul = $("gh-list");
    const li = document.createElement("li"); li.className = "card";
    const b = document.createElement("button"); b.className = "go"; b.type = "button";
    const h = document.createElement("h3"); h.textContent = g.id;
    const p = document.createElement("p"); p.textContent = T("gh_card", (g.pm / 1000).toFixed(2), g.mag.toFixed(1), Math.round(g.ly));
    const bs = document.createElement("p"); bs.className = "gh-stats"; bs.textContent = ghBaseText(g);
    b.append(h, p, bs);
    if (!g.detectable) { const w = document.createElement("p"); w.className = "gh-warn-text"; w.textContent = T(g.mag < GH_MIN_G ? "gh_warn_bright" : "gh_warn_data"); b.appendChild(w); li.classList.add("gh-warn"); } b.addEventListener("click", function () { ghGo(g); }); li.appendChild(b);
    if (g.detectable) ul.insertBefore(li, ul.querySelector(".gh-warn")); else ul.appendChild(li);
    $("gh-challenge").hidden = false; $("gh-after").hidden = false;
  }
  function ghRender() {
    $("gh-list").innerHTML = ""; $("gh-challenge").hidden = true; $("gh-after").hidden = false;
    ghBaselines();
  }
  function ghSearch(params) {
    if (GH.busy) return; GH.busy = true; $("gh-status").textContent = T("gh_loading");
    getJson("/api/gaia_search?" + new URLSearchParams(params).toString()).then(function (r) {
      GH.stars = r.stars || []; if (GH.stars.length) ghRender(); else { $("gh-list").innerHTML = ""; $("gh-after").hidden = true; $("gh-status").textContent = T("gh_none"); }
    }).catch(function (e) { $("gh-status").textContent = T("gh_err", e.message); }).then(function () { GH.busy = false; });
  }
  function ghInit() {
    document.querySelectorAll("#gh-presets button").forEach(function (b) { b.addEventListener("click", function () { ghSearch({ preset: b.dataset.p, n: 100 }); }); });
    $("gh-challenge").addEventListener("click", function () {
      const ok = GH.stars.filter(function (g) { return g.detectable; });
      if (!ok.length) { $("gh-status").textContent = T(GH.stars.length ? "gh_challenge_wait" : "gh_challenge_none"); return; }
      const g = ok[Math.floor(Math.random() * ok.length)]; ghGo(g, true); say(T("gh_challenge_go", g.id), true);
    });
  }

  /** Ricerca manuale: "RA Dec" in gradi (o hh:mm:ss dd:mm:ss) oppure un numero Gaia DR3. */
  function manualSearch(q) {
    q = (q || "").trim().replace(/,/g, " ").replace(/\s+/g, " ");
    if (!q) { toast(T("man_bad")); return; }
    const gid = /gaia/i.test(q) ? q.replace(/\D/g, "") : (/^\d{12,}$/.test(q) ? q : "");
    if (gid) {
      toast(T("gh_loading"));
      getJson("/api/gaia_star?id=" + gid).then(function (r) {
        if (!r.star) { toast(T("man_notfound")); return; }
        const m = ghMission(r.star);
        S.challenge = null; S.tags = S.tags.filter(function (t) { return t.mission.indexOf("gaia-") !== 0; }).concat(knownTags([m], S.tagYear));
        warpTo(m); closePanelOnPhone();
      }).catch(function () { toast(T("man_notfound")); });
      return;
    }
    const parts = q.split(" "); let ra, dec;
    const sex = function (t) { const p = t.split(/[:hdms°'"]+/).filter(Boolean).map(Number); if (!p.length || p.some(isNaN)) return NaN; const sg = /^-/.test(t) ? -1 : 1; return sg * (Math.abs(p[0]) + (p[1] || 0) / 60 + (p[2] || 0) / 3600); };
    if (parts.length === 2 && /[:hdms]/.test(q)) { ra = sex(parts[0]) * 15; dec = sex(parts[1]); }
    else if (parts.length === 2) { ra = parseFloat(parts[0]); dec = parseFloat(parts[1]); }
    if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)) { toast(T("man_bad")); return; }
    warpTo({ id: "custom", name: T("man_custom"), ra: ra, dec: dec, tag: T("man_tag"), blurb: "" }); closePanelOnPhone();
  }

  function renderMissions() {
    const ul = $("mission-list"); ul.innerHTML = "";
    S.missions.forEach(function (m) {
      const li = document.createElement("li"); li.className = "card" + (S.mission && S.mission.id === m.id ? " active" : "");
      const b = document.createElement("button"); b.className = "go"; b.type = "button";
      const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = (window.I18N ? I18N.Tm(m, "tag") : m.tag) || "";
      const h = document.createElement("h3"); h.textContent = window.I18N ? I18N.Tm(m, "name") : m.name;
      const p = document.createElement("p"); p.textContent = (window.I18N ? I18N.Tm(m, "blurb") : m.blurb) || "";
      b.append(tag, h, p); b.addEventListener("click", function () { warpTo(m); closePanelOnPhone(); });
      li.appendChild(b); ul.appendChild(li);
    });
  }

  function warpTo(m) {
    S.mission = m; S.origin = (m.pmra || m.pmdec) ? positionAt(m, {}, S.tagYear) : { ra: m.ra, dec: m.dec };   // stelle con moto proprio: posizione ATTUALE
    S.viewFov = Math.max(60, S.fovDeg * 3600 * 1.15); S.epoch++; if (bw) bw.postMessage({ type: "reset" }); S.list = null; S.listFull = null; S.fullDone = false; S.extra = null; S.refKey = null; S.extraReady = false; S.sectors.clear(); S.queue.length = 0; S.blips = []; S.cam = { e: 0, n: 0, ve: 0, vn: 0 }; S.tick = 0;
    S.warp = { t0: performance.now(), dur: 1000 }; beep(200, 0.6);
    S.neoToasted = false; S.neoRes = null; S.tm = null; neoLoad(); tmRender(); twRender();
    renderMissions(); toast((window.I18N ? I18N.Tm(m, "name") : m.name) + " · " + ((window.I18N ? I18N.Tm(m, "tag") : m.tag) || "")); updateUrl();
    const st = window.I18N ? I18N.Tm(m, "story") : m.story; if (st) say(st, true); else say("");
  }

  function updateUrl() {
    if (!S.origin) return;
    const u = new URLSearchParams({ ra: S.origin.ra.toFixed(6), dec: S.origin.dec.toFixed(6), mode: S.mode });
    const id = S.mission ? S.mission.id : "";
    if (/^gaia-\d+$/.test(id)) u.set("star", id.slice(5)); else if (S.missions.some(function (x) { return x.id === id; })) u.set("m", id);   // per riaprire proprio questa stella, con il suo moto proprio
    try { history.replaceState(null, "", "?" + u.toString()); } catch (e) { /* file:// */ }
  }

  function closePanelOnPhone() { if (window.innerWidth < 900) setPanel(false); }
  function setPanel(open) { $("panel").classList.toggle("open", open); $("panel").classList.toggle("closed", !open); $("panel-handle").setAttribute("aria-expanded", String(open)); }
  const MODE_LABEL = { median: "DIFF", prev: T("modeb_prev"), image: "IMG", stack: T("modeb_stack") };

  function setMode(m) {
    S.mode = m; $("o-mode").value = m; $("mode-label").textContent = MODE_LABEL[m]; rebuildAll(); updateUrl();
  }

  function bindUi() {
    $("b-ping").addEventListener("click", doPing);
    $("b-play").addEventListener("click", togglePlay);
    $("b-mode").addEventListener("click", function () { const order = ["median", "prev", "image", "stack"]; setMode(order[(order.indexOf(S.mode) + 1) % order.length]); });
    $("b-zin").addEventListener("click", function () { zoom(0.7); });
    $("b-zout").addEventListener("click", function () { zoom(1 / 0.7); });
    $("timeline").addEventListener("input", function () { S.playing = false; $("b-play").firstElementChild.textContent = "play_arrow"; S.tick = Number($("timeline").value); });
    $("o-mode").addEventListener("change", function (e) { setMode(e.target.value); });
    $("o-fps").addEventListener("input", function (e) { S.fps = Number(e.target.value); });
    $("o-bg").addEventListener("change", function (e) { S.bg = e.target.checked; S.sectors.forEach(function (sc) { sc.refPeaks = null; }); if (bw) bw.postMessage({ type: "clear" }); rebuildAll(); });
    $("o-smooth").addEventListener("change", function (e) { S.smooth = parseFloat(e.target.value) || 0; rebuildAll(); });
    $("o-det").addEventListener("change", function (e) { S.detSel = e.target.value; rebuildAll(); });
    $("o-pre").addEventListener("change", function (e) { S.prefetch = e.target.checked; });
    $("o-sound").addEventListener("change", function (e) { S.sound = e.target.checked; beep(660, 0.1); });
    ["o-fov", "o-count", "o-band"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        S.fovDeg = Number($("o-fov").value); S.count = Number($("o-count").value); S.band = $("o-band").value;
        S.bandSet = new Set(S.band ? [Number(S.band.slice(-1))] : []); bandRender();
        if (S.mission) warpTo(S.mission);
      });
    });
    $("b-report").addEventListener("click", function () {
      const sm = neoSummary();
      Report.open({ contacts: S.contacts, sedInfo: sedInfo, fmtRA: fmtRA, fmtDec: fmtDec, lang: window.I18N ? I18N.lang() : "en",
                    neo: sm ? T(sm.pm > 0 ? "neo_found_pm" : "neo_found", sm.n, sm.y0.toFixed(1), sm.pm > 0 ? sm.years.toFixed(1) : sm.y1.toFixed(1), sm.shift.toFixed(0), (sm.shift / (S.fovDeg * 3600 / 96)).toFixed(0)) : "",
                    snapshot: (function () { try { return scope.toDataURL("image/jpeg", 0.8); } catch (e) { return ""; } })() });
    });
    $("b-share").addEventListener("click", function () {
      const url = location.href;
      const done = function () { toast(T("toast_link")); };
      const fallback = function () { const t = document.createElement("textarea"); t.value = url; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) { toast(url); } t.remove(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback();
    });
    $("b-clear").addEventListener("click", function () { S.contacts = []; saveContacts(); renderContacts(); updateRank(); });
    $("manual").addEventListener("submit", function (e) {
      e.preventDefault(); manualSearch($("m-q").value);
    });
    document.querySelectorAll("#tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.toggle("on", x === b); });
        document.querySelectorAll(".tab").forEach(function (t) { t.hidden = t.id !== "tab-" + b.dataset.tab; });
        const lab = b.querySelector("[data-i]"); $("handle-title").textContent = (lab ? lab.textContent : b.dataset.tab).toUpperCase();
      });
    });
    $("panel-handle").addEventListener("click", function () { setPanel(!$("panel").classList.contains("open")); });
  }

  function togglePlay() { S.playing = !S.playing; $("b-play").firstElementChild.textContent = S.playing ? "pause" : "play_arrow"; }
  function zoom(f) { S.viewFov = Math.max(40, Math.min(2400, S.viewFov * f)); }

  function bindInput() {
    const pts = new Map();
    scope.addEventListener("pointerdown", function (e) {
      scope.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) S.drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: 0, lx: e.clientX, ly: e.clientY, lt: performance.now() };
      else S.drag = null;                           // due dita: pinch
      $("help").classList.add("gone");
    });
    scope.addEventListener("pointermove", function (e) {
      const p = pts.get(e.pointerId); if (!p) return;
      if (pts.size === 2) {                         // pinch: zoom
        const other = Array.from(pts.entries()).find(function (kv) { return kv[0] !== e.pointerId; })[1];
        const d0 = Math.hypot(p.x - other.x, p.y - other.y), d1 = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (d0 > 0) zoom(d0 / d1);
        p.x = e.clientX; p.y = e.clientY; return;
      }
      const d = S.drag; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y, k = pxPerArc();
      d.moved += Math.abs(dx) + Math.abs(dy);
      S.cam.e += dx / k; S.cam.n += dy / k;
      const now = performance.now(), dt = Math.max(1, now - d.lt) / 1000;
      d.ve = dx / k / dt; d.vn = dy / k / dt; d.lt = now;
      d.x = e.clientX; d.y = e.clientY; p.x = e.clientX; p.y = e.clientY;
    });
    function end(e) {
      const d = S.drag; pts.delete(e.pointerId);
      if (!d) return;
      const r = scope.getBoundingClientRect();
      if (d.moved < 6 && performance.now() - d.t < 600) attemptContact(e.clientX - r.left, e.clientY - r.top);
      else if (performance.now() - d.lt < 80) { S.cam.ve = d.ve || 0; S.cam.vn = d.vn || 0; }   // lancio con inerzia
      S.drag = null;
    }
    scope.addEventListener("pointerup", end); scope.addEventListener("pointercancel", end);
    scope.addEventListener("wheel", function (e) { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    window.addEventListener("keydown", function (e) {
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if ("wasd".indexOf(k) >= 0 || k.indexOf("Arrow") === 0) { S.keys[k] = true; e.preventDefault(); $("help").classList.add("gone"); }
      else if (k === " ") { e.preventDefault(); togglePlay(); }
      else if (k === "p") doPing();
      else if (k === "m") $("b-mode").click();
      else if (k === "+" || k === "=") zoom(0.8);
      else if (k === "-") zoom(1.25);
      else if (k === "[") { S.fps = Math.max(1, S.fps - 1); $("o-fps").value = S.fps; }
      else if (k === "]") { S.fps = Math.min(12, S.fps + 1); $("o-fps").value = S.fps; }
      else if (k >= "1" && k <= "9" && S.missions[Number(k) - 1]) warpTo(S.missions[Number(k) - 1]);
    });
    window.addEventListener("keyup", function (e) { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; delete S.keys[k]; });
    window.addEventListener("blur", function () { S.keys = {}; });
    new ResizeObserver(resize).observe($("scope-wrap"));
  }

  /* ============================== 8. AVVIO ============================== */
  let last = performance.now();
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    if (!S.origin) return;
    updateCamera(dt);
    if (S.playing) { S.acc += dt * S.fps; if (S.acc >= 1) { const n = Math.floor(S.acc); S.tick += n; S.acc -= n; } }
    draw(t);
    if (t - S.lastHud > 150) { S.lastHud = t; updateReadout(); }
  }

  async function start() {
    if (window.I18N) {                                  // testi statici + bottoni lingua (EN/IT)
      I18N.applyStatic();
      const le = $("lang-en"), li = $("lang-it");
      if (le && li) {
        (I18N.lang() === "it" ? li : le).classList.add("on");
        le.addEventListener("click", function () { if (I18N.lang() !== "en") I18N.setLang("en"); });
        li.addEventListener("click", function () { if (I18N.lang() !== "it") I18N.setLang("it"); });
      }
    }
    loadContacts(); bindUi(); bandRender(); bindGuide(); bindInput(); resize(); renderContacts(); updateRank(); updateLed();
    try { S.missions = await getJson("data/missions.json"); } catch (e) { S.missions = FALLBACK_MISSIONS; }
    S.tags = knownTags(S.missions, S.tagYear);
    renderMissions();
    const q = new URLSearchParams(location.search);
    setMode(q.get("mode") && MODE_LABEL[q.get("mode")] ? q.get("mode") : "image");
    const ra = parseFloat(q.get("ra")), dec = parseFloat(q.get("dec"));
    let first = (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90)
      ? { id: "custom", name: T("custom_pos"), ra: ra, dec: dec, tag: T("custom_tag"), blurb: "" } : S.missions[0];
    const sid = q.get("star"), mid = q.get("m"), shared = !!(sid || mid);
    if (mid) { const mm = S.missions.find(function (x) { return x.id === mid; }); if (mm) first = mm; }
    if (sid && /^\d{6,20}$/.test(sid)) {                                  // link condiviso a una stella Gaia
      try { const r = await getJson("/api/gaia_star?id=" + sid); if (r.star) { first = ghMission(r.star); S.tags = S.tags.concat(knownTags([first], S.tagYear)); } } catch (e) { /* si apre alla posizione */ }
    }
    let toured = false, simple = false; try { toured = localStorage.getItem("cfd.toured") === "1"; simple = localStorage.getItem("cfd.simple") === "1"; } catch (e) { /* senza storage */ }
    if (simple) setSimple(true);
    setTimeout(function () { $("boot").classList.add("gone"); warpTo(first); if (!toured && !q.get("ra") && !shared) tourOpen(0); }, 450);
    requestAnimationFrame(frame);
    // con la scheda nascosta requestAnimationFrame si ferma: il caricamento dei settori deve continuare lo stesso
    setInterval(function () { if (document.hidden && S.origin) updateCamera(0); }, 700);
  }
  start();
  window.__cfd = S;           // utile per il debug dalla console del browser
})();
