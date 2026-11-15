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
  function open(opts) {
    const t = TX(opts.lang);
    const list = opts.contacts.slice().sort(function (a, b) {
      const ia = opts.sedInfo(a.sed), ib = opts.sedInfo(b.sed);
      return (ib ? ib.idx : -9) - (ia ? ia.idx : -9);
    });
    let h = '<!doctype html><html lang="' + esc(opts.lang) + '"><head><meta charset="utf-8"><title>' + esc(t.title) + '</title><style>body{font:14px/1.45 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}h1{margin:0}h2{border-bottom:1px solid #bbb;padding-bottom:.2rem;margin-top:1.6rem}.c{page-break-inside:avoid;border:1px solid #bbb;border-radius:6px;padding:.7rem 1rem;margin:.8rem 0;display:flex;gap:1rem;flex-wrap:wrap}.c>div{flex:1 1 300px}.cold{color:#b45f00;font-weight:600}.muted{color:#555;font-size:12px}img{max-width:100%;border:1px solid #bbb}@media print{a{color:#000}}</style></head><body>';
    h += '<img src="' + esc(location.href.replace(/[^/]*$/, "") + "img/logo-96.png") + '" width=56 height=56 alt="" style="float:right;border:0">';
    h += "<h1>" + esc(t.title) + "</h1><div class=muted>" + esc(t.sub) + " &middot; " + esc(t.gen) + " " + new Date().toLocaleString(opts.lang === "it" ? "it-IT" : "en-GB") + "</div>";
    if (opts.neo) h += "<p><b>" + esc(t.neo) + ":</b> " + esc(opts.neo) + "</p>";
    if (!list.length) h += "<p>" + esc(t.none) + "</p>";
    list.forEach(function (c, i) {
      const si = opts.sedInfo(c.sed), unit = c.drift ? t.unitYr : t.unitH;
      h += '<div class="c"><div><b>#' + (i + 1) + " " + esc(c.kind) + "</b> (" + esc(c.name) + ")<br>" + esc(t.coords) + ": " + esc(opts.fmtRA(c.ra)) + " " + esc(opts.fmtDec(c.dec)) +
           "<br>" + esc(t.speed) + ": " + Number(c.speed).toFixed(2) + " " + esc(unit) + "<br>" + esc(t.imgs) + ": " + c.frames + "/" + c.nFrames +
           "<br>" + esc(t.gaia) + ": " + (c.known ? esc(c.known) : "<span class=muted>" + esc(t.nogaia) + "</span>");
      if (si) h += '<br><span class="' + (si.cls === "cold" ? "cold" : "") + '">' + esc(t.cls[si.cls]) + "</span><br><span class=muted>" + esc(t.idx) + " = " + si.idx.toFixed(2) + "</span>";
      h += "</div><div>" + (svgSed(c.sed) ? "<div class=muted>" + esc(t.spec) + "</div>" + svgSed(c.sed) : "<span class=muted>" + esc(t.nospec) + "</span>") + "</div></div>";
    });
    if (opts.snapshot) h += "<h2>" + esc(t.view) + '</h2><img alt="" src="' + opts.snapshot + '">';
    h += "<h2>" + esc(t.src) + "</h2><ul>" + SOURCES.map(function (s) { return '<li><a href="' + s[1] + '">' + esc(s[0]) + "</a> <span class=muted>" + s[1] + "</span></li>"; }).join("") + "</ul><p class=muted>" + esc(t.note) + "</p></body></html>";
    const url = URL.createObjectURL(new Blob([h], { type: "text/html" }));
    const w = window.open(url, "_blank");
    if (!w) { const a = document.createElement("a"); a.href = url; a.download = "deepscan-report.html"; document.body.appendChild(a); a.click(); a.remove(); }
  }
  window.Report = { open: open };
})();
