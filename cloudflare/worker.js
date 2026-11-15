/*
 * DEEP SCAN: Cloudflare Worker "ritagliatore" SPHEREx.
 * GET /cut?url=<URL IBE con ?center=RA,DECd&size=S>  ->  FITS minimo (identico a quello prodotto da src/s3_cutout.py).
 * Il Worker legge ~1 MB per fotogramma dal bucket S3 pubblico (rete veloce del datacenter) e rimanda solo ~55 KB.
 * Porting 1:1 di src/s3_cutout.py: se cambi uno, cambia anche l'altro.
 */
const S3_HOST = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/";
const IBE_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/";
const BLOCK = 2880, HEAD_BYTES = 16 * BLOCK;
const HEADS = new Map();                       // url S3 -> {cards, h, off} (cache di isolate)

class Err extends Error {}

function parseCards(u8, start) {
  const dec = new TextDecoder("ascii"), cards = [], h = {};
  let pos = start, done = false;
  while (!done && pos + BLOCK <= u8.length) {
    for (let i = 0; i < 36; i++) {
      const c = dec.decode(u8.subarray(pos + i * 80, pos + (i + 1) * 80));
      const key = c.slice(0, 8).trim();
      if (key === "END") { done = true; break; }
      cards.push(c);
      if (c[8] === "=") {
        let v = c.slice(10).trim();
        if (v.startsWith("'")) { const e = v.indexOf("'", 1); v = (e > 0 ? v.slice(1, e) : v.slice(1)).trim(); }
        else { v = v.split("/")[0].trim(); if (v === "T") v = true; else if (v === "F") v = false; else { const f = Number(v); if (v !== "" && !isNaN(f)) v = f; } }
        h[key] = v;
      }
    }
    pos += BLOCK;
  }
  if (!done) throw new Err("intestazione FITS incompleta");
  return { cards, h, used: pos - start };
}

function cdOf(h) {
  if ("CD1_1" in h) return [[h.CD1_1, h.CD1_2 ?? 0], [h.CD2_1 ?? 0, h.CD2_2]];
  const p = [[h.PC1_1 ?? 1, h.PC1_2 ?? 0], [h.PC2_1 ?? 0, h.PC2_2 ?? 1]];
  return [[h.CDELT1 * p[0][0], h.CDELT1 * p[0][1]], [h.CDELT2 * p[1][0], h.CDELT2 * p[1][1]]];
}
function poly(h, name) {
  const out = [], re = new RegExp("^" + name + "_(\\d+)_(\\d+)$");
  for (const k in h) { const m = re.exec(k); if (m && typeof h[k] === "number") out.push([+m[1], +m[2], h[k]]); }
  return out;
}
function skyToPixel(h, ra, dec) {
  const d2r = Math.PI / 180, a0 = h.CRVAL1 * d2r, d0 = h.CRVAL2 * d2r, a = ra * d2r, d = dec * d2r;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 0) throw new Err("bersaglio dietro il piano tangente");
  const xi = Math.cos(d) * Math.sin(a - a0) / cosc / d2r;
  const et = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc / d2r;
  const cd = cdOf(h), det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
  const u = (cd[1][1] * xi - cd[0][1] * et) / det, v = (-cd[1][0] * xi + cd[0][0] * et) / det;
  const A = poly(h, "A"), B = poly(h, "B");
  let U = u, V = v;
  if (A.length || B.length) for (let i = 0; i < 15; i++) {
    let sa = 0, sb = 0;
    for (const [p, q, c] of A) sa += c * Math.pow(U, p) * Math.pow(V, q);
    U = u - sa;
    for (const [p, q, c] of B) sb += c * Math.pow(U, p) * Math.pow(V, q);
    V = v - sb;
  }
  return [h.CRPIX1 + U - 1, h.CRPIX2 + V - 1];
}

const enc = new TextEncoder();
function card(key, val, comment) {
  let s;
  if (typeof val === "boolean") s = key.padEnd(8) + "= " + (val ? "T" : "F").padStart(20);
  else if (Number.isInteger(val)) s = key.padEnd(8) + "= " + String(val).padStart(20);
  else s = key.padEnd(8) + "= " + String(Number(val.toPrecision(10))).padStart(20);
  if (comment) s += " / " + comment;
  return s.slice(0, 80).padEnd(80);
}
function pad(strs) {                              // lista di carte -> blocchi da 2880
  const n = strs.length * 80, tot = Math.ceil(n / BLOCK) * BLOCK, out = new Uint8Array(tot).fill(32);
  out.set(enc.encode(strs.join("")));
  return out;
}
function buildFits(cards, h, rows, w, hh, x0, y0) {
  const skip = new Set(["XTENSION", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "PCOUNT", "GCOUNT", "EXTNAME", "CRPIX1", "CRPIX2", "CHECKSUM", "DATASUM", "", "COMMENT", "HISTORY"]);
  const prim = ["SIMPLE  =                    T".padEnd(80), card("BITPIX", 8), card("NAXIS", 0), "EXTEND  =                    T".padEnd(80), "END".padEnd(80)];
  const ext = ["XTENSION= 'IMAGE   '".padEnd(80), card("BITPIX", -32), card("NAXIS", 2), card("NAXIS1", w), card("NAXIS2", hh),
    card("PCOUNT", 0), card("GCOUNT", 1), "EXTNAME = 'IMAGE   '".padEnd(80)];
  for (const c of cards) if (!skip.has(c.slice(0, 8).trim())) ext.push(c.slice(0, 80).padEnd(80));
  ext.push(card("CRPIX1", Number(h.CRPIX1) - x0, "spostato dal ritaglio (convenzione IRSA)"), card("CRPIX2", Number(h.CRPIX2) - y0), "END".padEnd(80));
  const ph = pad(prim), eh = pad(ext), bodyLen = Math.ceil(rows.byteLength / BLOCK) * BLOCK;
  const out = new Uint8Array(ph.length + eh.length + bodyLen);
  out.set(ph, 0); out.set(eh, ph.length); out.set(new Uint8Array(rows.buffer, rows.byteOffset, rows.byteLength), ph.length + eh.length);
  return out;
}

async function head(url) {
  if (HEADS.has(url)) return HEADS.get(url);
  const r = await fetch(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` } });
  if (r.status !== 200 && r.status !== 206) throw new Err("S3 HTTP " + r.status);
  const raw = new Uint8Array(await r.arrayBuffer());
  const p = parseCards(raw, 0), e = parseCards(raw, p.used);
  if (e.h.BITPIX !== -32 || Number(e.h.NAXIS) !== 2) throw new Err("formato inatteso");
  const out = { cards: e.cards, h: e.h, off: p.used + e.used };
  if (HEADS.size > 300) HEADS.clear();
  HEADS.set(url, out);
  return out;
}

async function cut(ibe) {
  if (!ibe.startsWith(IBE_PREFIX)) throw new Err("URL non IBE SPHEREx");
  const [base, query = ""] = ibe.split("?");
  const m = /center=([-0-9.]+),([-0-9.]+)d?/.exec(query), s = /size=([0-9.]+)/.exec(query);
  if (!m || !s) throw new Err("center/size mancanti");
  const url = S3_HOST + base.slice(IBE_PREFIX.length), ra = +m[1], dec = +m[2], size = +s[1];
  const { cards, h, off } = await head(url);
  const nx = h.NAXIS1 | 0, ny = h.NAXIS2 | 0, [cx, cy] = skyToPixel(h, ra, dec), cd = cdOf(h);
  const scale = Math.sqrt(Math.abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0])) || 0.0017;
  const half = Math.ceil(size / 2 / Math.abs(scale)) + 2;
  const x0 = Math.max(0, Math.trunc(cx) - half), x1 = Math.min(nx, Math.trunc(cx) + half + 1);
  const y0 = Math.max(0, Math.trunc(cy) - half), y1 = Math.min(ny, Math.trunc(cy) + half + 1);
  if (x1 - x0 < 8 || y1 - y0 < 8) throw new Err("bersaglio fuori dal fotogramma");
  const a = off + y0 * nx * 4, b = off + y1 * nx * 4 - 1;
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` } });
  const buf = await r.arrayBuffer();
  if ((r.status !== 200 && r.status !== 206) || buf.byteLength !== b - a + 1) throw new Err("righe S3 incomplete (HTTP " + r.status + ")");
  const w = x1 - x0, hh = y1 - y0, outRows = new Uint8Array(w * hh * 4);
  for (let y = 0; y < hh; y++) outRows.set(new Uint8Array(buf, (y * nx + x0) * 4, w * 4), y * w * 4);   // resta big-endian
  return buildFits(cards, h, outRows, w, hh, x0, y0);
}

const CORS = { "Access-Control-Allow-Origin": "*" };
export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/ping") return new Response("ok", { headers: CORS });
    if (u.pathname !== "/cut") return new Response("DEEP SCAN cutter", { headers: CORS });
    try {
      const body = await cut(u.searchParams.get("url") || "");
      return new Response(body, { headers: { ...CORS, "Content-Type": "application/fits", "Cache-Control": "public, max-age=86400" } });
    } catch (e) {
      return new Response(String(e.message || e), { status: e instanceof Err ? 422 : 502, headers: CORS });
    }
  },
};
