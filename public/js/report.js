/* Report stampabile dei candidati: contatti ordinati per "freddezza" dello spettro SPHEREx, con fonti ufficiali. Si apre in una nuova scheda (Ctrl+P per il PDF). */
(function () {
  "use strict";
  const BANDS = { 1: [0.75, 1.09], 2: [1.09, 1.62], 3: [1.62, 2.42], 4: [2.42, 3.82], 5: [3.82, 4.42], 6: [4.42, 5.00] };
  /* I testi del report stanno in js/i18n.js (chiavi rp_*), nella lingua scelta. */
  function TX(lang) {
    const L = (window.I18N && I18N.LANGS) || { en: {} };
    const R = function (k) { const d = L[lang] || {}; return d["rp_" + k] !== undefined ? d["rp_" + k] : (L.en["rp_" + k] !== undefined ? L.en["rp_" + k] : k); };
    const o = { cls: { star: R("cls_star"), flat: R("cls_flat"), cold: R("cls_cold") } };
    ["title", "sub", "none", "gen", "coords", "speed", "imgs", "spec", "nospec", "idx", "gaia", "nogaia", "neo", "view", "src", "unitYr", "unitH", "note"].forEach(function (k) { o[k] = R(k); });
    return o;
  }
  const SOURCES = [
    ["NASA/IPAC IRSA - SPHEREx", "https://irsa.ipac.caltech.edu/Missions/spherex.html"],
    ["SPHEREx Tutorial Notebooks", "https://caltech-ipac.github.io/irsa-tutorials/spherex/"],
    ["Gaia DR3 (MAST/STScI)", "https://archive.stsci.edu/missions-and-data/gaia"],
    ["CSA NEOSSat", "https://www.asc-csa.gc.ca/eng/satellites/neossat/"],
    ["CADC", "https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/"],
    ["NEOSSat Data Tutorial", "https://github.com/asc-csa/NEOSSAT_Tutorial"],
    ["NEOSSat Dataset", "https://data.asc-csa.gc.ca/dataset/neossat"],
    ["WiseView (inspiration)", "http://byw.tools/wiseview"]
  ];
  function esc(x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function svgSed(sed) {
    const pos = (sed || []).filter(function (p) { return p.flux > 0 && BANDS[p.det]; });
    if (pos.length < 2) return "";
    const W = 300, H = 150, px = 44, py = 12, pw = W - 56, ph = H - 40;
    const lx = function (l) { return px + (Math.log(l) - Math.log(0.7)) / (Math.log(5.2) - Math.log(0.7)) * pw; };
    let lo = Math.min.apply(null, pos.map(function (p) { return Math.max(p.flux - (p.err || 0), p.flux / 2); })), hi = Math.max.apply(null, pos.map(function (p) { return p.flux + (p.err || 0); }));
    lo = Math.log10(lo) - 0.15; hi = Math.log10(hi) + 0.15; if (hi - lo < 1) { const c = (hi + lo) / 2; lo = c - 0.5; hi = c + 0.5; }
    const fy = function (f) { return py + ph - (Math.log10(f) - lo) / (hi - lo) * ph; };
    let o = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="300" height="150" font-family="monospace" font-size="9"><rect width="' + W + '" height="' + H + '" fill="#fff" stroke="#999"/>';
    o += '<path d="M' + px + ' ' + py + 'V' + (py + ph) + 'H' + (px + pw) + '" stroke="#555" fill="none"/>';
    [1, 2, 3, 4, 5].forEach(function (l) { o += '<text x="' + (lx(l) - 3) + '" y="' + (py + ph + 12) + '">' + l + "</text>"; });
    o += '<text x="' + (px + pw - 12) + '" y="' + (py + ph + 24) + '">μm</text>';
    for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) [1, 2, 5].forEach(function (m) { const v = m * Math.pow(10, e), l = Math.log10(v); if (l < lo || l > hi) return; o += '<text x="2" y="' + (fy(v) + 3) + '">' + (v >= 1 ? v : v.toFixed(Math.max(0, -e))) + "</text>"; });
    o += '<polyline fill="none" stroke="#0a7ea4" stroke-width="1.5" points="' + pos.map(function (p) { const b = BANDS[p.det]; return lx(Math.sqrt(b[0] * b[1])).toFixed(1) + "," + fy(p.flux).toFixed(1); }).join(" ") + '"/>';
    pos.forEach(function (p) { const b = BANDS[p.det], x = lx(Math.sqrt(b[0] * b[1])), y = fy(p.flux); o += '<line x1="' + lx(b[0]) + '" x2="' + lx(b[1]) + '" y1="' + y + '" y2="' + y + '" stroke="#0a7ea4"/><line x1="' + x + '" x2="' + x + '" y1="' + fy(p.flux + (p.err || 0)) + '" y2="' + ((p.err || 0) < p.flux ? fy(p.flux - p.err) : py + ph) + '" stroke="#0a7ea4"/><circle cx="' + x + '" cy="' + y + '" r="2.5" fill="#0a7ea4"/>'; });
    return o + "</svg>";
  }
  /** opts: { contacts, sedInfo(sed), fmtRA, fmtDec, neo (riassunto o null), snapshot (dataURL), lang } */
  const CSS = "@page{size:A4;margin:12mm 0 10mm}@page:first{margin:0 0 10mm}*{box-sizing:border-box}body{margin:0;font:13px/1.5 'Segoe UI',system-ui,-apple-system,sans-serif;color:#111827;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}" +
    "@media screen{body{max-width:880px;margin:0 auto;box-shadow:0 0 30px rgba(0,0,0,.12)}}" +
    ".hd{background:#0a1428;color:#fff;padding:22px 30px 18px;display:flex;gap:16px;align-items:center}.hd img{width:56px;height:56px;border-radius:50%;flex:none}" +
    ".hd h1{font-size:21px;margin:0;letter-spacing:.03em;font-weight:700}.hd .sub{color:#9bbbe6;font-size:11.5px;margin-top:3px}" +
    ".hd .tm{margin-left:auto;text-align:right;font-size:10px;letter-spacing:.16em;color:#3ee8ff;line-height:1.6;flex:none}" +
    ".pg{padding:18px 30px 14px}.neo{background:#eef6ff;border-radius:8px;padding:9px 13px;font-size:12px;color:#1e3a5f;margin:0 0 6px}" +
    "h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#1e3a5f;margin:20px 0 8px}h2 span{color:#b45f00}" +
    ".c{break-inside:avoid;border:1px solid #d5deea;border-radius:10px;margin:11px 0;overflow:hidden;display:flex;flex-wrap:wrap}" +
    ".c .l{flex:1 1 250px;padding:12px 15px}.c .r{flex:1 1 300px;padding:12px 15px;background:#f5f8fc}" +
    ".c h3{margin:0 0 2px;font-size:15px}.c h3 small{font-weight:400;color:#5b6b82;font-size:12px}" +
    ".kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 4px;font-size:12px}.kv b{color:#5b6b82;font-weight:500}" +
    ".pills{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}.pill{border-radius:999px;padding:2px 10px;font-size:11px;background:#e6eefa;color:#1e3a5f}" +
    ".pill.cold{background:#fff0d9;color:#9a4d00;font-weight:600}.pill.star{background:#e3f3ff;color:#0a5c85}.pill.ok{background:#e3f6ea;color:#14663a}" +
    ".muted{color:#5b6b82;font-size:11.5px}.r svg{width:100%;height:auto;display:block}" +
    ".snap{margin:0}.snap img{width:100%;border-radius:8px;border:1px solid #0a1428;display:block}.snap figcaption{font-size:11px;color:#5b6b82;margin-top:4px}" +
    ".src{columns:2;column-gap:20px;margin:0;padding:0;list-style:none;font-size:11.5px}.src li{break-inside:avoid;margin:0 0 6px}.src a{color:#0a5c85;text-decoration:none;font-weight:600}.src span{display:block;color:#5b6b82;font-size:10.5px;word-break:break-all}" +
    ".keep{break-inside:avoid}h2{break-after:avoid}.note{margin-top:14px;font-size:11px;color:#5b6b82;border-top:1px solid #d5deea;padding-top:8px}" +
    ".ft{margin-top:6px;padding:9px 30px;font-size:10px;color:#667a96;border-top:1px solid #d5deea;background:#fff;display:flex;justify-content:space-between}";
  function open(opts) {
    const t = TX(opts.lang);
    const list = opts.contacts.slice().sort(function (a, b) {
      const ia = opts.sedInfo(a.sed), ib = opts.sedInfo(b.sed);
      return (ib ? ib.idx : -9) - (ia ? ia.idx : -9);
    });
    const base = location.href.replace(/[^/]*$/, "");
    let h = '<!doctype html><html lang="' + esc(opts.lang) + '"><head><meta charset="utf-8"><title>' + esc(t.title) + "</title><style>" + CSS + "</style></head><body>";
    h += '<div class="hd"><img src="' + esc(base + "img/logo-96.png") + '" alt=""><div><h1>' + esc(t.title) + '</h1><div class="sub">' + esc(t.sub) + " &middot; " + esc(t.gen) + " " +
         new Date().toLocaleString(opts.lang === "it" ? "it-IT" : "en-GB") + '</div></div><div class="tm">TEAM COSMIC FOOTPRINT<br>NASA SPACE APPS 2026</div></div><div class="pg">';
    if (opts.neo) h += '<p class="neo"><b>' + esc(t.neo) + ":</b> " + esc(opts.neo) + "</p>";
    if (!list.length) h += "<p>" + esc(t.none) + "</p>";
    list.forEach(function (c, i) {
      const si = opts.sedInfo(c.sed), unit = c.drift ? t.unitYr : t.unitH, sv = svgSed(c.sed);
      h += '<div class="c"><div class="l"><h3>#' + (i + 1) + " " + esc(c.kind) + " <small>(" + esc(c.name) + ")</small></h3>" +
           '<div class="kv"><b>' + esc(t.coords) + "</b><span>" + esc(opts.fmtRA(c.ra)) + " " + esc(opts.fmtDec(c.dec)) + "</span><b>" + esc(t.speed) + "</b><span>" + Number(c.speed).toFixed(2) + " " + esc(unit) +
           "</span><b>" + esc(t.imgs) + "</b><span>" + c.frames + "/" + c.nFrames + "</span><b>" + esc(t.gaia) + "</b><span>" + (c.known ? esc(c.known) : '<span class="muted">' + esc(t.nogaia) + "</span>") + "</span></div>";
      if (si) h += '<div class="pills"><span class="pill ' + (si.cls === "cold" ? "cold" : si.cls === "star" ? "star" : "") + '">' + esc(t.cls[si.cls]) + '</span><span class="pill">' + esc(t.idx) + " " + si.idx.toFixed(2) + "</span></div>";
      h += '</div><div class="r">' + (sv ? '<div class="muted">' + esc(t.spec) + "</div>" + sv : '<span class="muted">' + esc(t.nospec) + "</span>") + "</div></div>";
    });
    if (opts.snapshot) h += "<h2>" + esc(t.view) + '</h2><figure class="snap"><img alt="" src="' + opts.snapshot + '"></figure>';
    h += '<div class="keep"><h2>' + esc(t.src) + '</h2><ul class="src">' + SOURCES.map(function (s) { return '<li><a href="' + s[1] + '">' + esc(s[0]) + "</a><span>" + s[1] + "</span></li>"; }).join("") + '</ul><p class="note">' + esc(t.note) + "</p></div></div>";
    h += '<div class="ft"><span>Cosmic Footprint Detector &middot; Planet X and SPHEREx</span><span>cosmic-footprint-detector.onrender.com</span></div></body></html>';
    const url = URL.createObjectURL(new Blob([h], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) { const a = document.createElement("a"); a.href = url; a.download = "deepscan-report.html"; document.body.appendChild(a); a.click(); a.remove(); }
  }
  window.Report = { open: open };
})();
