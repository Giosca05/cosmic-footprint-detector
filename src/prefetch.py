"""
Precarico in cache (all'avvio, in background) dei ritagli attorno a ogni bersaglio di data/missions.json.

Perche': la prima volta che si vola in una zona i ritagli vanno scaricati (Worker/S3). Qui li scarichiamo prima, cosi' volando
nel raggio di RADIUS settori da un bersaglio tutto esce dal disco in pochi ms.

Gli URL sono IDENTICI a quelli che chiede la pagina (public/js/explorer.js): stesso passo dei settori, stesse immagini scelte
(primi 12 + pickSpread sull'elenco completo), stessi arrotondamenti, quindi la cache su disco (chiave = hash dell'URL) viene riusata.
Se si cambiano campo (FOV) o numero di immagini nella pagina, gli URL cambiano e il precarico serve solo ai valori predefiniti.

Rispetta l'utente: si ferma mentre la pagina sta chiedendo dati (`activity()`), usa pochi thread e ha un tetto giornaliero di
richieste di rete (il Worker Cloudflare gratuito ne concede 100.000 al giorno). I settori senza copertura sono ricordati su disco.

Variabili: CFD_PREFETCH_RADIUS (default 0 = spento; es. 10 per attivarlo, ~5 GB), CFD_PREFETCH_BUDGET (default 70000 richieste/giorno),
CFD_PREFETCH_THREADS (default 8).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, unquote

FOV, OV, COUNT, FIRST_ROWS = 0.15, 0.18, 60, 12          # valori predefiniti della pagina
CUT = min(0.2, FOV * 1.35)
STEP = FOV * 3600 * (1 - OV)                              # passo tra settori (arcsec)
D2R = math.pi / 180


def sky_from_offset(ra0: float, dec0: float, east: float, north: float) -> tuple[float, float]:
    """(ra, dec) del punto a (est, nord) arcsec dal centro: stessa formula di wcs.js skyFromOffset."""
    a, d = ra0 * D2R, dec0 * D2R
    c = (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))
    e = (-math.sin(a), math.cos(a), 0.0)
    n = (-math.sin(d) * math.cos(a), -math.sin(d) * math.sin(a), math.cos(d))
    xi, eta = east / 3600 * D2R, north / 3600 * D2R
    v = [c[i] + xi * e[i] + eta * n[i] for i in range(3)]
    r = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    ra = math.atan2(v[1], v[0]) / D2R
    if ra < 0:
        ra += 360
    return ra, math.asin(v[2] / r) / D2R


def key_of_uri(u: str) -> str:
    return str(u or "").split("?")[0]


def pick_spread(rows: list[dict], chosen: list[dict], count: int) -> list[dict]:
    """Port di pickSpread (explorer.js): osservazioni distribuite sul tempo e sui rivelatori."""
    have = {key_of_uri(r["uri"]) for r in chosen}
    cells: dict[str, list[dict]] = {}
    visit, last = 0, None
    for r in sorted(rows, key=lambda r: r["time_bounds_lower"]):
        if last is not None and r["time_bounds_lower"] - last > 20:
            visit += 1
        last = r["time_bounds_lower"]
        m = re.search(r"_(\d+)D(\d+)_spx", unquote(r.get("uri") or ""))
        key = f"{visit}:{m.group(2) if m else '?'}"
        cells.setdefault(key, [])
        if key_of_uri(r["uri"]) not in have:
            cells[key].append(r)
    lists = [l for l in cells.values() if l]
    quota = [0] * len(lists)
    left = max(0, count - len(chosen))
    while left > 0:
        gave = 0
        for i, l in enumerate(lists):
            if left > 0 and quota[i] < len(l):
                quota[i] += 1
                left -= 1
                gave += 1
        if not gave:
            break
    out = []
    for i, l in enumerate(lists):
        for j in range(quota[i]):
            out.append(l[min(len(l) - 1, math.floor((j + 0.5) * len(l) / quota[i]))])
    return out


def retarget(uri: str, ra: float, dec: float, size: float) -> str:
    """Stessa sostituzione di retarget() nel client."""
    if re.search(r"center=", uri):
        uri = re.sub(r"center=([^&,%]+)(?:,|%2C)([-+\d.eE]+)([a-z]*)",
                     lambda m: f"center={ra:.6f},{dec:.6f}{m.group(3) or 'd'}", uri, count=1, flags=re.I)
        return re.sub(r"size=[^&]+", f"size={size:g}", uri, count=1)
    uri = re.sub(r"ra=[^&]+", f"ra={ra:.6f}", uri, count=1)
    uri = re.sub(r"dec=[^&]+", f"dec={dec:.6f}", uri, count=1)
    return re.sub(r"size=[^&]+", f"size={size:g}", uri, count=1)


def sectors_by_distance(radius: int) -> list[tuple[int, int]]:
    out = [(a, b) for a in range(-radius, radius + 1) for b in range(-radius, radius + 1) if a * a + b * b <= radius * radius]
    out.sort(key=lambda s: (s[0] ** 2 + s[1] ** 2, s))
    return out


class Prefetcher(threading.Thread):
    def __init__(self, *, port: int, missions: list[dict], mission_position, fast_cutout, cutout_path, no_coverage,
                 worker_ok, data_dir: Path, activity):
        super().__init__(daemon=True, name="prefetch")
        self.port, self.missions, self.mission_position = port, missions, mission_position
        self.fast_cutout, self.cutout_path, self.NoCoverage = fast_cutout, cutout_path, no_coverage
        self.worker_ok, self.activity = worker_ok, activity
        self.radius = int(os.environ.get("CFD_PREFETCH_RADIUS", "0"))
        self.budget = int(os.environ.get("CFD_PREFETCH_BUDGET", "70000"))
        self.threads = int(os.environ.get("CFD_PREFETCH_THREADS", "8"))
        self.state_file, self.nocov_file = Path(data_dir) / "prefetch_state.json", Path(data_dir) / "prefetch_nocov.txt"
        self.nocov: set[str] = set()
        self.stats = {"on": self.radius > 0, "radius": self.radius, "done": 0, "fetched": 0, "nocov": 0, "total": 0, "state": "avvio", "mission": "", "by": {}, "cached": {}}
        self.stop = False

    # ---- stato su disco -------------------------------------------------------------------------------------------
    def _used_today(self) -> int:
        try:
            s = json.loads(self.state_file.read_text(encoding="utf-8"))
            return int(s["n"]) if s.get("day") == time.strftime("%Y-%m-%d") else 0
        except Exception:                                    # noqa: BLE001
            return 0

    def _save_used(self, n: int) -> None:
        try:
            self.state_file.write_text(json.dumps({"day": time.strftime("%Y-%m-%d"), "n": n}), encoding="utf-8")
        except OSError:
            pass

    @staticmethod
    def _h(url: str) -> str:
        return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]

    # ---- elenchi (come la pagina: stessa richiesta al nostro server) ---------------------------------------------
    def _get(self, path: str, timeout: float = 180) -> dict:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={"X-Prefetch": "1"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def _list(self, ra: float, dec: float, n: int) -> dict:
        q = f"/api/images?ra={ra:.2f}&dec={dec:.2f}&size={CUT:g}&max={n}&order=both"
        for i in range(4):
            try:
                return self._get(q)
            except Exception:                                # noqa: BLE001
                time.sleep(5 * (i + 1))
        return {"rows": []}

    def _plan(self, m: dict) -> dict | None:
        ra, dec = self.mission_position(m)
        first = self._list(ra, dec, min(FIRST_ROWS, COUNT))
        if not first.get("rows"):
            return None
        full = {"rows": []}
        for _ in range(3):
            full = self._list(ra, dec, COUNT)
            if not full.get("partial"):
                break
        extra = pick_spread(full.get("rows") or [], first["rows"], COUNT)
        return {"m": m, "ra": ra, "dec": dec, "rows": first["rows"] + extra}

    def _urls(self, plan: dict, a: int, b: int) -> list[str]:
        if a == 0 and b == 0:                                # il settore centrale usa gli URL dell'elenco, senza ricentrarli
            return [r["uri"] for r in plan["rows"]]
        ra, dec = sky_from_offset(plan["ra"], plan["dec"], a * STEP, b * STEP)
        return [retarget(r["uri"], ra, dec, CUT) for r in plan["rows"]]

    # ---- ciclo principale ----------------------------------------------------------------------------------------
    def _wait_idle(self) -> None:
        while not self.stop and time.time() - self.activity() < 3.0:
            self.stats["state"] = "in pausa (stai usando la pagina)"
            time.sleep(1)

    def run(self) -> None:
        if self.radius <= 0:
            return
        time.sleep(4)                                        # il server deve essere in ascolto
        if not self.worker_ok():
            self.stats["state"] = "spento (Worker Cloudflare non configurato)"
            print("  [Precarico] spento: serve il Worker Cloudflare (data/worker_url.txt)")
            return
        try:
            self.nocov = set(self.nocov_file.read_text(encoding="utf-8").split())
        except OSError:
            pass
        plans = []
        for m in self.missions:
            self.stats["state"] = f"elenchi: {m.get('name')}"
            try:
                p = self._plan(m)
            except Exception as exc:                         # noqa: BLE001
                print(f"  [Precarico] {m.get('name')}: elenco non disponibile ({exc})")
                p = None
            if p:
                plans.append(p)
        if not plans:
            self.stats["state"] = "nessun elenco"
            return
        secs = sectors_by_distance(self.radius)
        self.stats["total"] = sum(len(secs) * len(p["rows"]) for p in plans)
        used = self._used_today()
        print(f"  [Precarico] {len(plans)} bersagli x {len(secs)} settori (raggio {self.radius}), tetto {self.budget} richieste/giorno "
              f"(oggi gia' {used})")
        pool = ThreadPoolExecutor(self.threads)
        new_nocov: list[str] = []
        t0, last_log = time.time(), 0
        # anelli alternati tra i bersagli: se si e' interrotti, ogni bersaglio ha almeno le zone vicine
        for a, b in secs:
            for p in plans:
                if self.stop:
                    return
                todo = []
                for u in self._urls(p, a, b):
                    if self.cutout_path(u).exists() or self._h(u) in self.nocov:
                        self.stats["done"] += 1
                        nm = p["m"].get("id", "?"); self.stats["cached"][nm] = self.stats["cached"].get(nm, 0) + 1
                        continue
                    todo.append(u)
                for i in range(0, len(todo), self.threads * 2):
                    chunk = todo[i:i + self.threads * 2]
                    self._wait_idle()
                    while not self.worker_ok():              # Worker in pausa (errori): aspetto, non martello S3/IRSA
                        self.stats["state"] = "in pausa (Worker non risponde)"
                        time.sleep(15)
                    if used + len(chunk) > self.budget:
                        self.stats["state"] = f"tetto giornaliero raggiunto ({used}): riprende alla prossima apertura"
                        print(f"  [Precarico] {self.stats['state']}")
                        self._save_used(used)
                        return
                    self.stats["state"] = f"scarico {p['m'].get('name')} settore {a},{b}"
                    self.stats["mission"] = p["m"].get("name", "")
                    res = list(pool.map(self._one, chunk))
                    for u, r in zip(chunk, res):
                        used += 1
                        self.stats["done"] += 1
                        if r == "nocov":
                            self.nocov.add(self._h(u)); new_nocov.append(self._h(u)); self.stats["nocov"] += 1
                        elif r == "ok":
                            self.stats["fetched"] += 1
                            nm = p["m"].get("id", "?"); self.stats["by"][nm] = self.stats["by"].get(nm, 0) + 1
                    if new_nocov:
                        try:
                            with open(self.nocov_file, "a", encoding="utf-8") as f:
                                f.write("\n".join(new_nocov) + "\n")
                        except OSError:
                            pass
                        new_nocov = []
                    if self.stats["done"] - last_log >= 1000:
                        last_log = self.stats["done"]
                        self._save_used(used)
                        print(f"  [Precarico] {self.stats['done']}/{self.stats['total']} ({self.stats['fetched']} scaricati, "
                              f"{self.stats['nocov']} fuori campo) in {time.time() - t0:.0f}s")
        self._save_used(used)
        self.stats["state"] = "completato"
        print(f"  [Precarico] completato: {self.stats['fetched']} ritagli scaricati in {time.time() - t0:.0f}s")

    def _one(self, url: str) -> str:
        try:
            self.fast_cutout(url)
            return "ok"
        except self.NoCoverage:
            return "nocov"
        except Exception:                                    # noqa: BLE001 (rete: si riprovera' al prossimo avvio)
            return "err"
