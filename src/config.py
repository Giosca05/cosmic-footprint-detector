"""config.py: parametri del server e del client IRSA (Cosmic Footprint Detector)."""
import os
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# --- Parametri API (IRSA) ---------------------------------------------------------
IRSA_TAP_SYNC_URL = os.environ.get("IRSA_TAP_SYNC_URL", "https://irsa.ipac.caltech.edu/TAP/sync")
IRSA_BASE_URL = "https://irsa.ipac.caltech.edu/ibe/data/spherex/"
API_CACHE_DIR = DATA_DIR / "api_cache"
CUTOUT_DIR = DATA_DIR / "raw" / "cutouts"
CUTOUT_MAX_SIZE_DEG = 0.2
CUTOUT_MAX_FILES = 20
API_MIN_INTERVAL_S = 1.0
API_MAX_RETRIES = 3
API_BACKOFF_BASE_S = 2.0
API_TIMEOUT_S = 60
API_MAX_ROWS = 1000
API_MAX_RADIUS_ARCSEC = 1800.0
IRSA_CATALOGS = {"spherex": "spherex.obscore"}
IRSA_COORD_COLUMNS = {}

# Crea le cartelle di cache all'avvio (su un server nuovo, come Render, "data/" non le contiene).
for _d in (API_CACHE_DIR, CUTOUT_DIR):
    try:
        _d.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
