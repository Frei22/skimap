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
| IGN RGE ALTI (Géoplateforme WMS, raw float32) | 1 m | France | Licence Ouverte Etalab 2.0 |
| Your own PMTiles via `VITE_DEM_LAYERS` | as built | anywhere | as source |
| Mapzen Terrain Tiles (AWS Open Data) | ~25 m in Europe (EU-DEM), 30 m elsewhere | World | Free with attribution |

The global Mapzen tiles are served at up to zoom 14 but contain 25 m data interpolated upwards.
`resolution` in the config makes the app read them at their true resolution and upsample smoothly,
which avoids striped slope and snow shading. Steep Alpine faces in EU-DEM still have some
horizontal banding, which is in the data itself. A 1 m model fixes that.

## Pistes, lifts, huts

OpenStreetMap (ODbL), loaded per zoom-11 cell:

1. pre-baked `public/data/osm/11/x/y.json` (built by `npm run fetch-osm` and by the deploy
   workflow every week),
2. otherwise live from the public Overpass API (cached in the browser for a week).

Place, peak and lake names come from [OpenFreeMap](https://openfreemap.org) (OpenMapTiles schema).

## Making it better: what you can help with

### 1. Swedish 1 m elevation (biggest upgrade for Riksgränsen and Hemavan)

Lantmäteriet's **Markhöjdmodell Nedladdning, grid 1+** is open data (CC0), but downloading it needs
an account:

1. Create an account on [Geotorget](https://geotorget.lantmateriet.se) and order the free product
   "Markhöjdmodell Nedladdning, grid 1+". This gives you access keys for the STAC download API.
2. Download the tiles covering the two areas (about 15 × 15 km each) as GeoTIFFs, using the STAC API
   (`https://api.lantmateriet.se/stac-hojd/v1/`) or the QGIS "LM STAC downloader" plugin.
3. Build a tile archive (needs Python with `rasterio numpy pillow pmtiles`):
   ```bash
   python scripts/build-dem.py -o lapland.pmtiles --minzoom 10 --maxzoom 15 \
     --bbox 17.9 68.3 18.5 68.6 riksgransen/*.tif
   ```
   At 68°N a zoom-15 pixel is about 1.8 m, so `--maxzoom 15` keeps the 1 m detail. Expect roughly
   50–150 MB per area.
4. Upload it to a static host that supports range requests. Cloudflare R2 is free up to 10 GB
   with no download fees; GitHub Releases also works. Then set the repository variable
   `VITE_DEM_LAYERS` (Settings → Secrets and variables → Actions → Variables):
   ```json
   [{"name":"Lantmäteriet 1 m","url":"pmtiles://https://<your-bucket>/lapland.pmtiles",
     "encoding":"terrarium","minzoom":10,"maxzoom":15,"resolution":1,
     "bounds":[14.8,65.6,18.6,68.7],"attribution":"© Lantmäteriet"}]
   ```

The same script works for swissALTI3D (0.5 m) or any other GeoTIFF elevation model.

### 2. Swedish orthophotos

Lantmäteriet's orthophoto view service needs credentials, which must not be shipped in a public web
page. The usual fix is a tiny proxy (for example a free Cloudflare Worker) that adds the credentials
and serves XYZ tiles. Point `VITE_SE_ORTHO_URL` at it (an XYZ template with `{z}/{x}/{y}`) and it slots
in ahead of Esri for Sweden.

### 3. Snowline per region

`snowline` in `src/regions.ts` decides where the winter filter starts painting snow (750 m for
Chamonix, 0 m for Lapland). Tune it to the season look you prefer.

## Not verified from the build sandbox

The development sandbox could only reach AWS, so these endpoints are written to their published
specs but were not exercised against the live services. In testing, local copies stood in for them.
The app falls back gracefully if any of them misbehaves:

- IGN orthophoto WMTS and RGE ALTI WMS (`data.geopf.fr`)
- swisstopo WMTS, Esri World Imagery, OpenFreeMap, Overpass

If something looks off in a real browser, the browser console says which source failed.
