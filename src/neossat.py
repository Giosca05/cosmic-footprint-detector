"""Verifica sui pixel NEOSSat (CSA, immagini al CADC): dove cade davvero una stella con moto proprio noto?

Le immagini NEOSSat grezze non hanno WCS. Qui lo ricostruiamo da zero:
  1. si leggono i pixel e si trovano le stelle (picchi sopra 6 sigma, centroide sub-pixel);
  2. si scaricano da Gaia DR3 le stelle del campo (G < 14.6) e si portano all'epoca dell'immagine con il loro moto proprio;
  3. si cerca la trasformazione pixel -> cielo (scala, rotazione, traslazione) con un voto: ogni coppia (picco, stella Gaia)
     propone una traslazione, quella con piu' voti vince; la rotazione parte da quella del satellite (ROLL - 90 gradi);
  4. si raffina ai minimi quadrati SENZA la stella bersaglio, cosi' la misura finale e' indipendente;
  5. si confronta dove la stella e' stata misurata con dove Gaia la prevede (e dove era a epoca 2016).
Solo numpy.
"""
from __future__ import annotations

import math

import numpy as np

GAIA_EPOCH = 2016.0


def parse_fits(raw: bytes) -> tuple[dict, np.ndarray]:
    """FITS semplice a 2 assi, BITPIX 16 (con BZERO) o 32/-32: ritorna (intestazione, pixel float32 della sola area dati)."""
    hdr, pos, done = {}, 0, False
    while not done:
        if pos + 2880 > len(raw):
            raise ValueError("FITS troncato")
        block = raw[pos:pos + 2880].decode("ascii", "replace")
        pos += 2880
        for i in range(36):
            card = block[i * 80:(i + 1) * 80]
            key = card[:8].strip()
            if key == "END":
                done = True
                break
            if card[8:10] == "= ":
                val = card[10:].split(" /")[0].strip().strip("'").strip()
                hdr[key] = val
    nx, ny, bitpix = int(hdr["NAXIS1"]), int(hdr["NAXIS2"]), int(hdr["BITPIX"])
    dt = {16: ">i2", 32: ">i4", -32: ">f4", 8: "u1"}[bitpix]
    data = np.frombuffer(raw, dtype=dt, count=nx * ny, offset=pos).reshape(ny, nx).astype(np.float32)
    data = data * float(hdr.get("BSCALE", 1)) + float(hdr.get("BZERO", 0))
    sec = hdr.get("DATASEC", "")                       # '[473:728,1:256]' = area con il cielo (il resto e' overscan)
    x0 = 0
    try:
        a, b = sec.strip("[]").split(",")
        xs, xe = (int(v) for v in a.split(":"))
        ys, ye = (int(v) for v in b.split(":"))
        data, x0 = data[ys - 1:ye, xs - 1:xe], xs - 1
    except (ValueError, IndexError):
        pass
    hdr["_x0"] = x0
    return hdr, np.ascontiguousarray(data)


def sexa(text: str, hours: bool) -> float:
    parts = [float(p) for p in text.replace(":", " ").split()]
    sign = -1.0 if text.strip().startswith("-") else 1.0
    v = abs(parts[0]) + (parts[1] / 60 if len(parts) > 1 else 0) + (parts[2] / 3600 if len(parts) > 2 else 0)
    return sign * v * (15.0 if hours else 1.0)


def find_peaks(img: np.ndarray, nsig: float = 6.0, max_n: int = 60) -> np.ndarray:
    """Stelle come picchi locali 5x5 sopra nsig sigma dal fondo (mediana, MAD). Ritorna righe (x, y, flusso) ordinate per flusso."""
    med = float(np.median(img))
    sd = 1.4826 * float(np.median(np.abs(img - med))) or 1.0
    h, w = img.shape
    c = img[3:h - 3, 3:w - 3]
    is_max = c > med + nsig * sd
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            if dx or dy:
                is_max &= c >= img[3 + dy:h - 3 + dy, 3 + dx:w - 3 + dx]
    ys, xs = np.nonzero(is_max)
    out = []
    for y, x in zip(ys + 3, xs + 3):
        win = np.clip(img[y - 3:y + 4, x - 3:x + 4] - med, 0, None)
        f = float(win.sum())
        if f <= 0:
            continue
        gy, gx = np.mgrid[-3:4, -3:4]
        out.append((x + float((win * gx).sum() / f), y + float((win * gy).sum() / f), f))
    out.sort(key=lambda r: -r[2])
    return np.array(out[:max_n], dtype=float).reshape(-1, 3)


def tangent(ra, dec, ra0, dec0):
    """Piano tangente (arcsec): xi verso est, eta verso nord."""
    a, d, d0 = np.radians(np.asarray(ra) - ra0), np.radians(np.asarray(dec)), math.radians(dec0)
    den = np.sin(d0) * np.sin(d) + np.cos(d0) * np.cos(d) * np.cos(a)
    return np.degrees(np.cos(d) * np.sin(a) / den) * 3600, np.degrees((np.cos(d0) * np.sin(d) - np.sin(d0) * np.cos(d) * np.cos(a)) / den) * 3600


def propagate(g: np.ndarray, years: float):
    """g: colonne ra, dec, pmra(mas/yr, gia' cos dec), pmdec -> (ra, dec) dopo 'years' anni."""
    dec = g[:, 1] + g[:, 3] / 3.6e6 * years
    ra = g[:, 0] + g[:, 2] / 3.6e6 * years / np.cos(np.radians(g[:, 1]))
    return ra, dec


def _votes(px, py, gx, gy, par, s, th, cell=4.0, span=420.0):
    c, sn = math.cos(math.radians(th)), math.sin(math.radians(th))
    X, Y = par * px * s, py * s
    mx, my = c * X - sn * Y, sn * X + c * Y
    tx = (gx[None, :] - mx[:, None]).ravel()
    ty = (gy[None, :] - my[:, None]).ravel()
    ok = (np.abs(tx) < span) & (np.abs(ty) < span)
    n = int(2 * span / cell)
    hist, _, _ = np.histogram2d(tx[ok], ty[ok], bins=n, range=[[-span, span], [-span, span]])
    sm = hist.copy()
    sm[1:] += hist[:-1]; sm[:-1] += hist[1:]
    t = sm.copy()
    t[:, 1:] += sm[:, :-1]; t[:, :-1] += sm[:, 1:]
    i, j = np.unravel_index(int(np.argmax(t)), t.shape)
    return float(t[i, j]), -span + (i + 0.5) * cell, -span + (j + 0.5) * cell


def solve(peaks: np.ndarray, gx: np.ndarray, gy: np.ndarray, roll: float | None, skip: int | None = None, scale0: float = 2.99):
    """Trasformazione pixel -> piano tangente. skip = indice Gaia da escludere dall'adattamento (la stella bersaglio).
    Ritorna dict (a, b, tx, ty, par, scale, rot, n, rms, pairs) oppure None."""
    px, py = peaks[:, 0] - peaks[:, 0].mean(), peaks[:, 1] - peaks[:, 1].mean()
    cx, cy = float(peaks[:, 0].mean()), float(peaks[:, 1].mean())
    keep = np.ones(len(gx), bool)
    if skip is not None:
        keep[skip] = False
    gxk, gyk = gx[keep], gy[keep]
    cand = []
    if roll is not None:                               # rotazione dal satellite: ROLL - 90 gradi (verificato su Barnard)
        base = roll - 90.0
        cand += [(1, s, base + d) for s in (scale0 - 0.05, scale0, scale0 + 0.05) for d in np.arange(-4, 4.01, 0.5)]
    best = None
    for par, s, th in cand:
        sc, tx, ty = _votes(px, py, gxk, gyk, par, s, th)
        if best is None or sc > best[0]:
            best = (sc, par, s, th, tx, ty)
    if best is None or best[0] < 6:                    # ricerca completa su tutto il cerchio
        for par in (1, -1):
            for s in (scale0 - 0.1, scale0, scale0 + 0.1):
                for th in np.arange(0, 360, 1.0):
                    sc, tx, ty = _votes(px, py, gxk, gyk, par, s, th)
                    if best is None or sc > best[0]:
                        best = (sc, par, s, th, tx, ty)
    if best is None:
        return None
    _, par, s, th, tx, ty = best
    c, sn = math.cos(math.radians(th)) * s, math.sin(math.radians(th)) * s
    a, b = c, sn
    pairs = []
    for tol in (14.0, 10.0, 7.0, 5.0, 4.0):
        mx, my = a * par * px - b * py + tx, b * par * px + a * py + ty
        pairs = []
        used = set()
        for i in range(len(px)):
            d = np.hypot(mx[i] - gxk, my[i] - gyk)
            j = int(np.argmin(d))
            if d[j] < tol and j not in used:
                pairs.append((i, j)); used.add(j)
        if len(pairs) < 4:
            return None
        A, B = [], []
        for i, j in pairs:
            u, v = par * px[i], py[i]
            A += [[u, -v, 1, 0], [v, u, 0, 1]]
            B += [gxk[j], gyk[j]]
        a, b, tx, ty = np.linalg.lstsq(np.array(A), np.array(B), rcond=None)[0]
    mx, my = a * par * px - b * py + tx, b * par * px + a * py + ty
    res = [math.hypot(mx[i] - gxk[j], my[i] - gyk[j]) for i, j in pairs]
    return {"a": float(a), "b": float(b), "tx": float(tx), "ty": float(ty), "par": par, "cx": cx, "cy": cy,
            "scale": math.hypot(a, b), "rot": math.degrees(math.atan2(b, a)), "n": len(pairs), "rms": float(np.sqrt(np.mean(np.square(res))))}


def to_sky(T, x, y):
    px, py = x - T["cx"], y - T["cy"]
    return T["a"] * T["par"] * px - T["b"] * py + T["tx"], T["b"] * T["par"] * px + T["a"] * py + T["ty"]


def to_pix(T, xi, eta):
    det = T["a"] * T["par"] * T["a"] + T["b"] * T["b"] * T["par"]            # det di [[a*par, -b], [b*par, a]]
    u, v = xi - T["tx"], eta - T["ty"]
    px = (T["a"] * u + T["b"] * v) / det
    py = (-T["b"] * T["par"] * u + T["a"] * T["par"] * v) / det
    return px + T["cx"], py + T["cy"]


def check_star(img, hdr, gaia: np.ndarray, star: dict, half: int = 20) -> dict:
    """gaia: righe (ra, dec, pmra, pmdec, G). star: {ra, dec, pmra, pmdec} all'epoca 2016 (mas/yr). Ritorna il verdetto + ritaglio."""
    jd = float(hdr["JD-OBS"])
    year = 2000 + (jd - 2451544.5) / 365.25
    dt = year - GAIA_EPOCH
    ra0, dec0 = sexa(hdr["OBJCTRA"], True), sexa(hdr["OBJCTDEC"], False)
    roll = float(hdr["OBJCTROL"]) if "OBJCTROL" in hdr else None
    peaks = find_peaks(img)
    if len(peaks) < 8:
        return {"ok": False, "reason": "few_peaks", "year": year}
    ra, dec = propagate(gaia, dt)
    gx, gy = tangent(ra, dec, ra0, dec0)
    # la stella bersaglio e' nel catalogo? (la escludiamo dall'adattamento per misurarla in modo indipendente)
    sx, sy = tangent(*propagate(np.array([[star["ra"], star["dec"], star["pmra"], star["pmdec"]]]), dt), ra0, dec0)
    d = np.hypot(gx - sx[0], gy - sy[0])
    skip = int(np.argmin(d)) if d.min() < 3.0 else None
    T = solve(peaks, gx, gy, roll, skip)
    if T is None or T["n"] < 6 or T["rms"] > 4.0:
        return {"ok": False, "reason": "no_solution", "year": year}
    # dove dovrebbe essere la stella: (a) con moto proprio, (b) alla posizione Gaia 2016
    x1, y1 = to_pix(T, float(sx[0]), float(sy[0]))
    s16x, s16y = (float(v) for v in tangent(star["ra"], star["dec"], ra0, dec0))
    x0, y0 = to_pix(T, s16x, s16y)
    h, w = img.shape
    out = {"ok": True, "year": year, "scale": T["scale"], "rms": T["rms"], "n": T["n"], "w": w, "h": h,
           "pred": [x1, y1], "pred2016": [x0, y0], "arcsec_2016": float(math.hypot(float(sx[0]) - s16x, float(sy[0]) - s16y))}
    if not (0 <= x1 < w and 0 <= y1 < h):
        out.update(ok=False, reason="outside")
        return out
    best = None
    for p in peaks:
        dpx = math.hypot(p[0] - x1, p[1] - y1)
        if dpx < 6 and (best is None or p[2] > best[2]):
            best = p
    if best is not None:
        mxs, mys = to_sky(T, best[0], best[1])
        out["found"] = True
        out["measured"] = [float(best[0]), float(best[1])]
        out["offset_arcsec"] = float(math.hypot(mxs - sx[0], mys - sy[0]))
    else:
        out["found"] = False
    # ritaglio (valori scalati 0-255, radice quadrata del segnale sopra il fondo)
    x_i, y_i = int(round(x1)), int(round(y1))
    ya, yb, xa, xb = max(0, y_i - half), min(h, y_i + half + 1), max(0, x_i - half), min(w, x_i + half + 1)
    crop = img[ya:yb, xa:xb] - float(np.median(img))
    top = float(np.percentile(crop, 99.7)) or 1.0
    crop = np.sqrt(np.clip(crop / top, 0, 1)) * 255
    out["crop"] = {"x0": xa, "y0": ya, "w": xb - xa, "h": yb - ya, "data": crop.astype(int).ravel().tolist()}
    return out
