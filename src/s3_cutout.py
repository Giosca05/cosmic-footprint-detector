"""
Ritagli SPHEREx dal bucket pubblico AWS S3 `nasa-irsa-spherex` con richieste a intervalli di byte (Range).

Perche': il servizio di ritaglio IRSA (IBE) e' lento (~0.4 ritagli/s) e spesso risponde 502. Il file completo
(2040x2040 float32, ~65 MB) e' pero' su S3, non compresso: basta scaricare l'intestazione (32 KB) e le sole
righe che contengono la zona voluta (~1 MB), in parallelo e in poche centinaia di ms.

Il file prodotto e' un FITS minimo (primario vuoto + estensione IMAGE) nella STESSA convenzione del servizio
di ritaglio IRSA, verificata su un ritaglio reale: CRPIX spostato di (x0, y0), tutte le altre carte (SIP compreso)
invariate. Pixel identici al 100% a quelli del servizio IRSA sul campo di prova (confronto 117x117, diff = 0).
"""
from __future__ import annotations

import math
import re
from concurrent.futures import ThreadPoolExecutor

import numpy as np

S3_HOST = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
IBE_PREFIX = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
BLOCK = 2880
HEAD_BYTES = 16 * BLOCK                   # primario + intestazione IMAGE (8 blocchi nei file reali, margine x2)


class S3CutoutError(Exception):
    pass


def s3_url(ibe_url: str) -> tuple[str, float, float, float]:
    """URL IBE (con ?center=RA,DECd&size=S) -> (URL S3, ra, dec, size_deg)."""
    if not ibe_url.startswith(IBE_PREFIX):
        raise S3CutoutError("URL non IBE SPHEREx")
    base, _, query = ibe_url.partition("?")
    m = re.search(r"center=([-0-9.]+),([-0-9.]+)d?", query)
    s = re.search(r"size=([0-9.]+)", query)
    if not m or not s:
        raise S3CutoutError("center/size mancanti")
    return S3_HOST + base[len(IBE_PREFIX):], float(m.group(1)), float(m.group(2)), float(s.group(1))


def parse_cards(raw: bytes) -> tuple[list[str], dict, int]:
    """Legge le carte di una intestazione FITS a partire da raw[0]. Ritorna (carte, dict, byte consumati)."""
    cards, hdr, pos, done = [], {}, 0, False
    while not done and pos + BLOCK <= len(raw):
        for i in range(36):
            c = raw[pos + i * 80: pos + (i + 1) * 80].decode("ascii", "replace")
            key = c[:8].strip()
            if key == "END":
                done = True
                break
            cards.append(c)
            if c[8:9] == "=":
                v = c[10:].strip()
                if v.startswith("'"):
                    v = v[1:v.find("'", 1)].strip() if v.find("'", 1) > 0 else v[1:]
                else:
                    v = v.split("/")[0].strip()
                    if v == "T":
                        v = True
                    elif v == "F":
                        v = False
                    else:
                        try:
                            v = float(v)
                        except ValueError:
                            pass
                hdr[key] = v
        pos += BLOCK
    if not done:
        raise S3CutoutError("intestazione FITS incompleta")
    return cards, hdr, pos


def _poly(h: dict, name: str) -> list[tuple[int, int, float]]:
    out = []
    for k, v in h.items():
        m = re.fullmatch(name + r"_(\d+)_(\d+)", k)
        if m and isinstance(v, float):
            out.append((int(m.group(1)), int(m.group(2)), v))
    return out


def _cd(h: dict) -> list[list[float]]:
    if "CD1_1" in h:
        return [[h["CD1_1"], h.get("CD1_2", 0.0)], [h.get("CD2_1", 0.0), h["CD2_2"]]]
    p = [[h.get("PC1_1", 1.0), h.get("PC1_2", 0.0)], [h.get("PC2_1", 0.0), h.get("PC2_2", 1.0)]]
    return [[h["CDELT1"] * p[0][0], h["CDELT1"] * p[0][1]], [h["CDELT2"] * p[1][0], h["CDELT2"] * p[1][1]]]


def sky_to_pixel(h: dict, ra: float, dec: float) -> tuple[float, float]:
    """(ra, dec) -> pixel 0-based (x, y) con TAN + SIP (inverso per iterazione)."""
    d2r = math.pi / 180
    a0, d0 = h["CRVAL1"] * d2r, h["CRVAL2"] * d2r
    a, d = ra * d2r, dec * d2r
    cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - a0)
    if cosc <= 0:
        raise S3CutoutError("bersaglio dietro il piano tangente")
    xi = math.cos(d) * math.sin(a - a0) / cosc / d2r
    et = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - a0)) / cosc / d2r
    cd = _cd(h)
    det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0]
    u = (cd[1][1] * xi - cd[0][1] * et) / det
    v = (-cd[1][0] * xi + cd[0][0] * et) / det
    A, B = _poly(h, "A"), _poly(h, "B")
    U, V = u, v
    if A or B:
        for _ in range(15):
            U = u - sum(c * U ** p * V ** q for p, q, c in A)
            V = v - sum(c * U ** p * V ** q for p, q, c in B)
    return h["CRPIX1"] + U - 1, h["CRPIX2"] + V - 1


def _card(key: str, val, comment: str = "") -> bytes:
    if isinstance(val, bool):
        v = "T" if val else "F"
        s = f"{key:<8}= {v:>20}"
    elif isinstance(val, int):
        s = f"{key:<8}= {val:>20d}"
    else:
        s = f"{key:<8}= {val:>20.10g}"
    if comment:
        s += " / " + comment
    return s[:80].ljust(80).encode("ascii")


def build_fits(cards: list[str], hdr: dict, data: np.ndarray, x0: int, y0: int, flags: np.ndarray | None = None) -> bytes:
    """Primario vuoto + estensione IMAGE (float32 big-endian): carte originali, CRPIX spostato come fa IRSA."""
    skip = {"XTENSION", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "PCOUNT", "GCOUNT", "EXTNAME", "CRPIX1", "CRPIX2",
            "CHECKSUM", "DATASUM"}
    prim = [b"SIMPLE  =                    T".ljust(80), _card("BITPIX", 8), _card("NAXIS", 0), b"EXTEND  =                    T".ljust(80), b"END".ljust(80)]
    ph = b"".join(prim).ljust(-(-len(prim) * 80 // BLOCK) * BLOCK, b" ")
    ext = [b"XTENSION= 'IMAGE   '".ljust(80), _card("BITPIX", -32), _card("NAXIS", 2),
           _card("NAXIS1", data.shape[1]), _card("NAXIS2", data.shape[0]), _card("PCOUNT", 0), _card("GCOUNT", 1),
           b"EXTNAME = 'IMAGE   '".ljust(80)]
    for c in cards:
        if c[:8].strip() not in skip and c[:8].strip() not in ("", "COMMENT", "HISTORY"):
            ext.append(c.encode("ascii", "replace")[:80].ljust(80))
    ext += [_card("CRPIX1", float(hdr["CRPIX1"]) - x0, "spostato dal ritaglio (convenzione IRSA)"),
            _card("CRPIX2", float(hdr["CRPIX2"]) - y0), b"END".ljust(80)]
    eh = b"".join(ext).ljust(-(-len(ext) * 80 // BLOCK) * BLOCK, b" ")
    body = data.astype(">f4").tobytes()
    body += b"\0" * (-len(body) % BLOCK)
    out = ph + eh + body
    if flags is not None and flags.shape == data.shape:              # estensione FLAGS (bitmap per pixel), stesso ritaglio
        fx = [b"XTENSION= 'IMAGE   '".ljust(80), _card("BITPIX", 32), _card("NAXIS", 2), _card("NAXIS1", flags.shape[1]),
              _card("NAXIS2", flags.shape[0]), _card("PCOUNT", 0), _card("GCOUNT", 1), b"EXTNAME = 'FLAGS   '".ljust(80), b"END".ljust(80)]
        fh = b"".join(fx).ljust(-(-len(fx) * 80 // BLOCK) * BLOCK, b" ")
        fb = flags.astype(">i4").tobytes()
        out += fh + fb + b"\0" * (-len(fb) % BLOCK)
    return out


_HEADS: dict[str, tuple] = {}             # url S3 -> (cards, h, data_off); ~30 KB l'una
_HEADS_LOCK = __import__("threading").Lock()


def _header(session, url: str, timeout: float):
    with _HEADS_LOCK:
        if url in _HEADS:
            return _HEADS[url]
    r = session.get(url, headers={"Range": f"bytes=0-{HEAD_BYTES - 1}"}, timeout=timeout)
    if r.status_code not in (200, 206):
        raise S3CutoutError(f"S3 HTTP {r.status_code}")
    raw = r.content
    if not raw.startswith(b"SIMPLE"):
        raise S3CutoutError("non e' un FITS")
    _, _, p1 = parse_cards(raw)                          # primario
    cards, h, p2 = parse_cards(raw[p1:])                 # estensione IMAGE
    if h.get("BITPIX") != -32 or int(h.get("NAXIS", 0)) != 2:
        raise S3CutoutError("formato inatteso")
    out = (cards, h, p1 + p2)
    with _HEADS_LOCK:
        if len(_HEADS) > 400:
            _HEADS.clear()
        _HEADS[url] = out
    return out


_FHEADS: dict[str, tuple] = {}            # url S3 -> (BITPIX, offset dati FLAGS)


def _flags_header(session, url: str, h: dict, data_off: int, timeout: float):
    """Intestazione dell'estensione FLAGS: subito dopo i dati IMAGE (float32, riempiti a blocchi di 2880 byte)."""
    with _HEADS_LOCK:
        if url in _FHEADS:
            return _FHEADS[url]
    nx, ny = int(h["NAXIS1"]), int(h["NAXIS2"])
    off = data_off + -(-nx * ny * 4 // BLOCK) * BLOCK
    r = session.get(url, headers={"Range": f"bytes={off}-{off + 8 * BLOCK - 1}"}, timeout=timeout)
    if r.status_code not in (200, 206) or not r.content.startswith(b"XTENSION"):
        raise S3CutoutError("estensione FLAGS non trovata")
    _, fh, used = parse_cards(r.content)
    if fh.get("EXTNAME") != "FLAGS" or int(fh.get("NAXIS", 0)) != 2 or int(fh.get("NAXIS1", 0)) != nx or int(fh.get("NAXIS2", 0)) != ny:
        raise S3CutoutError("FLAGS inattese")
    out = (int(fh["BITPIX"]), off + used)
    with _HEADS_LOCK:
        if len(_FHEADS) > 400:
            _FHEADS.clear()
        _FHEADS[url] = out
    return out


def _fetch_flags(session, url: str, h: dict, data_off: int, x0: int, x1: int, y0: int, y1: int, timeout: float):
    """Bitmap FLAGS del ritaglio (int32) oppure None: i flag sono un extra, un errore qui non deve mai rompere l'immagine."""
    try:
        bitpix, foff = _flags_header(session, url, h, data_off, timeout)
        nx = int(h["NAXIS1"])
        item = abs(bitpix) // 8
        dt = {32: ">i4", 16: ">u2", 8: "u1"}.get(bitpix)
        if dt is None:
            return None
        a, b = foff + y0 * nx * item, foff + y1 * nx * item - 1
        r = session.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=timeout)
        if r.status_code not in (200, 206) or len(r.content) != b - a + 1:
            return None
        return np.frombuffer(r.content, dtype=dt).reshape(y1 - y0, nx)[:, x0:x1].astype(np.int32)
    except Exception:                                    # noqa: BLE001
        return None


def fetch_cutout(session, ibe_url: str, timeout: float = 25.0) -> bytes:
    """Scarica solo intestazione + righe necessarie da S3 e restituisce il FITS del ritaglio."""
    url, ra, dec, size = s3_url(ibe_url)
    cards, h, data_off = _header(session, url, timeout)
    nx, ny = int(h["NAXIS1"]), int(h["NAXIS2"])
    cx, cy = sky_to_pixel(h, ra, dec)
    cd = _cd(h)
    scale = math.sqrt(abs(cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0])) or 0.0017   # gradi/pixel
    half = int(math.ceil(size / 2 / abs(scale))) + 2
    x0, x1 = max(0, int(cx) - half), min(nx, int(cx) + half + 1)
    y0, y1 = max(0, int(cy) - half), min(ny, int(cy) + half + 1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise S3CutoutError("bersaglio fuori dal fotogramma")
    a, b = data_off + y0 * nx * 4, data_off + y1 * nx * 4 - 1
    with ThreadPoolExecutor(max_workers=1) as ex:        # i flag si scaricano in parallelo all'immagine
        fut = ex.submit(_fetch_flags, session, url, h, data_off, x0, x1, y0, y1, timeout)
        r = session.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=timeout)
        flags = fut.result()
    if r.status_code not in (200, 206) or len(r.content) != b - a + 1:
        raise S3CutoutError(f"righe S3 incomplete (HTTP {r.status_code})")
    rows = np.frombuffer(r.content, dtype=">f4").reshape(y1 - y0, nx)[:, x0:x1]
    return build_fits(cards, h, rows, x0, y0, flags)
