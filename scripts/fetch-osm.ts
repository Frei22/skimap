// Pre-bakes pistes, lifts and huts for every region into public/data/osm/11/x/y.json, so visitors
// don't depend on the (rate-limited) public Overpass API. Run: npm run fetch-osm [-- regionId ...]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERPASS_ENDPOINTS } from '../src/config';
import type { Feature } from 'geojson';
import { CELL_ZOOM, osmToFeatures, overpassQuery } from '../src/osm';
import { REGIONS } from '../src/regions';
import { lat2tileY, lng2tileX, tileBounds } from '../src/tiles';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'osm', `${CELL_ZOOM}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string) {
  const attempts = Number(process.env.OVERPASS_ATTEMPTS ?? 3);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'skimap-prefetch/1.0' },
        signal: AbortSignal.timeout(Number(process.env.OVERPASS_TIMEOUT_S ?? 170) * 1000), // a stalled server must not hang the deploy
      });
      if (res.ok) return (await res.json()) as { elements: Parameters<typeof osmToFeatures>[0] };
      console.warn(`  ${url} → ${res.status}`);
    } catch (e) {
      console.warn(`  ${url} → ${(e as Error).message}`);
    }
    if (attempt < attempts - 1) await sleep(5000 * (attempt + 1));
  }
  throw new Error('All Overpass endpoints failed');
}

/** [west, south, east, north] of a feature's geometry. */
function featureBbox(f: Feature): [number, number, number, number] {
  let w = 180, so = 90, e = -180, n = -90;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === 'number') {
      const [x, y] = c as number[];
      w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y);
    } else (c as unknown[]).forEach(visit);
  };
  visit((f.geometry as { coordinates: unknown }).coordinates);
  return [w, so, e, n];
}

const wanted = process.argv.slice(2);
const regions = wanted.length ? REGIONS.filter((r) => wanted.includes(r.id)) : REGIONS;
let failed = 0;
// One query per region (a few requests, not one per cell: the public servers are much happier),
// then split into the z11 cells the app loads. Empty cells are written too, so the app doesn't
// ask Overpass about them either.
for (const r of regions) {
  const [w, s, e, n] = r.bbox;
  const x0 = Math.floor(lng2tileX(w, CELL_ZOOM)), x1 = Math.floor(lng2tileX(e, CELL_ZOOM));
  const y0 = Math.floor(lat2tileY(n, CELL_ZOOM)), y1 = Math.floor(lat2tileY(s, CELL_ZOOM));
  const nw = tileBounds(CELL_ZOOM, x0, y0), se = tileBounds(CELL_ZOOM, x1, y1);
  console.log(`${r.name}: ${(x1 - x0 + 1) * (y1 - y0 + 1)} cells`);
  let features: Feature[];
  try {
    features = osmToFeatures((await overpass(overpassQuery(se.south, nw.west, nw.north, se.east))).elements);
  } catch (err) {
    failed++;
    console.error(`  ${(err as Error).message} (the app will fetch this region live)`);
    continue;
  }
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const b = tileBounds(CELL_ZOOM, x, y);
      const inCell = features.filter((f) => {
        const [fw, fs, fe, fn] = featureBbox(f);
        return fe >= b.west && fw <= b.east && fn >= b.south && fs <= b.north;
      });
      const file = join(OUT, `${x}`, `${y}.json`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: 'FeatureCollection', features: inCell }));
    }
  }
  console.log(`  ${features.length} features`);
  await sleep(5000); // be polite to the public Overpass servers
}
// Partial results are still useful (missing regions load live), so only a total failure is an error.
process.exit(regions.length > 0 && failed === regions.length ? 1 : 0);
