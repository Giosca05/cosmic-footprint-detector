# Architecture

```
browser (public/)                          server (src/web_server.py)                public services
explore.html + js/*   --- /api/... --->   IRSA client, S3 range cutouts   --->   IRSA (TAP, SIA2), AWS S3
 - fits/wcs/align/detect/drift (client)    Gaia TAP proxy (MAST)           --->   MAST Gaia DR3
 - explorer.js: UI, PING, contacts         NEOSSat search + plate solve     --->   CADC (TAP + files)
 - report.js: printable report             disk cache in data/
```

- **Client**: all image processing (alignment, blink, motion detection) runs in the browser,
  in workers (`build-worker.js`, `track-worker.js`).
- **Server**: no database. It proxies public services (CORS), fetches cutouts quickly and caches.
- **NEOSSat** (`src/neossat.py`): reads the FITS, finds stars, matches them to Gaia (translation
  voting + similarity fit, target excluded) and returns where the predicted position falls.
- **Texts**: `public/js/i18n.js` (EN + IT, same keys).
- **Missions** (starting targets): `public/data/missions.json`.

## Limits
Proper motions and positions are checked against Gaia DR3 epoch 2016.0. Scores are heuristics,
not probabilities; candidates always need external confirmation.
