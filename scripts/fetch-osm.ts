// Pre-bakes pistes, lifts and huts for every region into public/data/osm/11/x/y.json, so visitors
// don't depend on the (rate-limited) public Overpass API. Run: npm run fetch-osm [-- regionId ...]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERPASS_ENDPOINTS } from '../src/config';
import { CELL_ZOOM, osmToFeatures, overpassQuery } from '../src/osm';
import { REGIONS } from '../src/regions';
import { lat2tileY, lng2tileX, tileBounds } from '../src/tiles';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'osm', `${CELL_ZOOM}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string) {
  const attempts = Number(process.env.OVERPASS_ATTEMPTS ?? 4);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'skimap-prefetch/1.0' },
        signal: AbortSignal.timeout(100_000), // a stalled server must not hang the deploy
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

const wanted = process.argv.slice(2);
const regions = wanted.length ? REGIONS.filter((r) => wanted.includes(r.id)) : REGIONS;
let failed = 0;
let total = 0;
for (const r of regions) {
  const [w, s, e, n] = r.bbox;
  const x0 = Math.floor(lng2tileX(w, CELL_ZOOM)), x1 = Math.floor(lng2tileX(e, CELL_ZOOM));
  const y0 = Math.floor(lat2tileY(n, CELL_ZOOM)), y1 = Math.floor(lat2tileY(s, CELL_ZOOM));
  console.log(`${r.name}: ${(x1 - x0 + 1) * (y1 - y0 + 1)} cells`);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const b = tileBounds(CELL_ZOOM, x, y);
      total++;
      try {
        const { elements } = await overpass(overpassQuery(b.south, b.west, b.north, b.east));
        const features = osmToFeatures(elements);
        const file = join(OUT, `${x}`, `${y}.json`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ type: 'FeatureCollection', features }));
        console.log(`  ${x}/${y}: ${features.length} features`);
      } catch (e) {
        failed++;
        console.error(`  ${x}/${y}: ${(e as Error).message} (the app will fetch this cell live)`);
      }
      await sleep(1500); // be polite to the public Overpass servers
    }
  }
}
// Partial results are still useful (missing cells load live), so only a total failure is an error.
process.exit(total > 0 && failed === total ? 1 : 0);
