# Data sources

Everything below is free to use with attribution. The app credits each source in the map's (i) box.

## Imagery

Each tile goes through the providers in order (`IMAGERY` in `src/config.ts`). The first one with
real pixels wins, and its gaps are filled from the next.

| Provider | Resolution | Coverage | Licence |
| --- | --- | --- | --- |
| IGN BD ORTHO (Géoplateforme WMTS) | 20 cm | France | Licence Ouverte Etalab 2.0 |
| swisstopo SWISSIMAGE | 10 cm | Switzerland | swisstopo OGD, free with attribution |
| Lantmäteriet Ortofoto (optional, see below) | 16–25 cm | Sweden | Open data, needs a Geotorget account |
| Esri World Imagery | ~30–60 cm in Europe | World | Esri terms: free for non-commercial use with attribution |

The Chamonix valley straddles France, Switzerland and Italy. The French and Swiss sides get national
imagery; the Italian side (Courmayeur) falls back to Esri.

**Esri caveat:** Esri's terms allow free non-commercial use with attribution. If Skimap ever becomes
commercial or high-traffic, switch to an Esri developer account (generous free tier) or drop Esri
outside the national sources.

## Elevation

`DEM_LAYERS` in `src/config.ts`, best first. Each tile uses the best layer that has data and fills
holes from the next.

| Layer | Resolution | Coverage | Licence |
| --- | --- | --- | --- |
| IGN LiDAR HD terrain model, RGE ALTI where not yet flown (Géoplateforme WMS, raw float32) | ~1 m | France | Licence Ouverte Etalab 2.0 |
| Your own PMTiles via `VITE_DEM_LAYERS` | as built | anywhere | as source |
| Mapzen Terrain Tiles (AWS Open Data) | ~25 m in Europe (EU-DEM), 30 m elsewhere | World | Free with attribution |

IGN's service stores the elevation on a lat/lon grid and resamples anything else with
nearest-neighbour, which duplicates every third row in Web Mercator and stripes the slopes. The app
therefore asks for the native lat/lon pixels (`grid: 'geographic'`) and reprojects them in the
browser with a cubic. The whole French side of the Mont Blanc massif is covered by LiDAR HD.

The global Mapzen tiles are served at up to zoom 14 but contain 25 m data interpolated upwards.
`resolution` in the config makes the app read them at their true resolution and upsample smoothly,
which avoids striped slope and snow shading. Steep Alpine faces in EU-DEM still have some
horizontal banding, which is in the data itself. A 1 m model fixes that.

## How much detail you get (Chamonix)

| Zoom | Ground per screen pixel* | Imagery | Elevation (relief, slope colours) |
| --- | --- | --- | --- |
| 14 | 6.6 m | IGN, downsampled | LiDAR, downsampled |
| 16 | 1.7 m | IGN, downsampled | LiDAR, native |
| 17 | 0.8 m | IGN, downsampled | LiDAR, native (~0.8 m × 1.2 m) |
| 18 | 0.4 m | **IGN 20 cm, 1:1 on a retina screen** | LiDAR, smoothly upsampled |
| 19+ | ≤ 0.2 m | IGN, enlarged | LiDAR, smoothly upsampled |

\* at 2× pixel density with "Sharp imagery" on (the default on retina screens).

- **Imagery** is the limit past zoom 18. IGN's 20 cm photos are the sharpest free aerial imagery
  for the Alps. The 10 cm swisstopo imagery covers the Swiss side.
- **Slope colours** are computed over a ~3 m baseline. That's the scale of a crux or a step in a
  couloir, and it averages out the row pattern between IGN's lat/lon grid and the map's pixels.
- **Winter filter**: forest and alpine meadow are equally dark in summer photos. They are told
  apart by canopy texture (local contrast over ~5 m: conifers ~0.13–0.16, meadow ~0.03), with
  forest density over ~15 m deciding how generous the crown test is. Crowns stay dark, gaps and
  meadows fill with snow, and rock outcrops above the treeline keep a dusting.

## Pistes, lifts, huts

OpenStreetMap (ODbL), loaded per zoom-11 cell:

1. pre-baked `public/data/osm/11/x/y.json` (built by `npm run fetch-osm` and by the deploy
   workflow every week),
2. otherwise live from the public Overpass API (cached in the browser for a week).

Place, peak and lake names come from [OpenFreeMap](https://openfreemap.org) (OpenMapTiles schema).

## Making it better: what you can help with

### 1. Swedish 1 m elevation (biggest upgrade for Riksgränsen and Hemavan)

Lantmäteriet's **Markhöjdmodell Nedladdning, grid 1+** is free (CC BY 4.0), but downloading needs a
Geotorget account with the product ordered. The deploy workflow does the rest:

1. On [Geotorget](https://geotorget.lantmateriet.se), order "Markhöjdmodell Nedladdning" (free).
2. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**, add
   `LANTMATERIET_USER` and `LANTMATERIET_PASSWORD` (your Geotorget login).
3. Run the **Deploy** workflow (Actions tab → Deploy → Run workflow).

The workflow searches the STAC-hojd catalogue for the areas in `SWEDISH_DEM_AREAS`
(`.github/workflows/deploy.yml`), downloads the 10 × 10 km GeoTIFFs, builds one PMTiles archive
per area with `scripts/build-dem.py` (zoom 15 ≈ 1.8 m at 68°N), and serves them with the site. The
result is cached, so later deploys reuse it. To add an area, add a line to `SWEDISH_DEM_AREAS`.

To do it by hand instead:

```bash
export LANTMATERIET_USER=... LANTMATERIET_PASSWORD=...
python scripts/fetch-lantmateriet.py --bbox 17.95 68.35 18.38 68.51 --out dem-src/riksgransen
python scripts/build-dem.py -o riksgransen.pmtiles --minzoom 10 --maxzoom 15 \
  --bbox 17.95 68.35 18.38 68.51 dem-src/riksgransen/*.tif
```

and point `VITE_DEM_LAYERS` at the file (any static host with range requests, for example
Cloudflare R2):

```json
[{"name":"Lantmäteriet 1 m","url":"pmtiles://https://<host>/riksgransen.pmtiles","encoding":"terrarium",
  "minzoom":10,"maxzoom":15,"resolution":1,"bounds":[17.95,68.35,18.38,68.51],"attribution":"© Lantmäteriet"}]
```

The same build script works for swissALTI3D (0.5 m) or any other GeoTIFF elevation model.

### 2. Swedish orthophotos

Lantmäteriet's orthophoto view service needs credentials, which must not be shipped in a public web
page. The usual fix is a tiny proxy (for example a free Cloudflare Worker) that adds the credentials
and serves XYZ tiles. Point `VITE_SE_ORTHO_URL` at it (an XYZ template with `{z}/{x}/{y}`) and it slots
in ahead of Esri for Sweden.

### 3. Snowline per region

`snowline` in `src/regions.ts` decides where the winter filter starts painting snow (750 m for
Chamonix, 0 m for Lapland). Tune it to the season look you prefer.

## What has been tested live

Checked against the live services from the build sandbox: IGN orthophotos and LiDAR HD elevation,
swisstopo, Esri World Imagery, OpenFreeMap labels and fonts, and the Mapzen terrain tiles (all
CORS-enabled). Not yet exercised: the public Overpass servers (unreachable from the sandbox; the
deploy workflow pre-bakes pistes from GitHub's servers instead) and the Lantmäteriet download
(needs your Geotorget login; the workflow log shows exactly what happened on the first run).

If something looks off in a real browser, the browser console says which source failed.
