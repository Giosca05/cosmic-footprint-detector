"""
api_client.py: client per query MIRATE ai servizi astronomici IPAC/IRSA.

NON scarica database interi: ogni richiesta è una cone search (RA/Dec + raggio)
oppure una ricerca per nome di oggetto, con limiti rigidi su raggio e righe
(vedi src/config.py: API_MAX_RADIUS_ARCSEC, API_MAX_ROWS).

======================== ENDPOINT USATI ========================
1. IRSA TAP (sincrono, ADQL)   https://irsa.ipac.caltech.edu/TAP/sync
   - Pubblico, NESSUNA chiave richiesta.
   - Tabelle per alias in config.IRSA_CATALOGS:
       spherex  -> spherex.obscore (metadati osservazioni; colonne s_ra/s_dec da provare)
   - IMMAGINI SPHEREx: tabelle spherex.artifact + spherex.plane (query ufficiale
     dal tutorial IRSA 'spherex-cutouts'), usate da IrsaClient.spherex_images().
     I ritagli FITS (piccoli) si scaricano con IrsaClient.download_cutout().
   - Le query usano le colonne `ra` e `dec`: se una tabella (es. SPHEREx) usa
     nomi diversi, adatta build_cone_adql().
2. Risoluzione nome -> coordinate  astropy.coordinates.SkyCoord.from_name
   (usa il servizio Sesame del CDS; richiede `astropy` e rete).
3. (Opzionale) api.nasa.gov: NASA_API_KEY è predisposta in config ma questo
   client NON la usa ancora (nessuna chiamata a api.nasa.gov implementata).
4. AWS S3 (dataset aperti IRSA): NON implementato. TODO: verificare nomi dei
   bucket nella documentazione IRSA prima di aggiungerlo.

======================== CONFIGURAZIONE ========================
- Nessuna chiave per IRSA. Variabili d'ambiente opzionali:
    IRSA_TAP_SYNC_URL   per cambiare endpoint (es. test)
    NASA_API_KEY        per futuri usi di api.nasa.gov (mai nel codice/git)
  Windows (PowerShell):  $env:NASA_API_KEY = "la_tua_chiave"
- Tutti gli altri parametri (timeout, retry, rate limit, cartella cache) sono
  in src/config.py.

======================== COMPORTAMENTO ========================
- Rate limiting lato client: pausa minima API_MIN_INTERVAL_S tra richieste.
- Errori di rete / HTTP 429 / 5xx: nuovi tentativi con backoff esponenziale
  (rispetta l'header Retry-After se presente).
- Errori 4xx (query errata): niente retry, ApiError con il messaggio del server.
- FALLBACK: ogni risultato è salvato in data/api_cache/<hash>.json. Se la rete
  fallisce, viene restituita la copia salvata (flag `stale=True`).
  Per la stessa query, la cache evita nuove richieste (usa refresh=True per forzare).

======================== USO ========================
    python -m src.api_client --ra 150.0 --dec 2.2 --radius 120 --catalog spherex
    python -m src.api_client --name "Alpha Centauri" --radius 60 --catalog spherex
    python -m src.api_client --list-catalogs
    python -m src.api_client --spherex-images --ra 210.80227 --dec 54.34895 --size 0.1 --bandpass SPHEREx-D2
    python -m src.api_client --spherex-images --ra 210.80227 --dec 54.34895 --download-cutouts 2
Da codice:
    from src.api_client import IrsaClient
    res = IrsaClient().cone_search(150.0, 2.2, 120, catalog="spherex")
    res.rows  # lista di dict
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests

from src import config


# ============================================================================
# 1. ECCEZIONI
# ============================================================================
class ApiError(Exception):
    """Errore restituito dal server (es. query ADQL non valida) o risposta anomala."""


class ApiNetworkError(ApiError):
    """Rete non raggiungibile / timeout / troppi errori dopo tutti i tentativi."""


class ApiInputError(ValueError):
    """Parametri di input non validi o oltre i limiti di sicurezza."""


# ============================================================================
# 2. RATE LIMITER (pausa minima tra richieste consecutive)
# ============================================================================
class RateLimiter:
    """Garantisce almeno `min_interval_s` secondi tra due chiamate."""

    def __init__(self, min_interval_s: float, sleep: Callable[[float], None] = time.sleep):
        self.min_interval_s = min_interval_s
        self._sleep = sleep
        self._last: float | None = None

    def wait(self) -> None:
        now = time.monotonic()
        if self._last is not None:
            remaining = self.min_interval_s - (now - self._last)
            if remaining > 0:
                self._sleep(remaining)
        self._last = time.monotonic()


# ============================================================================
# 3. VALIDAZIONE E COSTRUZIONE QUERY ADQL
# ============================================================================
_IDENT = re.compile(r"^[A-Za-z0-9_.]+$")


def resolve_catalog(catalog: str) -> str:
    """Converte un alias (es. 'spherex') nel nome tabella IRSA, con controlli."""
    table = config.IRSA_CATALOGS.get(catalog, catalog)
    if table.startswith("TODO"):
        raise ApiInputError(
            f"Catalogo '{catalog}' non configurato: imposta il nome tabella "
            f"in config.IRSA_CATALOGS dopo averlo verificato su IRSA."
        )
    if not _IDENT.match(table):
        raise ApiInputError(f"Nome tabella non valido: {table!r}")
    return table


def _check_columns(columns: str) -> str:
    """Ammette '*' oppure un elenco di identificatori separati da virgola."""
    if columns.strip() == "*":
        return "*"
    parts = [c.strip() for c in columns.split(",")]
    if not parts or not all(_IDENT.match(p) for p in parts):
        raise ApiInputError(f"Elenco colonne non valido: {columns!r}")
    return ", ".join(parts)


def validate_cone(ra_deg: float, dec_deg: float, radius_arcsec: float, max_rows: int) -> None:
    """Controlla intervalli di coordinate e limiti anti-download massivo."""
    if not (0.0 <= ra_deg < 360.0):
        raise ApiInputError(f"RA fuori range [0,360): {ra_deg}")
    if not (-90.0 <= dec_deg <= 90.0):
        raise ApiInputError(f"Dec fuori range [-90,90]: {dec_deg}")
    if not (0.0 < radius_arcsec <= config.API_MAX_RADIUS_ARCSEC):
        raise ApiInputError(
            f"Raggio {radius_arcsec}\" non valido: deve essere in (0, {config.API_MAX_RADIUS_ARCSEC}]"
        )
    if not (1 <= max_rows <= config.API_MAX_ROWS):
        raise ApiInputError(f"max_rows deve essere in [1, {config.API_MAX_ROWS}]")


def build_cone_adql(table: str, ra_deg: float, dec_deg: float, radius_arcsec: float,
                    columns: str = "*", max_rows: int = 100,
                    ra_col: str = "ra", dec_col: str = "dec") -> str:
    """Costruisce la query ADQL di cone search (raggio convertito in gradi)."""
    cols = _check_columns(columns)
    for col in (ra_col, dec_col):
        if not _IDENT.match(col):
            raise ApiInputError(f"Nome colonna non valido: {col!r}")
    radius_deg = radius_arcsec / 3600.0
    return (
        f"SELECT TOP {int(max_rows)} {cols} FROM {table} "
        f"WHERE CONTAINS(POINT('ICRS', {ra_col}, {dec_col}), "
        f"CIRCLE('ICRS', {float(ra_deg)}, {float(dec_deg)}, {radius_deg}))=1"
    )


_BANDPASS = re.compile(r"^[A-Za-z0-9_-]+$")


def build_spherex_images_adql(ra_deg: float, dec_deg: float, size_deg: float = 0.1,
                              bandpass: str | None = None, max_rows: int = 50) -> str:
    """
    Query ufficiale IRSA (tutorial 'spherex-cutouts') per le immagini SPHEREx
    che contengono una posizione: join spherex.artifact + spherex.plane, filtro
    spaziale sul poligono `p.poly`, ordinamento per data.
    """
    if not (0.0 < size_deg <= config.CUTOUT_MAX_SIZE_DEG):
        raise ApiInputError(f"size_deg deve essere in (0, {config.CUTOUT_MAX_SIZE_DEG}]")
    band = ""
    if bandpass:
        names = [b.strip() for b in bandpass.split(",") if b.strip()]            # una banda o piu' bande separate da virgola (es. SPHEREx-D5,SPHEREx-D6)
        if not names or len(names) > 6 or not all(_BANDPASS.match(b) for b in names):
            raise ApiInputError(f"Bandpass non valido: {bandpass!r}")
        if len(names) == 1:
            band = f"AND p.energy_bandpassname = '{names[0]}' "
        else:
            band = "AND p.energy_bandpassname IN (" + ", ".join(f"'{b}'" for b in names) + ") "
    ra, dec = float(ra_deg), float(dec_deg)
    return (
        f"SELECT TOP {int(max_rows)} "
        f"'{config.IRSA_BASE_URL}' || a.uri || '?center={ra},{dec}d&size={float(size_deg)}' AS uri, "
        f"p.time_bounds_lower "
        f"FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly) {band}"
        f"ORDER BY p.time_bounds_lower"
    )


def check_cutout_url(url: str) -> None:
    """Accetta solo URL IRSA di ritagli piccoli (evita download arbitrari o enormi)."""
    if not url.startswith(config.IRSA_BASE_URL):
        raise ApiInputError(f"URL non IRSA rifiutato: {url[:80]}")
    m = re.search(r"[?&]size=([0-9.]+)", url)
    if not m:
        raise ApiInputError("L'URL non contiene 'size=': rifiutato (sarebbe l'immagine intera)")
    if float(m.group(1)) > config.CUTOUT_MAX_SIZE_DEG:
        raise ApiInputError(f"Ritaglio troppo grande (> {config.CUTOUT_MAX_SIZE_DEG} gradi)")


# ============================================================================
# 4. RISULTATO
# ============================================================================
@dataclass
class QueryResult:
    """Esito di una query. `stale=True` = dati dal fallback locale dopo un errore di rete."""
    rows: list[dict[str, Any]]
    query: str
    from_cache: bool = False
    stale: bool = False
    cache_path: Path | None = None
    meta: dict[str, Any] = field(default_factory=dict)


# ============================================================================
# 5. CLIENT IRSA
# ============================================================================
def _coerce(value: str) -> Any:
    """Converte le stringhe CSV in int/float/None quando possibile."""
    if value == "":
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


class IrsaClient:
    """Client per IRSA TAP con retry, rate limiting e cache/fallback su disco."""

    def __init__(self,
                 session: requests.Session | None = None,
                 cache_dir: Path | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        self.session = session or requests.Session()
        self.cache_dir = Path(cache_dir) if cache_dir else config.API_CACHE_DIR
        self._sleep = sleep
        self._limiter = RateLimiter(config.API_MIN_INTERVAL_S, sleep)

    # ---------- cache su disco ------------------------------------------------
    def _cache_path(self, adql: str) -> Path:
        key = hashlib.sha256(adql.encode("utf-8")).hexdigest()[:16]
        return self.cache_dir / f"irsa_{key}.json"

    def _save_cache(self, adql: str, rows: list[dict[str, Any]]) -> Path:
        path = self._cache_path(adql)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "query": adql,
            "source": config.IRSA_TAP_SYNC_URL,
            "saved_utc": datetime.now(timezone.utc).isoformat(),
            "n_rows": len(rows),
            "rows": rows,
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def _load_cache(self, adql: str) -> tuple[list[dict[str, Any]], Path] | None:
        path = self._cache_path(adql)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data["rows"], path
        except (json.JSONDecodeError, KeyError, OSError):
            return None  # cache corrotta: ignorata

    # ---------- chiamata HTTP con retry -----------------------------------------
    def _get_with_retry(self, url: str, params: dict | None) -> requests.Response:
        """GET con rate limiting, retry e backoff. Restituisce la risposta 200."""
        last_error: Exception | None = None

        for attempt in range(config.API_MAX_RETRIES + 1):
            self._limiter.wait()
            backoff = config.API_BACKOFF_BASE_S * (2 ** attempt)
            try:
                resp = self.session.get(url, params=params,
                                        timeout=config.API_TIMEOUT_S)
            except (requests.Timeout, requests.ConnectionError) as exc:
                last_error = exc
                self._sleep(backoff)
                continue

            if resp.status_code == 200:
                return resp

            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = resp.headers.get("Retry-After", "")
                wait = float(retry_after) if retry_after.isdigit() else backoff
                last_error = ApiError(f"HTTP {resp.status_code}")
                self._sleep(wait)
                continue

            # Altri 4xx: query sbagliata, inutile riprovare.
            raise ApiError(f"HTTP {resp.status_code}: {resp.text[:300]}")

        raise ApiNetworkError(f"Richiesta fallita dopo {config.API_MAX_RETRIES + 1} tentativi: {last_error}")

    def _http_get_csv(self, adql: str) -> str:
        """Esegue una query TAP e restituisce il testo CSV."""
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": adql}
        text = self._get_with_retry(config.IRSA_TAP_SYNC_URL, params).text
        # Un errore TAP può arrivare come VOTable/XML invece che CSV.
        if text.lstrip().startswith("<"):
            raise ApiError(f"Risposta non CSV dal server: {text[:300]}")
        return text

    # ---------- SPHEREx: elenco immagini e ritagli ---------------------------------
    def spherex_images(self, ra_deg: float, dec_deg: float, size_deg: float = 0.1,
                       bandpass: str | None = None, max_rows: int = 50,
                       refresh: bool = False) -> QueryResult:
        """
        Elenca le immagini spettrali SPHEREx che coprono (RA, Dec), con URL del
        RITAGLIO (non dell'immagine intera) e data di osservazione (MJD) in
        `time_bounds_lower`. Ordinate dalla più vecchia. Può richiedere ~20 s.
        """
        validate_cone(ra_deg, dec_deg, 1.0, max_rows)
        adql = build_spherex_images_adql(ra_deg, dec_deg, size_deg, bandpass, max_rows)
        result = self.run_adql(adql, refresh=refresh)
        result.meta.update({"kind": "spherex_images", "ra_deg": ra_deg, "dec_deg": dec_deg,
                            "size_deg": size_deg, "bandpass": bandpass})
        return result

    def download_cutout(self, url: str, out_dir: Path | None = None) -> Path:
        """Scarica UN ritaglio FITS (solo da IRSA, solo se piccolo). Salta se già presente."""
        check_cutout_url(url)
        out_dir = Path(out_dir) if out_dir else config.CUTOUT_DIR
        stem = url.split("?")[0].rsplit("/", 1)[-1].replace(".fits", "")
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
        path = out_dir / f"{stem}_{key}.fits"
        if path.exists():
            return path
        data = self._get_with_retry(url, None).content
        if not data.startswith(b"SIMPLE"):  # ogni file FITS inizia così
            raise ApiError("La risposta non sembra un file FITS")
        out_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    # ---------- API pubblica ------------------------------------------------------
    def run_adql(self, adql: str, refresh: bool = False, use_cache: bool = True) -> QueryResult:
        """
        Esegue una query ADQL (già validata/costruita da noi).
        Ordine: cache valida -> rete -> (se rete KO) cache come fallback 'stale'.
        """
        cached = self._load_cache(adql) if use_cache else None
        if cached and not refresh:
            rows, path = cached
            return QueryResult(rows, adql, from_cache=True, cache_path=path)

        try:
            text = self._http_get_csv(adql)
        except ApiNetworkError:
            if cached:
                rows, path = cached
                return QueryResult(rows, adql, from_cache=True, stale=True, cache_path=path)
            raise

        reader = csv.DictReader(io.StringIO(text))
        rows = [{k: _coerce(v) for k, v in row.items()} for row in reader]
        path = self._save_cache(adql, rows) if use_cache else None
        return QueryResult(rows, adql, cache_path=path)

    def cone_search(self, ra_deg: float, dec_deg: float, radius_arcsec: float,
                    catalog: str = "spherex", columns: str = "*", max_rows: int = 100,
                    refresh: bool = False) -> QueryResult:
        """Cone search mirata su un catalogo IRSA."""
        validate_cone(ra_deg, dec_deg, radius_arcsec, max_rows)
        table = resolve_catalog(catalog)
        ra_col, dec_col = config.IRSA_COORD_COLUMNS.get(table, ("ra", "dec"))
        adql = build_cone_adql(table, ra_deg, dec_deg, radius_arcsec, columns, max_rows,
                               ra_col, dec_col)
        result = self.run_adql(adql, refresh=refresh)
        result.meta.update({"catalog": catalog, "table": table,
                            "ra_deg": ra_deg, "dec_deg": dec_deg,
                            "radius_arcsec": radius_arcsec})
        return result

    def query_by_name(self, name: str, radius_arcsec: float, catalog: str = "spherex",
                      columns: str = "*", max_rows: int = 100,
                      refresh: bool = False) -> QueryResult:
        """Risolve un nome (es. 'Alpha Centauri') in RA/Dec e fa la cone search."""
        ra, dec = resolve_name(name)
        result = self.cone_search(ra, dec, radius_arcsec, catalog, columns, max_rows, refresh)
        result.meta["object_name"] = name
        return result


# ============================================================================
# 6. UTILITÀ: risoluzione nomi e salvataggio
# ============================================================================
def resolve_name(name: str) -> tuple[float, float]:
    """Nome oggetto -> (RA, Dec) in gradi ICRS, tramite astropy/Sesame."""
    try:
        from astropy.coordinates import SkyCoord
    except ImportError as exc:  # pragma: no cover
        raise ApiError("astropy non installato: pip install astropy") from exc
    try:
        c = SkyCoord.from_name(name)
    except Exception as exc:  # astropy solleva vari tipi (NameResolveError, rete...)
        raise ApiError(f"Impossibile risolvere il nome {name!r}: {exc}") from exc
    return float(c.icrs.ra.deg), float(c.icrs.dec.deg)


def save_json(result: QueryResult, path: Path) -> Path:
    """Salva un risultato in JSON leggero (es. in data/processed/)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"query": result.query, "meta": result.meta,
               "stale": result.stale, "n_rows": len(result.rows), "rows": result.rows}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def save_fits(result: QueryResult, path: Path) -> Path:
    """Salva i risultati come tabella FITS leggera (richiede astropy)."""
    from astropy.table import Table
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Table(rows=result.rows, names=list(result.rows[0].keys())).write(path, overwrite=True)
    return path


# ============================================================================
# 7. LINEA DI COMANDO
# ============================================================================
def main() -> None:
    p = argparse.ArgumentParser(description="Query mirate a IRSA TAP")
    p.add_argument("--list-catalogs", action="store_true", help="mostra gli alias configurati")
    p.add_argument("--name", help="nome oggetto (es. 'Alpha Centauri')")
    p.add_argument("--ra", type=float, help="RA in gradi")
    p.add_argument("--dec", type=float, help="Dec in gradi")
    p.add_argument("--radius", type=float, default=60.0, help="raggio in arcsec")
    p.add_argument("--catalog", default="spherex", help="alias o nome tabella")
    p.add_argument("--columns", default="*", help="colonne, es. designation,ra,dec,w1mpro")
    p.add_argument("--max-rows", type=int, default=100)
    p.add_argument("--refresh", action="store_true", help="ignora la cache")
    p.add_argument("--out", type=Path, help="salva anche in questo file (.json o .fits)")
    p.add_argument("--spherex-images", action="store_true",
                   help="elenca le immagini SPHEREx che coprono --ra/--dec")
    p.add_argument("--size", type=float, default=0.1, help="lato ritaglio SPHEREx in gradi")
    p.add_argument("--bandpass", help="es. SPHEREx-D2 (solo con --spherex-images)")
    p.add_argument("--download-cutouts", type=int, default=0, metavar="N",
                   help="scarica i primi N ritagli FITS (max config.CUTOUT_MAX_FILES)")
    args = p.parse_args()

    if args.list_catalogs:
        for alias, table in config.IRSA_CATALOGS.items():
            print(f"{alias:<10} {table}")
        return

    client = IrsaClient()
    try:
        if args.spherex_images:
            if args.ra is None or args.dec is None:
                p.error("--spherex-images richiede --ra e --dec")
            res = client.spherex_images(args.ra, args.dec, args.size, args.bandpass,
                                        min(args.max_rows, 50), args.refresh)
        elif args.name:
            res = client.query_by_name(args.name, args.radius, args.catalog,
                                       args.columns, args.max_rows, args.refresh)
        elif args.ra is not None and args.dec is not None:
            res = client.cone_search(args.ra, args.dec, args.radius, args.catalog,
                                     args.columns, args.max_rows, args.refresh)
        else:
            p.error("indica --name oppure --ra e --dec")
    except (ApiError, ApiInputError) as exc:
        raise SystemExit(f"ERRORE: {exc}")

    origin = "cache (DATI POSSIBILMENTE VECCHI)" if res.stale else ("cache" if res.from_cache else "rete")
    print(f"{len(res.rows)} righe da {origin}; file: {res.cache_path}")
    if args.download_cutouts and res.meta.get("kind") == "spherex_images":
        n = min(args.download_cutouts, config.CUTOUT_MAX_FILES)
        for row in res.rows[:n]:
            try:
                print("Ritaglio:", client.download_cutout(row["uri"]))
            except (ApiError, ApiInputError) as exc:
                print(f"  saltato ({exc})")
    if args.out:
        if args.out.suffix.lower() == ".fits":
            if not res.rows:
                raise SystemExit("Nessuna riga: niente da scrivere in FITS.")
            print("Salvato:", save_fits(res, args.out))
        else:
            print("Salvato:", save_json(res, args.out))


if __name__ == "__main__":
    main()
