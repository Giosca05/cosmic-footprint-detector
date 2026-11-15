# API e query mirate (IRSA / NASA)

Codice: `src/api_client.py`. Parametri: sezione "Parametri API" di `src/config.py`.
Il client fa SOLO query mirate (cone search o nome oggetto): non scarica database interi.

## Endpoint usati
| Servizio | URL | Chiave | Stato |
|---|---|---|---|
| IRSA TAP sincrono (ADQL) | `https://irsa.ipac.caltech.edu/TAP/sync` | non richiesta | implementato |

## Cataloghi (alias in `config.IRSA_CATALOGS`)
| Alias | Tabella IRSA | Nota |
|---|---|---|
| `spherex` | `spherex.obscore` | metadati osservazioni; colonne `s_ra`/`s_dec` standard ObsCore, da provare |

Nel progetto si usano solo le risorse della lista ufficiale della challenge (IRSA SPHEREx, Gaia DR3 via MAST).

## SPHEREx: cosa fornisce davvero IRSA (fonte: manuale ufficiale IRSA)
I dati SPHEREx sono soprattutto IMMAGINI spettrali (FITS multi-estensione), non cataloghi
di sorgenti pronti. Release correnti: DR1 e QR3 (QR2 non più ricercabile).
- Elenco immagini + data: tabelle TAP `spherex.artifact` e `spherex.plane`
  (query ufficiale in `build_spherex_images_adql`). `time_bounds_lower` = data di osservazione.
- Ritagli piccoli: si accoda `?center=RA,DECd&size=GRADI` all'URL dell'immagine. Il client
  accetta solo URL IRSA con `size` ≤ 0.2° e max 20 file per comando.
- Alternativa SIA2: `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr3&POS=circle+RA+DEC+RAGGIO`
  (collezioni: `spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`). Non implementata.
- Cloud AWS: IRSA mette i file anche su AWS (https://irsa.ipac.caltech.edu/cloud_access/#spherex);
  la colonna `cloud_access` della risposta SIA2 contiene il percorso. Non implementato: non serve
  per ritagli piccoli.
```bash
python -m src.api_client --spherex-images --ra 210.80227 --dec 54.34895 --size 0.1 --bandpass SPHEREx-D2
python -m src.api_client --spherex-images --ra 210.80227 --dec 54.34895 --download-cutouts 2
```
(Coordinate di M101, usate nel tutorial IRSA.) La query può richiedere circa 20 secondi.

Le query di cone search usano `ra`/`dec`; per le tabelle con nomi diversi (es. `spherex.obscore`)
la mappatura è in `config.IRSA_COORD_COLUMNS`.

## Chiavi e parametri
- IRSA TAP è pubblico: nessuna chiave. (Dati SPHEREx con accesso ristretto, se esistono: da verificare.)
- Variabili d'ambiente opzionali, mai nel codice o in git:
  - PowerShell: `$env:NASA_API_KEY = "la_tua_chiave"`
  - `IRSA_TAP_SYNC_URL` per cambiare endpoint.
- Parametri di query (CLI): `--ra`, `--dec` (gradi), `--radius` (arcsec), `--catalog`,
  `--columns`, `--max-rows`, `--name`, `--refresh`, `--out file.json|file.fits`.

## Limiti di sicurezza (config.py)
| Parametro | Valore | Significato |
|---|---|---|
| `API_MAX_RADIUS_ARCSEC` | 1800 | raggio massimo (0.5°) |
| `API_MAX_ROWS` | 1000 | righe massime per query |
| `API_MIN_INTERVAL_S` | 1.0 | pausa minima tra richieste |
| `API_MAX_RETRIES` | 3 | nuovi tentativi su errori transitori |
| `API_BACKOFF_BASE_S` | 2.0 | attesa = base × 2^tentativo (o `Retry-After`) |
| `API_TIMEOUT_S` | 60 | timeout per richiesta |

## Gestione errori
| Situazione | Comportamento |
|---|---|
| Timeout / rete assente | retry con backoff; poi cache come fallback (`stale=True`) o `ApiNetworkError` |
| HTTP 429 / 5xx | retry (rispetta `Retry-After`) |
| Altri HTTP 4xx o risposta XML | `ApiError` con il messaggio del server, nessun retry |
| Parametri fuori limite / nomi non sicuri | `ApiInputError` prima di contattare la rete |

## Cache e fallback
Ogni risposta è salvata in `data/api_cache/irsa_<hash>.json` (esclusa da git).
Stessa query = nessuna nuova richiesta, salvo `--refresh`. Con `--out` si salva anche
una copia in JSON o FITS (FITS richiede astropy).

## Uso nel sito
`web_server.py` usa `IrsaClient.spherex_images()` per l'elenco delle osservazioni che coprono una
posizione e `s3_cutout.py` per i ritagli. Le altre rotte (`/api/gaia*`, `/api/neossat*`) interrogano
MAST (Gaia DR3) e CADC (NEOSSat). Vedi `docs/ARCHITECTURE.md`.
