"""
web_server.py: piccolo server locale di Cosmic Footprint Detector (public/explore.html).

PERCHE': il browser non puo' (in modo affidabile) chiamare IRSA direttamente (CORS) ne'
leggere i ritagli FITS. Questo server fa da ponte e riusa src/api_client.py: query mirate,
rate limiting, retry, cache su disco e limiti di sicurezza.

ENDPOINT
  GET /                      -> reindirizza a /explore.html (Cosmic Footprint Detector)
  GET /api/images?ra=&dec=&size=&bandpass=&max=
        elenco immagini SPHEREx che coprono (ra, dec): [{uri, time_bounds_lower (MJD)}]
  GET /api/cutout?url=...    -> ritaglio FITS (solo URL IRSA piccoli, vedi check_cutout_url)
  GET /...                   -> file statici di public/

MODALITA' DEMO (--demo): immagini SINTETICHE (stelle fisse + un oggetto in moto + una
variabile), senza rete. Serve a provare l'interfaccia e a fare demo anche se IRSA e' lento.

VELOCITA': la lentezza e' quasi tutta di IRSA (ogni ritaglio viene creato al momento).
    python -m src.web_server --warm       # PRIMA della demo: scarica in cache i 5 bersagli
    (dopo, i ritagli escono dal disco in pochi millisecondi; la cache e' data/raw/cutouts)

USO:
    python -m src.web_server              # dati reali (serve rete)
    python -m src.web_server --demo       # dati sintetici
    poi apri http://localhost:8000
"""
from __future__ import annotations

import argparse
import csv
import io
import hashlib
import os
import json
import math
import mimetypes
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutTimeout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

from src import config
from src.api_client import ApiError, ApiInputError, IrsaClient

PUBLIC_DIR = config.ROOT / "public"
DEMO_FRAMES = 24
DEMO_SIZE = 64
MAX_FRAMES = 200
SPAN_START_MJD, SPAN_END_MJD, SPAN_STEP_DAYS, SPAN_TIMEOUT_S = 60700, 61500, 160, 55      # fasce di date per order=span (10 query piccole)

CLIENT: IrsaClient | None = None
DEMO = False


# ============================================================================
# 1. FITS sintetico per la demo (nessuna dipendenza oltre numpy)
# ============================================================================
def _card(key: str, value, comment: str = "") -> bytes:
    if isinstance(value, str):
        v = f"'{value:<8}'"
    elif isinstance(value, bool):
        v = "T" if value else "F"
    elif isinstance(value, float):
        v = f"{value:.12g}"
    else:
        v = str(value)
    return f"{key:<8}= {v:>20}".ljust(80).encode("ascii")


def _header(cards: list[bytes]) -> bytes:
    raw = b"".join(cards) + "END".ljust(80).encode("ascii")
    return raw + b" " * (-len(raw) % 2880)


PIX_ARCSEC = 6.15            # scala dei pixel SPHEREx (circa)


def _cell_rng(*ints) -> np.random.Generator:
    return np.random.default_rng([int(i) + 1_000_000 for i in ints])


def demo_stars(ra0: float, dec0: float, half_deg: float) -> list[tuple]:
    """Stelle FISSE deterministiche (ra, dec, ampiezza, variabile?): stesso cielo in ogni settore."""
    cell = 0.01
    out = []
    for i in range(math.floor((ra0 - half_deg) / cell), math.floor((ra0 + half_deg) / cell) + 1):
        for j in range(math.floor((dec0 - half_deg) / cell), math.floor((dec0 + half_deg) / cell) + 1):
            r = _cell_rng(i, j, 7)
            if r.random() < 0.5:
                out.append(((i + r.random()) * cell, (j + r.random()) * cell, r.uniform(25, 160), r.random() < 0.12))
    return out


def demo_mover(ra: float, dec: float, index: int, n: int = DEMO_FRAMES):
    """Un oggetto in moto per ogni cella di 0.06 gradi (cosi' ogni campo di 6' ne contiene almeno uno)."""
    cell = 0.06
    ci, cj = round(ra / cell), round(dec / cell)          # cella il cui centro e' piu' vicino al campo
    r = _cell_rng(ci, cj, 11)
    ra_c, dec_c = ci * cell + (r.random() - 0.5) * 0.01, cj * cell + (r.random() - 0.5) * 0.01
    t = index - (n - 1) / 2
    cosd = max(0.05, math.cos(math.radians(dec_c)))
    return ra_c + t * 9.0 / 3600 / cosd, dec_c + t * 3.5 / 3600


def make_demo_fits(index: int, ra_deg: float, dec_deg: float, size_deg: float = 0.1,
                   n: int = DEMO_FRAMES) -> bytes:
    """
    FITS sintetico con WCS: ogni fotogramma ha puntamento e rotazione leggermente diversi
    (come rivelatori diversi), quindi serve il riallineamento per vedere le stelle ferme.
    """
    npx = max(16, round(size_deg * 3600 / PIX_ARCSEC))
    rot = math.radians(((index * 5) % 7 - 3) * 0.6)
    d_e, d_n = ((index * 13) % 7 - 3) * 1.6, ((index * 29) % 7 - 3) * 1.6          # arcsec
    cosd = math.cos(math.radians(dec_deg))
    crval1, crval2 = ra_deg + d_e / 3600 / cosd, dec_deg + d_n / 3600
    cd = PIX_ARCSEC / 3600
    cd11, cd12, cd21, cd22 = -cd * math.cos(rot), cd * math.sin(rot), cd * math.sin(rot), cd * math.cos(rot)
    crpix = (npx + 1) / 2

    yy, xx = np.mgrid[1:npx + 1, 1:npx + 1].astype(float)
    dx, dy = xx - crpix, yy - crpix
    east = (cd11 * dx + cd12 * dy) * 3600 + d_e           # arcsec dal centro richiesto
    north = (cd21 * dx + cd22 * dy) * 3600 + d_n
    ra_px, dec_px = ra_deg + east / 3600 / cosd, dec_deg + north / 3600

    def blob(ra, dec, amp, sig=5.0):
        dist2 = ((ra_px - ra) * cosd * 3600) ** 2 + ((dec_px - dec) * 3600) ** 2
        return amp * np.exp(-dist2 / (2 * sig ** 2))

    seed = _cell_rng(index, int(ra_deg * 1000), int(dec_deg * 1000))
    img = 100.0 + 4 * (index % 3) + seed.normal(0, 2.0, (npx, npx))
    for k, (sra, sdec, amp, var) in enumerate(demo_stars(ra_deg, dec_deg, size_deg * 0.8)):
        img += blob(sra, sdec, amp * (1 + 0.8 * math.sin(2 * math.pi * index / 9)) if var else amp)
    mra, mdec = demo_mover(ra_deg, dec_deg, index, n)
    img += blob(mra, mdec, 80)
    data = img.astype(">f4")

    primary = _header([_card("SIMPLE", True), _card("BITPIX", 8), _card("NAXIS", 0), _card("EXTEND", True)])
    ext = _header([_card("XTENSION", "IMAGE"), _card("BITPIX", -32), _card("NAXIS", 2),
                   _card("NAXIS1", npx), _card("NAXIS2", npx), _card("PCOUNT", 0), _card("GCOUNT", 1),
                   _card("EXTNAME", "IMAGE"), _card("CTYPE1", "RA---TAN"), _card("CTYPE2", "DEC--TAN"),
                   _card("CRVAL1", float(crval1)), _card("CRVAL2", float(crval2)),
                   _card("CRPIX1", float(crpix)), _card("CRPIX2", float(crpix)),
                   _card("CD1_1", cd11), _card("CD1_2", cd12), _card("CD2_1", cd21), _card("CD2_2", cd22)])
    body = data.tobytes()
    return primary + ext + body + b"\0" * (-len(body) % 2880)


def demo_images(ra: float, dec: float, size_deg: float, n: int) -> list[dict]:
    n = min(n, DEMO_FRAMES)
    return [{"uri": f"demo://frame/{i}?ra={ra}&dec={dec}&size={size_deg}",
             "time_bounds_lower": round(61000.0 + i * 0.9, 3)} for i in range(n)]


# ============================================================================
# 2. Gestione richieste
# ============================================================================
SPAN_LOG: list = []      # ultimi esiti delle fasce (diagnostica: finiscono nella risposta JSON)


def span_window(adql: str):
    """
    Una fascia di date: dalla cache se c'e', altrimenti UNA sola richiesta con timeout breve e senza retry.
    Se IRSA e' lenta la fascia viene saltata (None) e l'elenco e' marcato "partial": le fasce riuscite restano
    in cache, quindi il tentativo successivo le trova subito e completa il resto.
    """
    import csv, io
    import requests
    from src.api_client import _coerce
    cached = CLIENT._load_cache(adql)
    if cached:
        return cached[0]
    t0 = time.time()
    try:
        resp = CLIENT.session.get(config.IRSA_TAP_SYNC_URL, timeout=SPAN_TIMEOUT_S,
                                  params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql})
        if resp.status_code != 200 or resp.text.lstrip().startswith("<"):
            SPAN_LOG.append(f"HTTP {resp.status_code} {time.time() - t0:.1f}s {resp.text[:160]!r}")
            return None
        rows = [{k: _coerce(v) for k, v in row.items()} for row in csv.DictReader(io.StringIO(resp.text))]
        CLIENT._save_cache(adql, rows)
        SPAN_LOG.append(f"ok {len(rows)} righe {time.time() - t0:.1f}s")
        return rows
    except requests.RequestException as exc:
        SPAN_LOG.append(f"errore {type(exc).__name__} {time.time() - t0:.1f}s")
        return None


SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
SIA_COLLECTIONS = ("spherex_dr1", "spherex_qr3")     # dr1 = prime osservazioni (2025), qr3 = le piu' recenti: servono ENTRAMBE per avere mesi di baseline
SIA_TIMEOUT_S = 40
SIA_TTL_S = 6 * 3600


S3 = {"off_until": 0.0, "fails": 0, "ok": 0, "irsa": 0, "last_err": "", "sem": __import__("threading").BoundedSemaphore(8)}


class NoCoverage(Exception):
    """Il punto cade fuori dal rivelatore di questa immagine: nessun servizio (nemmeno IRSA) puo' ritagliarla."""


WORKER = {"off_until": 0.0, "fails": 0, "ok": 0, "last_err": ""}


def worker_url() -> str:
    """URL del Worker Cloudflare: variabile CFD_WORKER oppure prima riga di data/worker_url.txt (vuoto = disattivato)."""
    u = os.environ.get("CFD_WORKER", "").strip()
    if not u:
        f = Path(config.DATA_DIR) / "worker_url.txt" if hasattr(config, "DATA_DIR") else None
        if f is not None and f.exists():
            u = (f.read_text(encoding="utf-8").splitlines() or [""])[0].strip()
    return u if u.startswith("http") else ""


def cutout_path(url: str) -> Path:
    """Percorso in cache di un ritaglio (chiave = hash dell'URL)."""
    stem = url.split("?")[0].rsplit("/", 1)[-1].replace(".fits", "")
    key = __import__("hashlib").sha256(url.encode("utf-8")).hexdigest()[:8]
    return config.CUTOUT_DIR / f"{stem}_{key}.fits"


ACTIVITY = {"t": 0.0}                                   # ultimo momento in cui la PAGINA ha chiesto dati (il precarico si ferma)
PREFETCH = None                                          # Prefetcher in esecuzione (src/prefetch.py)


def fast_cutout(url: str) -> Path:
    """
    Ritaglio dalla cache; se manca prova il bucket S3 pubblico (richieste a intervalli di byte, ~1 MB invece di 4 MB e
    senza il servizio ritagli lento di IRSA), poi ripiega su IRSA. S3 non si disattiva MAI per sempre: dopo 5 errori di
    rete consecutivi si sospende per 60 s (poi si riprova), e ogni errore viene stampato per intero.
    """
    from src import api_client as _ac, s3_cutout
    _ac.check_cutout_url(url)
    stem = url.split("?")[0].rsplit("/", 1)[-1].replace(".fits", "")
    path = cutout_path(url)
    if path.exists():
        return path
    wk = worker_url()
    if wk and time.time() >= WORKER["off_until"]:
        try:                                                 # ritaglio fatto dal Worker Cloudflare: arrivano solo ~55 KB
            r = CLIENT.session.get(wk.rstrip("/") + "/cut", params={"url": url}, timeout=30)
            if r.status_code == 200 and r.content.startswith(b"SIMPLE"):
                config.CUTOUT_DIR.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(r.content)
                tmp.replace(path)
                WORKER["ok"] += 1
                WORKER["fails"] = 0
                return path
            if r.status_code == 422 and ("fuori dal" in r.text or "dietro" in r.text):
                raise NoCoverage(r.text[:80])
            if r.status_code != 422:
                raise RuntimeError(f"HTTP {r.status_code} {r.text[:80]}")
        except NoCoverage:
            raise
        except Exception as exc:                             # noqa: BLE001
            WORKER["fails"] += 1
            WORKER["last_err"] = f"{type(exc).__name__}: {str(exc)[:160]}"
            print(f"  [Worker] errore #{WORKER['fails']}: {WORKER['last_err']} -> uso S3/IRSA")
            if WORKER["fails"] >= 5:
                WORKER["off_until"] = time.time() + 60
                WORKER["fails"] = 0
    if time.time() >= S3["off_until"]:
        try:
            with S3["sem"]:                                  # max 8 letture S3 insieme: la banda e' una sola
                data = s3_cutout.fetch_cutout(CLIENT.session, url, timeout=20)
            config.CUTOUT_DIR.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(path)
            S3["fails"] = 0
            S3["ok"] += 1
            return path
        except s3_cutout.S3CutoutError as exc:               # caso normale (es. bersaglio fuori dal rivelatore): niente penalita'
            if "fuori dal" in str(exc) or "dietro" in str(exc):
                raise NoCoverage(str(exc))
            S3["last_err"] = f"{type(exc).__name__}: {exc}"
            print(f"  [S3] {stem[-30:]}: {str(exc)[:80]} -> uso IRSA")
        except Exception as exc:                             # noqa: BLE001 (rete, timeout, SSL...)
            S3["fails"] += 1
            S3["last_err"] = f"{type(exc).__name__}: {str(exc)[:160]}"
            print(f"  [S3] errore di rete #{S3['fails']}: {S3['last_err']} -> uso IRSA")
            if S3["fails"] >= 5:
                S3["off_until"] = time.time() + 60
                S3["fails"] = 0
                print("  [S3] 5 errori di fila: pausa di 60 s, poi riprovo")
    S3["irsa"] += 1
    return CLIENT.download_cutout(url)


BENCH_KEYS = ["dr1/level2/2025W34_1B/l2b-v27-2026-228/5/level2_2025W34_1B_0557_4D5_spx_l2b-v27-2026-228.fits", "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0090_4D5_spx_l2b-v27-2026-229.fits", "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0557_1D5_spx_l2b-v27-2026-229.fits", "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0557_2D5_spx_l2b-v27-2026-229.fits", "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0557_3D5_spx_l2b-v27-2026-229.fits", "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0557_4D5_spx_l2b-v27-2026-229.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_1D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_2D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_3D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_4D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0444_1D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0444_2D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0444_3D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0444_4D5_spx_l2b-v27-2026-230.fits", "dr1/level2/2025W35_2A/l2b-v27-2026-231/5/level2_2025W35_2A_0221_1D5_spx_l2b-v27-2026-231.fits", "dr1/level2/2025W35_2A/l2b-v27-2026-231/5/level2_2025W35_2A_0221_2D5_spx_l2b-v27-2026-231.fits", "dr1/level2/2025W35_2A/l2b-v27-2026-231/5/level2_2025W35_2A_0221_3D5_spx_l2b-v27-2026-231.fits", "dr1/level2/2025W35_2A/l2b-v27-2026-231/5/level2_2025W35_2A_0221_4D5_spx_l2b-v27-2026-231.fits", "dr1/level2/2025W35_2A/l2b-v27-2026-231/5/level2_2025W35_2A_0418_1D5_spx_l2b-v27-2026-231.fits", "dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0501_1D5_spx_l2b-v27-2026-234.fits", "dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0501_2D5_spx_l2b-v27-2026-234.fits", "dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0501_3D5_spx_l2b-v27-2026-234.fits", "dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0501_4D5_spx_l2b-v27-2026-234.fits", "dr1/level2/2026W11_2A/l2b-v27-2026-234/5/level2_2026W11_2A_0513_1D5_spx_l2b-v27-2026-234.fits"]


def bench_s3(mode: str, threads: int, frames: int) -> dict:
    """
    Misura la velocita' REALE dal tuo PC verso S3 (diagnostica, /api/bench?mode=contig|rows|chunks&threads=16&frames=12):
      contig = 117 righe contigue per fotogramma (come i ritagli veloci), rows = una richiesta per riga (468 B utili),
      chunks = come contig ma ogni fotogramma spezzato in 4 richieste parallele.
    """
    import concurrent.futures as cf
    import requests
    from requests.adapters import HTTPAdapter
    sess = requests.Session()
    sess.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=max(8, threads * 2)))
    base = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
    ROW, OFF, H = 8160, 25920, 117
    nbytes = [0]
    lock = __import__("threading").Lock()

    def get(url: str, a: int, b: int) -> int:
        r = sess.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=30)
        with lock:
            nbytes[0] += len(r.content)
        return r.status_code

    def one_frame(i: int) -> int:
        url = base + BENCH_KEYS[i % len(BENCH_KEYS)]
        y0 = 200 + (i * 53) % 1500
        a, b = OFF + y0 * ROW, OFF + (y0 + H) * ROW - 1
        if mode == "contig":
            return get(url, a, b)
        if mode == "chunks":
            step = (b - a + 1) // 4
            with cf.ThreadPoolExecutor(4) as ex:
                return max(ex.map(lambda k: get(url, a + k * step, a + (k + 1) * step - 1 if k < 3 else b), range(4)))
        raise ValueError(mode)

    t0 = time.time()
    if mode == "rows":
        jobs = [(base + BENCH_KEYS[i % len(BENCH_KEYS)], OFF + (200 + (i * 53) % 1500 + j) * ROW + 1500 * 4) for i in range(frames) for j in range(H)]
        with cf.ThreadPoolExecutor(threads) as ex:
            codes = list(ex.map(lambda jb: get(jb[0], jb[1], jb[1] + 467), jobs))
        reqs = len(jobs)
    else:
        with cf.ThreadPoolExecutor(threads) as ex:
            codes = list(ex.map(one_frame, range(frames)))
        reqs = frames * (4 if mode == "chunks" else 1)
    dt = time.time() - t0
    return {"mode": mode, "threads": threads, "frames": frames, "requests": reqs, "seconds": round(dt, 2),
            "per_frame_s": round(dt / frames, 3), "MB": round(nbytes[0] / 1e6, 2), "Mbit_s": round(nbytes[0] * 8 / 1e6 / dt, 1),
            "bad": sum(1 for c in codes if c not in (200, 206))}


def s3_selftest() -> None:
    """All'avvio: una lettura di prova da S3, cosi' nel terminale si vede subito se il percorso veloce funziona."""
    t0 = time.time()
    try:
        r = CLIENT.session.get(
            "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/level2/2026W33_2A/l2b-v27-2026-241/6/"
            "level2_2026W33_2A_0594_3D6_spx_l2b-v27-2026-241.fits", headers={"Range": "bytes=0-2879"}, timeout=10)
        print(f"  [S3] prova: HTTP {r.status_code}, {len(r.content)} byte in {(time.time() - t0) * 1000:.0f} ms -> "
              + ("ritagli veloci ATTIVI" if r.status_code in (200, 206) else "S3 non disponibile, uso IRSA"))
    except Exception as exc:                                  # noqa: BLE001
        print(f"  [S3] prova FALLITA ({type(exc).__name__}: {str(exc)[:100]}) -> uso il servizio IRSA (lento)")


def spread_rows(rows: list[dict], n: int) -> list[dict]:
    """Sceglie n righe ben distribuite nel tempo e tra i rivelatori (celle mese x rivelatore a turno): serve la baseline lunga."""
    import re as _re
    from collections import defaultdict
    if len(rows) <= n:
        return sorted(rows, key=lambda r: r["time_bounds_lower"])
    months: dict = defaultdict(lambda: defaultdict(list))
    for r in sorted(rows, key=lambda r: r["time_bounds_lower"]):
        m = _re.search(r"_\d+D(\d)_spx", r["uri"])
        months[int(r["time_bounds_lower"] // 30)][m.group(1) if m else "?"].append(r)
    order = sorted(months)
    out, turn = [], 0
    while len(out) < n and any(any(v) for mo in months.values() for v in mo.values()):
        avail = [k for k in order if any(months[k].values())]
        need = n - len(out)
        picks = avail if need >= len(avail) else [avail[round(i * (len(avail) - 1) / max(1, need - 1))] for i in range(need)]
        for k in dict.fromkeys(picks):                  # un'immagine per mese, ruotando il rivelatore: tutte le bande, tutto il periodo
            dets = [d for d, v in sorted(months[k].items()) if v]
            d = dets[(turn + k) % len(dets)]
            out.append(months[k][d].pop(0))
        turn += 1
    return sorted(out, key=lambda r: r["time_bounds_lower"])


def sia_list(ra: float, dec: float, size: float, n: int) -> list[dict]:
    """Elenco immagini da IRSA SIA2 (servizio DIVERSO da TAP: spesso risponde quando TAP da' 502), tutte le collezioni SPHEREx.
    Restituisce righe {uri, time_bounds_lower} come la query ADQL, con il ritaglio centrato su (ra, dec)."""
    import xml.etree.ElementTree as ET
    cache = Path(CLIENT.cache_dir) / f"irsa_sia2_{ra:.2f}_{dec:.2f}.json"
    rows: list[dict] = []
    try:
        if cache.exists() and time.time() - cache.stat().st_mtime < SIA_TTL_S:
            rows = json.loads(cache.read_text(encoding="utf-8"))["rows"]
    except (OSError, ValueError, KeyError):
        rows = []
    errors = []
    if not rows:
        for coll in SIA_COLLECTIONS:
            try:
                resp = CLIENT.session.get(f"{SIA_URL}?COLLECTION={coll}&POS=circle+{ra}+{dec}+0.02", timeout=SIA_TIMEOUT_S)
                resp.raise_for_status()
                root = ET.fromstring(resp.content)
            except Exception as exc:        # noqa: BLE001 (una collezione che fallisce non annulla l'altra)
                errors.append(f"{coll}: {str(exc)[:40]}")
                continue
            tag = lambda e: e.tag.rsplit("}", 1)[-1]
            names = [f.get("name") for f in root.iter() if tag(f) == "FIELD"]
            if "access_url" not in names or "t_min" not in names:
                errors.append(f"{coll}: colonne {names[:6]}")
                continue
            iu, it = names.index("access_url"), names.index("t_min")
            for tr in root.iter():
                if tag(tr) != "TR":
                    continue
                td = [(c.text or "").strip() for c in tr if tag(c) == "TD"]
                if len(td) <= max(iu, it) or not td[iu].startswith("http") or not td[it]:
                    continue
                rows.append({"uri": f"{td[iu].split('?')[0]}?center={ra},{dec}d&size={size}", "time_bounds_lower": float(td[it])})
        seen, uniq = set(), []
        for r in sorted(rows, key=lambda r: r["time_bounds_lower"]):
            if r["uri"] not in seen:
                seen.add(r["uri"]); uniq.append(r)
        rows = uniq
        if not rows:
            raise ApiError("SIA: nessuna immagine (" + "; ".join(errors) + ")")
        try:
            cache.write_text(json.dumps({"query": f"SIA POINT('ICRS', {ra}, {dec}) spherex.plane", "errors": errors, "rows": rows}), encoding="utf-8")
        except OSError:
            pass
    rows = [{"uri": __import__("re").sub(r"center=[^&]+&size=[0-9.]+", f"center={ra},{dec}d&size={size}", r["uri"]), "time_bounds_lower": r["time_bounds_lower"]} for r in rows]
    return spread_rows(rows, n)


def band_dets(band: str | None) -> set[int]:
    return {int(b.strip()[-1]) for b in (band or "").split(",") if b.strip()[-1:].isdigit()}


def filter_band(rows: list[dict], band: str | None) -> list[dict]:
    """Tiene solo le immagini dei rivelatori scelti (il nome del file contiene 'D<n>_spx'): serve quando l'elenco arriva da SIA2 o dalla cache, che non filtrano per banda."""
    import re
    dets = band_dets(band)
    if not dets:
        return rows
    return [r for r in rows if (m := re.search(r"D([1-6])_spx", r.get("uri", ""))) and int(m.group(1)) in dets]


def sia_band(ra: float, dec: float, size: float, n: int, band: str | None) -> list[dict]:
    if not band_dets(band):
        return sia_list(ra, dec, size, n)
    return spread_rows(filter_band(sia_list(ra, dec, size, 100000), band), n)


LIST_POOL = ThreadPoolExecutor(max_workers=4)
SIA_POOL = ThreadPoolExecutor(max_workers=4)     # SIA2 a parte: le query TAP lente (60 s+) non devono bloccarlo
CUT_POOL = ThreadPoolExecutor(max_workers=16)    # ritagli in parallelo (il Worker regge decine di richieste)
LIST_WAIT_S = 8      # secondi massimi di attesa di IRSA TAP quando esiste un elenco vicino in cache


def nearest_cached_list(ra: float, dec: float, size: float, n: int, max_off_deg: float = 0.1) -> list[dict]:
    """Se IRSA TAP e' giu', riusa un elenco in cache preso entro ~6' dalla posizione (i ritagli sono ricentrati qui)."""
    import re as _re
    best, best_d = None, max_off_deg
    for f in Path(CLIENT.cache_dir).glob("irsa_*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            m = _re.search(r"POINT\('ICRS',\s*([-0-9.]+),\s*([-0-9.]+)\)", d.get("query", ""))
            if not m or "spherex.plane" not in d["query"] or not d.get("rows"):
                continue
            cra, cdec = float(m.group(1)), float(m.group(2))
            off = ((cra - ra) * math.cos(math.radians(dec))) ** 2 + (cdec - dec) ** 2
            off = off ** 0.5
            if off < best_d or (best is not None and off == best_d and len(d["rows"]) > len(best)):
                best, best_d = d["rows"], off
        except (OSError, ValueError, KeyError):
            continue
    if not best:
        return []
    out = []
    for r in best[:max(n, 1) * 3]:
        r = dict(r)
        r["uri"] = _re.sub(r"center=[^&]+", f"center={ra},{dec}d", r["uri"])
        r["uri"] = _re.sub(r"size=[0-9.]+", f"size={size}", r["uri"])
        out.append(r)
    return out


class Server(ThreadingHTTPServer):
    allow_reuse_address = False     # su Windows SO_REUSEADDR permette DUE server sulla stessa porta: il vecchio rispondeva ancora
    daemon_threads = True           # Ctrl+C chiude subito anche se ci sono query ancora in corso

# ---------------------------------------------------------------------------------------------------------------------
# Controparti in Gaia DR3 (risorsa ufficiale della challenge, servita da MAST/STScI): un oggetto che deriva nelle immagini e' gia' noto?
# ---------------------------------------------------------------------------------------------------------------------
MAST_GAIA_TAP = "https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/sync"
NEO_FITS_URL = "https://ws-cadc.canfar.net/minoc/files/cadc:NEOSSAT/NEOS_SCI_{}.fits"        # file pubblici, nessun login
CADC_TAP = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync"      # CADC: archivio delle immagini CSA NEOSSat
CAT_RADIUS_DEG = 0.04                       # ~144": un moto proprio di 10"/anno in 10 anni sposta di ~100"
GAIA_EPOCH = 2016.0
GAIA_LABEL = "Gaia DR3"


def neossat_parse(text: str) -> list[dict]:
    """CSV ObsCore del CADC -> osservazioni NEOSSat uniche (un'immagine compare come raw e clean: teniamo una riga per obs_id)."""
    import csv, io
    seen, out = {}, []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            oid, t0 = r["obs_id"], float(r["t_min"])
            row = {"id": oid, "mjd": t0, "exp": float(r["t_exptime"] or 0), "ra": float(r["s_ra"]), "dec": float(r["s_dec"]),
                   "fov": float(r["s_fov"] or 0), "target": r.get("target_name") or "", "url": r["access_url"]}
        except (KeyError, ValueError, TypeError):
            continue
        if oid not in seen:
            seen[oid] = row
            out.append(row)
        elif "/raw" in r["access_url"]:
            seen[oid]["url"] = r["access_url"]
    return sorted(out, key=lambda x: x["mjd"])


def neo_fits(obs: str) -> bytes:
    """Immagine NEOSSat grezza (circa 0.4 MB) dal CADC, con cache su disco."""
    path = Path(CLIENT.cache_dir) / f"neossat_{obs}.fits"
    if path.exists():
        try:
            return path.read_bytes()
        except OSError:
            pass
    resp = CLIENT.session.get(NEO_FITS_URL.format(obs), timeout=(8, 60))
    resp.raise_for_status()
    if not resp.content.startswith(b"SIMPLE"):
        raise ApiError("CADC: file non FITS")
    try:
        path.write_bytes(resp.content)
    except OSError:
        pass
    return resp.content


def neo_gaia(ra: float, dec: float) -> "np.ndarray":
    """Stelle Gaia DR3 (G < 14.6) entro 0.22 gradi da un punto: servono a ritrovare le coordinate dei pixel NEOSSat."""
    ra, dec = round(ra, 2), round(dec, 2)
    path = Path(CLIENT.cache_dir) / f"neogaia_{ra}_{dec}.json"
    if path.exists():
        try:
            return np.array(json.loads(path.read_text(encoding="utf-8")), dtype=float).reshape(-1, 5)
        except (OSError, ValueError):
            pass
    adql = ("SELECT TOP 800 ra, dec, pmra, pmdec, phot_g_mean_mag FROM dbo.gaia_source WHERE 1=CONTAINS(POINT('ICRS',ra,dec),"
            f"CIRCLE('ICRS',{ra},{dec},0.22)) AND phot_g_mean_mag < 14.6 ORDER BY phot_g_mean_mag")
    resp = CLIENT.session.post(MAST_GAIA_TAP, data={"REQUEST": "doQuery", "LANG": "ADQL", "QUERY": adql}, timeout=(8, 60))
    resp.raise_for_status()
    rows = []
    for x in _votable_rows(resp.text):
        try:
            rows.append([float(x["ra"]), float(x["dec"]), float(x["pmra"] or 0), float(x["pmdec"] or 0), float(x["phot_g_mean_mag"])])
        except (KeyError, ValueError, TypeError):
            continue
    try:
        path.write_text(json.dumps(rows), encoding="utf-8")
    except OSError:
        pass
    return np.array(rows, dtype=float).reshape(-1, 5)


def _votable_rows(text: str) -> list[dict]:
    """VOTable (TABLEDATA) -> lista di dict nome-colonna -> testo."""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text.encode("utf-8"))
    except ET.ParseError as exc:
        raise ApiError("risposta MAST non valida: " + text[:100].replace("\n", " ")) from exc
    ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
    for info in root.iter(ns + "INFO"):
        if info.get("name") == "QUERY_STATUS" and info.get("value") == "ERROR":
            raise ApiError("MAST: " + (info.text or "errore")[:100])
    names = [f.get("name") for f in root.iter(ns + "FIELD")]
    return [dict(zip(names, [td.text for td in tr.findall(ns + "TD")])) for tr in root.iter(ns + "TR")]


def catalog_cone(ra: float, dec: float) -> list[dict]:
    """Sorgenti Gaia DR3 in un cono di ~144" (TAP di MAST/STScI, cache su disco per cella di 0.02 gradi). Righe: id, ra, dec, pmra, pmdec ("/anno), mag."""
    ra_c, dec_c = round(ra / 0.02) * 0.02, round(dec / 0.02) * 0.02
    cache = Path(CLIENT.cache_dir) / f"gaia_{ra_c:.2f}_{dec_c:.2f}.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    f = lambda v: float(v) if v not in (None, "", "null", "NaN") else None          # noqa: E731
    adql = (f"SELECT TOP 3000 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag FROM dbo.gaia_source WHERE 1=CONTAINS("
            f"POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra_c:.5f},{dec_c:.5f},{CAT_RADIUS_DEG + 0.02}))")
    last = "nessun tentativo"
    data = None
    for _ in range(2):
        try:
            resp = CLIENT.session.post(MAST_GAIA_TAP, data={"REQUEST": "doQuery", "LANG": "ADQL", "QUERY": adql}, timeout=(8, 60))
            if resp.status_code == 200:
                data = _votable_rows(resp.text)
                break
            last = f"HTTP {resp.status_code}"
        except ApiError as exc:
            last = str(exc)
        except Exception as exc:                            # noqa: BLE001
            last = type(exc).__name__
        time.sleep(1.5)
    if data is None:
        raise ApiError("MAST Gaia: " + last)
    rows = []
    for x in data:
        try:
            rows.append({"id": f"Gaia DR3 {x['source_id']}", "ra": float(x["ra"]), "dec": float(x["dec"]),
                         "pmra": (f(x.get("pmra")) or 0.0) * 1e-3, "pmdec": (f(x.get("pmdec")) or 0.0) * 1e-3,
                         "mag": f(x.get("phot_g_mean_mag")), "plx": f(x.get("parallax"))})
        except (KeyError, ValueError, TypeError):
            continue
    cache.write_text(json.dumps(rows), encoding="utf-8")
    return rows


WISE_EPOCH = 2010.56                       # epoca di riferimento di AllWISE (MJD 55400)


def wise_cone(ra: float, dec: float) -> list[dict]:
    """Sorgenti AllWISE con moto proprio in un cono di ~144" (catalogo IRSA, stesso TAP di SPHEREx; cache su disco). pm in "/anno."""
    ra_c, dec_c = round(ra / 0.02) * 0.02, round(dec / 0.02) * 0.02
    cache = Path(CLIENT.cache_dir) / f"wise_{ra_c:.2f}_{dec_c:.2f}.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    adql = ("SELECT TOP 2000 designation, ra, dec, pmra, pmdec, w1mpro, w2mpro FROM allwise_p3as_psd WHERE pmra IS NOT NULL AND 1=CONTAINS("
            f"POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra_c:.5f},{dec_c:.5f},{CAT_RADIUS_DEG + 0.02}))")
    last = "nessun tentativo"
    text = None
    for _ in range(2):
        try:
            resp = CLIENT.session.post(config.IRSA_TAP_SYNC_URL, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}, timeout=(8, 60))
            if resp.status_code == 200:
                text = resp.text
                break
            last = f"HTTP {resp.status_code}"
        except Exception as exc:                            # noqa: BLE001
            last = type(exc).__name__
        time.sleep(1.5)
    if text is None:
        raise ApiError("IRSA AllWISE: " + last)
    f = lambda v: float(v) if v not in (None, "", "null", "NaN") else None          # noqa: E731
    rows = []
    for x in csv.DictReader(io.StringIO(text)):
        try:
            rows.append({"id": "WISE " + x["designation"], "ra": float(x["ra"]), "dec": float(x["dec"]),
                         "pmra": (f(x.get("pmra")) or 0.0) * 1e-3, "pmdec": (f(x.get("pmdec")) or 0.0) * 1e-3,
                         "w1": f(x.get("w1mpro")), "w2": f(x.get("w2mpro"))})
        except (KeyError, ValueError, TypeError):
            continue
    cache.write_text(json.dumps(rows), encoding="utf-8")
    return rows


def catalog_match(ra: float, dec: float, year: float, pme: float | None, pmn: float | None, tol: float = 6.0) -> dict:
    """
    Cerca controparti Gaia DR3 di un oggetto in (ra, dec) all'epoca `year`: le posizioni di catalogo sono portate a quell'epoca con il loro
    moto proprio. Se e' noto il moto proprio misurato (pme est, pmn nord, "/anno) si confronta anche quello.
    """
    out: dict = {"matches": [], "errors": {}}
    cosd = math.cos(math.radians(dec))
    try:
        rows = catalog_cone(ra, dec)
    except Exception as exc:                                # noqa: BLE001 (servizio giu': l'app funziona anche senza)
        out["errors"]["gaia"] = f"{type(exc).__name__}: {str(exc)[:100]}"
        return out
    for x in rows:
        dt = year - GAIA_EPOCH
        pe, pn = x.get("pmra") or 0.0, x.get("pmdec") or 0.0
        ra_t = x["ra"] + pe * dt / 3600 / math.cos(math.radians(x["dec"]))
        dec_t = x["dec"] + pn * dt / 3600
        sep = math.hypot((ra_t - ra) * cosd, dec_t - dec) * 3600
        if sep > tol:
            continue
        m = {"cat": GAIA_LABEL, "id": x["id"], "sep": round(sep, 2), "pmra": round(pe, 3), "pmdec": round(pn, 3),
             "pm": round(math.hypot(pe, pn), 3), "mag": x.get("mag"), "plx": x.get("plx")}
        if pme is not None and pmn is not None:
            m["dpm"] = round(math.hypot(pe - pme, pn - pmn), 3)
        out["matches"].append(m)
    out["matches"].sort(key=lambda m: m["sep"])
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "CosmicFootprintDetector/1.0"
    protocol_version = "HTTP/1.1"      # connessioni riutilizzate: meno latenza con tante richieste piccole

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, BrokenPipeError):
            pass      # il browser ha annullato la richiesta (settore lasciato): non e' un errore, niente traceback

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionError, BrokenPipeError, TimeoutError):
            pass      # connessione keep-alive chiusa dal browser: normale, niente traceback

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802 (nome imposto da http.server)
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path.startswith("/api/") and not self.headers.get("X-Prefetch"):
            ACTIVITY["t"] = time.time()                          # la pagina e' al lavoro: il precarico si mette in pausa
        try:
            if url.path == "/":
                self._send(302, b"", "text/plain", {"Location": "/explore.html"})
            elif url.path == "/api/images":
                self._api_images(q)
            elif url.path == "/api/bench":
                self._api_bench(q)
            elif url.path == "/api/status":
                self._api_status()
            elif url.path == "/api/catalog":
                self._api_catalog(q)
            elif url.path == "/api/gaia":
                self._api_gaia(q)
            elif url.path == "/api/wise":
                self._api_wise(q)
            elif url.path == "/api/gaia_search":
                self._api_gaia_search(q)
            elif url.path == "/api/neossat":
                self._api_neossat(q)
            elif url.path == "/api/gaia_star":
                self._api_gaia_star(q)
            elif url.path == "/api/gaia_twins":
                self._api_gaia_twins(q)
            elif url.path == "/api/neossat_check":
                self._api_neossat_check(q)
            elif url.path == "/api/baseline":
                self._api_baseline(q)
            elif url.path == "/api/cutout":
                self._api_cutout(q)
            elif url.path == "/api/cutouts":
                self._api_cutouts(q)
            else:
                self._static(url.path)
        except (ApiInputError, ValueError) as exc:
            self._json(400, {"error": str(exc)})
        except ApiError as exc:
            self._json(502, {"error": str(exc)})

    def _api_images(self, q: dict) -> None:
        ra, dec = round(float(q["ra"]), 2), round(float(q["dec"]), 2)     # arrotondato: stesse query = cache riusata
        size = float(q.get("size", 0.1))
        n = max(1, min(int(q.get("max", 24)), MAX_FRAMES))
        band = q.get("bandpass") or None
        if DEMO:
            self._json(200, {"demo": True, "rows": demo_images(ra, dec, size, n)})
            return
        t0 = time.time()
        order = q.get("order", "asc")
        if q.get("engine") == "sia":                          # diagnostica: misura solo SIA2
            fresh = sia_list(ra, dec, size, n)
            self._json(200, {"demo": False, "stale": False, "rows": fresh, "took": round(time.time() - t0, 2)})
            return
        rows = nearest_cached_list(ra, dec, size, n)
        fut = LIST_POOL.submit(self._list_images, ra, dec, size, n, band, order, t0)
        try:
            if not band:                                     # gara TAP contro SIA2 (stesse immagini): vince il primo che risponde (SIA2 ~4 s, TAP 10-60 s)
                sfut = SIA_POOL.submit(sia_list, ra, dec, size, n)
                from concurrent.futures import wait as _wait, FIRST_COMPLETED
                payload = None
                pending = {fut, sfut}
                while pending and payload is None:
                    done, pending = _wait(pending, timeout=None if not rows else LIST_WAIT_S + 30, return_when=FIRST_COMPLETED)
                    if not done:
                        raise FutTimeout()
                    for f in done:
                        try:
                            res = f.result()
                        except Exception:                    # noqa: BLE001 (se uno fallisce si aspetta l'altro)
                            continue
                        payload = res if f is fut else {"demo": False, "stale": False, "rows": res}
                if payload is None:
                    raise ApiError("TAP e SIA2 non disponibili")
            else:
                payload = fut.result(timeout=LIST_WAIT_S)
        except (FutTimeout, ApiError) as exc:
            # TAP lento o in errore: provo SIA2 (altro servizio, posizione esatta), poi l'elenco in cache piu' vicino
            why = "lento" if isinstance(exc, FutTimeout) else f"in errore ({str(exc)[:50]})"
            try:
                fresh = sia_band(ra, dec, size, n, band)
                print(f"  [elenco] TAP {why}: SIA2 ha dato {len(fresh)} immagini aggiornate")
                payload = {"demo": False, "stale": False, "rows": fresh}
            except Exception as exc2:       # noqa: BLE001 (qualsiasi errore di rete/parsing: si ripiega)
                print(f"  [elenco] TAP {why}, SIA2 non disponibile ({str(exc2)[:60]})")
                rows = filter_band(rows, band)
                if rows:
                    print(f"  [elenco] uso l'elenco in cache piu' vicino, {len(rows)} immagini")
                    payload = {"demo": False, "stale": True, "rows": rows}
                elif isinstance(exc, FutTimeout):
                    payload = fut.result(timeout=600)
                else:
                    raise exc
        self._json(200, payload)

    def _list_images(self, ra, dec, size, n, band, order, t0) -> None:
        if order == "both" and n > 1:
            # meta delle immagini piu' vecchie e meta delle piu' recenti: copre tutto il periodo osservato
            # (le righe sono ordinate per data: con un limite fisso si vedrebbero solo le prime osservazioni)
            from src.api_client import build_spherex_images_adql
            old = CLIENT.spherex_images(ra, dec, size, band, (n + 1) // 2)
            adql = build_spherex_images_adql(ra, dec, size, band, n // 2).replace(
                "ORDER BY p.time_bounds_lower", "ORDER BY p.time_bounds_lower DESC")
            new = CLIENT.run_adql(adql)
            seen, rows = set(), []
            for r in old.rows + new.rows:
                if r["uri"] not in seen:
                    seen.add(r["uri"]); rows.append(r)
            rows.sort(key=lambda r: r["time_bounds_lower"])
            res_rows, stale, cached = rows, old.stale or new.stale, old.from_cache and new.from_cache
        elif order == "span":
            # per OGNI rivelatore (= banda) le osservazioni piu' vecchie E le piu' recenti: cosi' ogni banda ha una baseline
            # di mesi (serve al moto proprio). Query piccole e al massimo 2 insieme: IRSA risponde 502 se la si sovraccarica.
            # Gli esiti riusciti restano in cache: se qualcuna fallisce la risposta e' "partial" e il tentativo dopo completa.
            from src.api_client import build_spherex_images_adql
            per = max(2, min(n, 12))
            tasks = [(d, newest) for d in range(1, 7) for newest in (False, True)]

            def one(t):
                d, newest = t
                adql = build_spherex_images_adql(ra, dec, size, f"SPHEREx-D{d}", per)
                if newest:
                    adql = adql.replace("ORDER BY p.time_bounds_lower", "ORDER BY p.time_bounds_lower DESC")
                return span_window(adql)
            with ThreadPoolExecutor(max_workers=2) as ex:
                parts = list(ex.map(one, tasks))
            partial = any(p is None for p in parts)
            parts = [p for p in parts if p is not None]
            seen, rows = set(), []
            for part in parts:
                for r in part:
                    if r["uri"] not in seen:
                        seen.add(r["uri"]); rows.append(r)
            rows.sort(key=lambda r: r["time_bounds_lower"])
            res_rows, stale, cached = rows, False, not partial
            print(f"  [elenco span] {len(res_rows)} immagini in {time.time() - t0:.1f}s ({'incompleto: ritenta' if partial else 'completo'})")
            return {"demo": False, "stale": False, "partial": partial, "rows": res_rows, "log": SPAN_LOG[-12:]}
        else:
            res = CLIENT.spherex_images(ra, dec, size, band, n)
            res_rows, stale, cached = res.rows, res.stale, res.from_cache
        print(f"  [elenco] {len(res_rows)} immagini in {time.time() - t0:.1f}s ({'cache' if cached else 'rete'})")
        return {"demo": False, "stale": stale, "rows": res_rows}

    def _api_bench(self, q: dict) -> None:
        mode = q.get("mode", "contig")
        self._json(200, bench_s3(mode, max(1, min(int(q.get("threads", 8)), 128)), max(1, min(int(q.get("frames", 12)), 24))))

    def _api_status(self) -> None:
        self._json(200, {"s3": {k: v for k, v in S3.items() if k != "sem"}, "worker": dict(WORKER, url=worker_url()), "prefetch": PREFETCH.stats if PREFETCH else None, "now": time.time(), "demo": DEMO})

    def _api_baseline(self, q: dict) -> None:
        """Per quanti giorni SPHEREx ha osservato un punto? (primo e ultimo fotogramma, da SIA2 IRSA): serve a sapere se un moto proprio e' rilevabile."""
        ra, dec = round(float(q["ra"]), 2), round(float(q["dec"]), 2)
        if DEMO:
            self._json(200, {"n": 12, "days": 90.0, "demo": True})
            return
        try:
            rows = SIA_POOL.submit(sia_list, ra, dec, 0.05, 200).result(timeout=40)
        except Exception as exc:                            # noqa: BLE001
            raise ApiError("SIA2 non raggiungibile: " + str(exc)[:80]) from exc
        t = [r["time_bounds_lower"] for r in rows if r.get("time_bounds_lower") is not None]
        self._json(200, {"n": len(t), "days": (max(t) - min(t)) if t else 0.0, "mjd0": min(t) if t else None, "mjd1": max(t) if t else None})

    def _api_neossat(self, q: dict) -> None:
        """Immagini NEOSSat (CSA, ospitate al CADC) che contengono un punto: servono ad allungare la baseline temporale oltre quella di SPHEREx."""
        ra, dec = round(float(q["ra"]), 2), round(float(q["dec"]), 2)
        if DEMO:
            self._json(200, {"obs": [], "demo": True})
            return
        if not (0 <= ra < 360 and -90 <= dec <= 90):
            raise ApiInputError("coordinate fuori intervallo")
        adql = ("SELECT TOP 300 obs_id, target_name, t_min, t_exptime, s_ra, s_dec, s_fov, access_url FROM ivoa.ObsCore "
                f"WHERE obs_collection='NEOSSAT' AND INTERSECTS(POINT('ICRS',{ra},{dec}), s_region)=1 ORDER BY t_min")
        cache = Path(CLIENT.cache_dir) / f"neossat_{ra}_{dec}.json"
        if cache.exists():
            try:
                self._json(200, json.loads(cache.read_text(encoding="utf-8")))
                return
            except (OSError, ValueError):
                pass
        try:
            resp = CLIENT.session.post(CADC_TAP, data={"LANG": "ADQL", "QUERY": adql, "FORMAT": "csv"}, timeout=(8, 60))
            resp.raise_for_status()
            obs = neossat_parse(resp.text)
        except Exception as exc:                            # noqa: BLE001
            raise ApiError("CADC non raggiungibile: " + str(exc)[:80]) from exc
        out = {"obs": obs}
        try:
            cache.write_text(json.dumps(out), encoding="utf-8")
        except OSError:
            pass
        self._json(200, out)

    def _api_neossat_check(self, q: dict) -> None:
        """Dove cade una stella con moto proprio noto in una immagine NEOSSat? Ricostruisce le coordinate dei pixel con Gaia e misura (src/neossat.py)."""
        import re
        from src import neossat
        obs = q.get("obs", "")
        if DEMO:
            self._json(200, {"ok": False, "reason": "demo"})
            return
        if not re.fullmatch(r"\d{8,16}", obs):
            raise ApiInputError("identificativo non valido")
        star = {k: float(q[k]) for k in ("ra", "dec", "pmra", "pmdec")}
        if not (0 <= star["ra"] < 360 and -90 <= star["dec"] <= 90 and abs(star["pmra"]) < 20000 and abs(star["pmdec"]) < 20000):
            raise ApiInputError("parametri fuori intervallo")
        try:
            hdr, img = neossat.parse_fits(neo_fits(obs))
            gaia = neo_gaia(neossat.sexa(hdr["OBJCTRA"], True), neossat.sexa(hdr["OBJCTDEC"], False))
        except ApiError:
            raise
        except Exception as exc:                            # noqa: BLE001
            raise ApiError("NEOSSat/Gaia non raggiungibile o file non leggibile: " + str(exc)[:80]) from exc
        self._json(200, neossat.check_star(img, hdr, gaia, star))

    @staticmethod
    def _gaia_row(x: dict) -> dict | None:
        try:
            plx = float(x["parallax"])
            return {"id": "Gaia DR3 " + x["source_id"], "ra": float(x["ra"]), "dec": float(x["dec"]), "pmra": float(x["pmra"]), "pmdec": float(x["pmdec"]),
                    "plx": plx, "mag": float(x["phot_g_mean_mag"]), "pm": float(x["pm"]), "vt": float(x["vt"]), "ly": 3261.56 / plx}
        except (KeyError, ValueError, TypeError, ZeroDivisionError):
            return None

    def _gaia_tap(self, adql: str) -> list[dict]:
        try:
            resp = CLIENT.session.post(MAST_GAIA_TAP, data={"REQUEST": "doQuery", "LANG": "ADQL", "QUERY": adql}, timeout=(8, 90))
            resp.raise_for_status()
            return _votable_rows(resp.text)
        except Exception as exc:                            # noqa: BLE001
            raise ApiError("MAST Gaia non raggiungibile: " + str(exc)[:80]) from exc

    def _api_gaia_star(self, q: dict) -> None:
        """Una stella Gaia DR3 dal suo source_id (serve ai link condivisibili)."""
        import re
        sid = q.get("id", "")
        if DEMO:
            self._json(200, {"star": None, "demo": True})
            return
        if not re.fullmatch(r"\d{6,20}", sid):
            raise ApiInputError("source_id non valido")
        rows = self._gaia_tap("SELECT TOP 1 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, pm, 4.74047 * pm / parallax AS vt "
                              f"FROM dbo.gaia_source WHERE source_id = {sid}")
        star = self._gaia_row(rows[0]) if rows else None
        self._json(200, {"star": star})

    def _api_gaia_twins(self, q: dict) -> None:
        """Gemelle: stelle Gaia con lo stesso moto proprio e la stessa parallasse (probabili compagne di un sistema legato). MAST limita il cono a 1 grado."""
        if DEMO:
            self._json(200, {"twins": [], "demo": True})
            return
        ra, dec, pmra, pmdec, plx = (float(q[k]) for k in ("ra", "dec", "pmra", "pmdec", "plx"))
        if not (0 <= ra < 360 and -90 <= dec <= 90 and plx >= 5 and abs(pmra) < 20000 and abs(pmdec) < 20000):
            raise ApiInputError("parametri fuori intervallo")
        pm = math.hypot(pmra, pmdec)
        tol, dplx = max(8.0, 0.12 * pm), 1.0 + 0.08 * plx
        dpc = 1000.0 / plx
        radius = round(min(1.0, max(0.02, math.degrees(0.3 / dpc))), 3)          # separazione proiettata fino a ~0.3 pc, entro il limite del servizio
        key = hashlib.sha1(f"{ra:.4f},{dec:.4f},{pmra:.0f},{pmdec:.0f},{plx:.1f}".encode()).hexdigest()[:12]
        cache = Path(CLIENT.cache_dir) / f"gaiatwins_{key}.json"
        if cache.exists():
            try:
                self._json(200, json.loads(cache.read_text(encoding="utf-8")))
                return
            except (OSError, ValueError):
                pass
        adql = ("SELECT TOP 40 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, pm, 4.74047 * pm / parallax AS vt FROM dbo.gaia_source "
                f"WHERE 1=CONTAINS(POINT('ICRS',ra,dec),CIRCLE('ICRS',{ra},{dec},{radius})) AND parallax_over_error > 3 "
                f"AND pmra BETWEEN {pmra - tol} AND {pmra + tol} AND pmdec BETWEEN {pmdec - tol} AND {pmdec + tol} "
                f"AND parallax BETWEEN {plx - dplx} AND {plx + dplx} ORDER BY phot_g_mean_mag")
        twins = []
        for x in self._gaia_tap(adql):
            t = self._gaia_row(x)
            if not t:
                continue
            dra = (t["ra"] - ra) * math.cos(math.radians(dec)) * 3600.0
            sep = math.hypot(dra, (t["dec"] - dec) * 3600.0)
            if sep < 1.5:                                                           # la stella stessa
                continue
            t["sep"] = sep
            t["au"] = sep * dpc
            twins.append(t)
        twins.sort(key=lambda t: t["sep"])
        out = {"twins": twins[:20], "radius": radius}
        try:
            cache.write_text(json.dumps(out), encoding="utf-8")
        except OSError:
            pass
        self._json(200, out)

    def _api_gaia_search(self, q: dict) -> None:
        """Ricerca in Gaia DR3 (TAP MAST) delle stelle con moto proprio notevole: preset curiosi o filtri liberi. Risposta: elenco ordinato."""
        if DEMO:
            self._json(200, {"stars": [], "demo": True})
            return
        num = lambda k, d: float(q.get(k, d)) if q.get(k, "") != "" else d       # noqa: E731
        preset = q.get("preset", "custom")
        pm_min, g_min, g_max = num("pmmin", 500.0), num("gmin", 0.0), num("gmax", 25.0)
        plx_min, n = num("plxmin", 5.0), int(max(1, min(100, num("n", 40))))
        order, extra = "pm DESC", ""
        if preset == "fastest":
            pm_min, plx_min = 2500.0, 20.0
        elif preset == "ghosts":                       # debolissime nel visibile ma vicine e veloci: ottime per l'infrarosso
            pm_min, g_min, plx_min = 250.0, 19.3, 25.0
        elif preset == "halo":                         # velocita' tangenziale > 300 km/s: stelle dell'alone galattico
            pm_min, plx_min = 300.0, 5.0
            extra = "AND parallax_over_error > 10 AND 4.74047 * pm / parallax > 300"
            order = "4.74047 * pm / parallax DESC"
        elif preset == "neighbours":
            pm_min, plx_min, order = 100.0, 150.0, "parallax DESC"
        if not (0 <= pm_min <= 12000 and 0 <= plx_min <= 800 and -5 <= g_min <= 25 and -5 <= g_max <= 25):
            raise ApiInputError("parametri fuori intervallo")
        adql = (f"SELECT TOP {n} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, pm, 4.74047 * pm / parallax AS vt "
                f"FROM dbo.gaia_source WHERE pm >= {pm_min} AND parallax >= {plx_min} AND parallax_over_error > 5 "
                f"AND phot_g_mean_mag >= {g_min} AND phot_g_mean_mag <= {g_max} {extra} ORDER BY {order}")
        cache = Path(CLIENT.cache_dir) / ("gaiasearch_" + hashlib.sha1(adql.encode()).hexdigest()[:12] + ".json")
        if cache.exists():
            try:
                self._json(200, json.loads(cache.read_text(encoding="utf-8")))
                return
            except (OSError, ValueError):
                pass
        try:
            resp = CLIENT.session.post(MAST_GAIA_TAP, data={"REQUEST": "doQuery", "LANG": "ADQL", "QUERY": adql}, timeout=(8, 60))
            resp.raise_for_status()
            data = _votable_rows(resp.text)
        except Exception as exc:                            # noqa: BLE001
            raise ApiError("MAST Gaia non raggiungibile: " + str(exc)[:80]) from exc
        stars = []
        for x in data:
            try:
                plx = float(x["parallax"])
                stars.append({"id": "Gaia DR3 " + x["source_id"], "ra": float(x["ra"]), "dec": float(x["dec"]),
                              "pmra": float(x["pmra"]), "pmdec": float(x["pmdec"]), "plx": plx, "mag": float(x["phot_g_mean_mag"]),
                              "pm": float(x["pm"]), "vt": float(x["vt"]), "ly": 3261.56 / plx})
            except (KeyError, ValueError, TypeError, ZeroDivisionError):
                continue
        out = {"stars": stars, "preset": preset}
        try:
            cache.write_text(json.dumps(out), encoding="utf-8")
        except OSError:
            pass
        self._json(200, out)

    def _api_gaia(self, q: dict) -> None:
        """Stelle Gaia DR3 attorno a un punto (per il livello 'catalogo' sull'immagine): le piu' luminose + tutte quelle con moto proprio notevole."""
        if DEMO:
            self._json(200, {"stars": [], "demo": True})
            return
        ra, dec = float(q["ra"]), float(q["dec"])
        if not (0 <= ra < 360 and -90 <= dec <= 90):
            raise ApiInputError("ra/dec fuori intervallo")
        rows = catalog_cone(ra, dec)
        movers = [x for x in rows if math.hypot(x["pmra"], x["pmdec"]) >= 0.15]
        bright = sorted((x for x in rows if x.get("mag") is not None and x["mag"] < 18.5), key=lambda x: x["mag"])[:150]
        seen, out = set(), []
        for x in movers + bright:
            if x["id"] not in seen:
                seen.add(x["id"])
                out.append({"id": x["id"], "ra": x["ra"], "dec": x["dec"], "pmra": x["pmra"], "pmdec": x["pmdec"], "mag": x.get("mag"), "plx": x.get("plx")})
        self._json(200, {"stars": out, "epoch": GAIA_EPOCH})

    def _api_wise(self, q: dict) -> None:
        """Sorgenti AllWISE con moto proprio attorno a un punto (livello 'catalogo WISE' sull'immagine)."""
        if DEMO:
            self._json(200, {"stars": [], "demo": True})
            return
        ra, dec = float(q["ra"]), float(q["dec"])
        if not (0 <= ra < 360 and -90 <= dec <= 90):
            raise ApiInputError("ra/dec fuori intervallo")
        rows = [x for x in wise_cone(ra, dec) if math.hypot(x["pmra"], x["pmdec"]) >= 0.15]
        self._json(200, {"stars": rows, "epoch": WISE_EPOCH})

    def _api_catalog(self, q: dict) -> None:
        if DEMO:
            self._json(200, {"matches": [], "errors": {}, "demo": True})
            return
        ra, dec, year = float(q["ra"]), float(q["dec"]), float(q.get("year", 2026.4))
        pme = float(q["pme"]) if q.get("pme") not in (None, "") else None
        pmn = float(q["pmn"]) if q.get("pmn") not in (None, "") else None
        self._json(200, catalog_match(ra, dec, year, pme, pmn, float(q.get("tol", 6.0))))

    def _api_cutout(self, q: dict) -> None:
        url = q["url"]
        if DEMO:
            if not url.startswith("demo://frame/"):
                raise ApiInputError("in modalita' demo sono ammessi solo URL demo://")
            idx = int(url.split("/")[-1].split("?")[0])
            p = parse_qs(urlparse(url).query)
            fits = make_demo_fits(idx, float(p["ra"][0]), float(p["dec"][0]), float(p.get("size", ["0.1"])[0]))
            self._send(200, fits, "application/fits")
            return
        t0 = time.time()
        try:
            path = fast_cutout(url)                  # Worker -> S3 (Range) -> altrimenti servizio ritagli IRSA
        except NoCoverage as exc:                    # fuori dal rivelatore: risposta immediata, il client salta il fotogramma
            self._json(404, {"error": "fuori dal fotogramma: " + str(exc)})
            return
        dt = time.time() - t0
        if dt > 2:
            print(f"  [ritaglio lento] {dt:.1f}s")
        self._send(200, Path(path).read_bytes(), "application/fits",
                   {"Cache-Control": "public, max-age=86400"})

    def _api_cutouts(self, q: dict) -> None:
        """Lotto di ritagli in una richiesta: per ogni URL [stato u32][lunghezza u32][byte FITS o messaggio], nello stesso ordine."""
        import struct
        urls = json.loads(q["urls"])
        if not isinstance(urls, list) or not 1 <= len(urls) <= 24 or not all(isinstance(u, str) for u in urls):
            raise ApiInputError("urls: da 1 a 24 stringhe")
        if DEMO:
            raise ApiInputError("lotti non disponibili in modalita' demo")

        def one(u: str) -> tuple[int, bytes]:
            try:
                return 200, Path(fast_cutout(u)).read_bytes()
            except NoCoverage as exc:
                return 404, str(exc).encode()
            except (ApiInputError, ValueError) as exc:
                return 400, str(exc).encode()
            except Exception as exc:                       # noqa: BLE001 (rete, IRSA 502...): il client riprova da solo
                return 502, f"{type(exc).__name__}: {str(exc)[:100]}".encode()

        futs = [CUT_POOL.submit(one, u) for u in urls]
        out = bytearray()
        for f in futs:
            st, body = f.result()
            out += struct.pack(">II", st, len(body)) + body
        self._send(200, bytes(out), "application/octet-stream")

    def _static(self, rel: str) -> None:
        target = (PUBLIC_DIR / rel.lstrip("/")).resolve()
        if PUBLIC_DIR.resolve() not in target.parents or not target.is_file():
            self._json(404, {"error": "non trovato"})
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})

    def log_message(self, fmt, *args) -> None:   # log piu' pulito
        print("  " + (fmt % args))


def load_missions() -> list[dict]:
    return json.loads((PUBLIC_DIR / "data" / "missions.json").read_text(encoding="utf-8"))


def mission_position(m: dict, year: float = 2026.2) -> tuple[float, float]:
    """Posizione ATTUALE di un bersaglio con moto proprio (stessa formula di public/js/tags.js)."""
    dt = year - (m.get("ep") or 2000)
    cos = math.cos(math.radians(m["dec"]))
    return (m["ra"] + (m.get("pmra") or 0) * dt / 1000 / 3600 / cos, m["dec"] + (m.get("pmdec") or 0) * dt / 1000 / 3600)


def warm_cache(client: IrsaClient, count: int = 60, size_deg: float = 0.2, workers: int = 4,
               only: str = "") -> None:
    """
    Precarica in cache elenco immagini e ritagli del settore CENTRALE di ogni bersaglio di data/missions.json, con gli
    stessi URL che usa la pagina (quindi poi si apre subito). Da fare PRIMA della demo. Usa SIA2 se TAP non risponde.
    """
    def fetch(url: str) -> bool:
        try:
            fast_cutout(url)                        # S3 (veloce) con ripiego sul servizio IRSA
            return True
        except (ApiError, ApiInputError) as exc:
            print(f"    saltato: {str(exc)[:70]}")
            return False

    for m in load_missions():
        if only and only.lower() not in (m["id"] + " " + m["name"]).lower():
            continue
        t0 = time.time()
        ra, dec = mission_position(m)
        ra2, dec2 = round(ra, 2), round(dec, 2)             # come fa la pagina nelle richieste di elenco
        rows: list[dict] = []
        for n in (12, count):                               # la pagina chiede prima 12 immagini, poi l'elenco completo
            try:
                part = sia_list(ra2, dec2, size_deg, n)
            except Exception as exc:                        # noqa: BLE001
                try:
                    part = client.spherex_images(ra2, dec2, size_deg, None, n).rows
                except (ApiError, ApiInputError) as exc2:
                    print(f"{m['name']}: elenco non disponibile (SIA2: {str(exc)[:50]}; TAP: {str(exc2)[:50]})")
                    part = []
            rows += part
        urls = list(dict.fromkeys(r["uri"] for r in rows))
        if not urls:
            continue
        print(f"{m['name']}: {len(urls)} ritagli da scaricare…")
        done = 0
        with ThreadPoolExecutor(workers) as ex:
            for ok in ex.map(fetch, urls):
                done += bool(ok)
        print(f"{m['name']}: {done}/{len(urls)} ritagli in cache ({time.time() - t0:.0f}s)")


def disable_quickedit() -> None:
    """Windows: se si clicca nella finestra del terminale il testo viene 'selezionato' e print() BLOCCA tutto il server
    (la pagina resta in caricamento all'infinito). Si disattiva la modalita' QuickEdit della console."""
    if os.name != "nt":
        return
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-10)                       # STD_INPUT_HANDLE
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(h, ctypes.byref(mode)):
            k.SetConsoleMode(h, (mode.value & ~0x0040) | 0x0080)   # senza QUICK_EDIT, con EXTENDED_FLAGS
    except Exception:                                  # noqa: BLE001 (non essenziale)
        pass


def main() -> None:
    global CLIENT, DEMO
    ap = argparse.ArgumentParser(description="Server del visualizzatore SPHEREx")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))   # in hosting (Render ecc.) la porta arriva da PORT
    ap.add_argument("--demo", action="store_true", help="immagini sintetiche, senza rete")
    ap.add_argument("--warm", action="store_true", help="scarica in cache i bersagli e termina")
    ap.add_argument("--only", default="", help="con --warm: solo i bersagli il cui nome contiene questo testo (es. barnard)")
    ap.add_argument("--no-prefetch", action="store_true", help="non precaricare in background i ritagli attorno ai bersagli")
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"), help="usa 0.0.0.0 per aprirlo dal telefono o in hosting")
    args = ap.parse_args()
    disable_quickedit()
    DEMO = args.demo
    if not DEMO:
        CLIENT = IrsaClient()
        CLIENT._limiter.min_interval_s = 0.05    # i ritagli sono piccoli e finiscono in cache
        config.API_TIMEOUT_S = 120               # l'elenco immagini SPHEREx puo' richiedere ~20-60 s
        if args.warm:
            warm_cache(CLIENT, only=args.only)
            return
    if not DEMO:
        s3_selftest()
        if worker_url():
            print(f"  [Worker] attivo: {worker_url()}")
    print(f"Visualizzatore su http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}"
          f"  ({'DEMO sintetica' if DEMO else 'dati reali IRSA'})")
    try:
        srv = Server((args.host, args.port), Handler)
    except OSError as exc:
        raise SystemExit(f"\nPorta {args.port} occupata ({exc}): un altro server e' ancora aperto. Chiudi le finestre del "
                         f"terminale o usa riavvia.bat, poi riprova.") from exc
    if not DEMO:
        global PREFETCH
        try:
            from src.prefetch import Prefetcher
            PREFETCH = Prefetcher(port=args.port, missions=load_missions(), mission_position=mission_position, fast_cutout=fast_cutout,
                                  cutout_path=cutout_path, no_coverage=NoCoverage, data_dir=Path(config.DATA_DIR) if hasattr(config, "DATA_DIR") else Path("data"),
                                  worker_ok=lambda: bool(worker_url()) and time.time() >= WORKER["off_until"], activity=lambda: ACTIVITY["t"])
            if args.no_prefetch:
                PREFETCH.radius = 0
            PREFETCH.start()
        except Exception as exc:                          # noqa: BLE001 (il precarico e' opzionale)
            print(f"  [Precarico] non avviato: {exc}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
