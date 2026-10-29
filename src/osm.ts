// Ski pistes, ski-touring routes, lifts and huts from OpenStreetMap, loaded per z11 grid cell.
// Cells are served pre-baked from /data/osm/11/x/y.json when available (scripts/fetch-osm.mjs),
// otherwise fetched live from Overpass and kept in the browser's Cache Storage for a week.
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { OVERPASS_ENDPOINTS } from './config';
import { lat2tileY, lng2tileX, tileBounds } from './tiles';

export const CELL_ZOOM = 11;
const CACHE_NAME = 'skimap-osm-v1';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

type OsmGeom = { lat: number; lon: number }[];
type OsmElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OsmGeom;
  members?: { type: string; role: string; geometry?: OsmGeom }[];
};

export const overpassQuery = (s: number, w: number, n: number, e: number) => `
[out:json][timeout:180];
(
  way["piste:type"](${s},${w},${n},${e});
  relation["piste:type"](${s},${w},${n},${e});
  way["aerialway"](${s},${w},${n},${e});
  node["tourism"~"^(alpine_hut|wilderness_hut)$"](${s},${w},${n},${e});
  node["aerialway"="station"](${s},${w},${n},${e});
);
out geom;`;

const SKIP_LIFTS = new Set(['pylon', 'goods', 'zip_line', 'station', 'yes']);

const line = (g: OsmGeom): Position[] => g.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]);

/** Overpass JSON → slim GeoJSON features with the properties the map styles use. */
export function osmToFeatures(elements: OsmElement[]): Feature[] {
  const out: Feature[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (t['disused'] === 'yes' || t['abandoned'] === 'yes' || t['piste:abandoned'] === 'yes') continue;
    const id = `${el.type[0]}${el.id}`;
    const name = t['piste:name'] || t['name'] || t['piste:ref'] || t['ref'] || '';
    let props: Record<string, string | number> | null = null;
    if (t['piste:type']) {
      props = {
        kind: 'piste',
        piste: t['piste:type'],
        difficulty: t['piste:difficulty'] || 'unknown',
        grooming: t['piste:grooming'] || '',
        name,
      };
    } else if (t['aerialway'] && el.type === 'way' && !SKIP_LIFTS.has(t['aerialway'])) {
      props = { kind: 'lift', lift: t['aerialway'], name };
    } else if (el.type === 'node' && t['aerialway'] === 'station') {
      props = { kind: 'station', name };
    } else if (el.type === 'node' && t['tourism']) {
      props = { kind: 'hut', hut: t['tourism'], name, ele: t['ele'] ?? '' };
    }
    if (!props) continue;

    let geometry: Geometry | null = null;
    if (el.type === 'node') geometry = { type: 'Point', coordinates: [el.lon!, el.lat!] };
    else if (el.type === 'way' && el.geometry && el.geometry.length > 1) {
      const coords = line(el.geometry);
      const closed = coords.length > 3 && coords[0][0] === coords.at(-1)![0] && coords[0][1] === coords.at(-1)![1];
      geometry = closed && t['area'] === 'yes' ? { type: 'Polygon', coordinates: [coords] } : { type: 'LineString', coordinates: coords };
    } else if (el.type === 'relation' && el.members) {
      const lines = el.members.filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1).map((m) => line(m.geometry!));
      if (t['type'] === 'multipolygon' || t['area'] === 'yes') {
        const outers = el.members.filter((m) => m.role === 'outer' && m.geometry).map((m) => line(m.geometry!));
        if (outers.length) geometry = { type: 'MultiPolygon', coordinates: outers.filter((r) => r.length > 3).map((r) => [r]) };
      } else if (lines.length) geometry = { type: 'MultiLineString', coordinates: lines };
    }
    if (!geometry) continue;
    out.push({ type: 'Feature', id, properties: { ...props, osm: id }, geometry });
  }
  return out;
}

async function fromOverpass(z: number, x: number, y: number, signal?: AbortSignal): Promise<Feature[]> {
  const b = tileBounds(z, x, y);
  const body = 'data=' + encodeURIComponent(overpassQuery(b.south, b.west, b.north, b.east));
  let lastErr: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: signal ?? AbortSignal.timeout(60_000), // a stalled server shouldn't leave the spinner up forever
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      return osmToFeatures(json.elements);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

async function loadCell(x: number, y: number, signal?: AbortSignal): Promise<Feature[]> {
  const path = `${import.meta.env.BASE_URL}data/osm/${CELL_ZOOM}/${x}/${y}.json`;
  try {
    const res = await fetch(path, { signal });
    if (res.ok && res.headers.get('content-type')?.includes('json')) return ((await res.json()) as FeatureCollection).features;
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  const cacheKey = `https://skimap.local/osm/${CELL_ZOOM}/${x}/${y}`;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(cacheKey);
    if (hit && Date.now() - Number(hit.headers.get('x-fetched') ?? 0) < MAX_AGE_MS) return hit.json();
  } catch {
    /* Cache Storage unavailable (private mode, insecure origin) — just fetch. */
  }
  const features = await fromOverpass(CELL_ZOOM, x, y, signal);
  await cache?.put(cacheKey, new Response(JSON.stringify(features), { headers: { 'x-fetched': `${Date.now()}` } })).catch(() => {});
  return features;
}

/** Keeps a merged, de-duplicated FeatureCollection of every cell loaded so far. */
export class OsmStore {
  private features = new Map<string, Feature>();
  private cells = new Map<string, Promise<void>>();
  private failedAt = new Map<string, number>();
  private pending = 0;
  constructor(
    private onChange: (fc: FeatureCollection) => void,
    private onLoading: (busy: boolean, error?: string) => void,
  ) {}

  /** Loads every z11 cell overlapping the bounds (at most `limit`, nearest the centre first). */
  ensure(west: number, south: number, east: number, north: number, limit = 6) {
    const x0 = Math.floor(lng2tileX(west, CELL_ZOOM)), x1 = Math.floor(lng2tileX(east, CELL_ZOOM));
    const y0 = Math.floor(lat2tileY(north, CELL_ZOOM)), y1 = Math.floor(lat2tileY(south, CELL_ZOOM));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const wanted: [number, number][] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) wanted.push([x, y]);
    wanted.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const [x, y] of wanted.slice(0, limit)) this.load(x, y);
  }

  private load(x: number, y: number) {
    const key = `${x}/${y}`;
    if (this.cells.has(key) || Date.now() - (this.failedAt.get(key) ?? 0) < 60_000) return;
    this.pending++;
    this.onLoading(true);
    const p = loadCell(x, y)
      .then((fs) => {
        for (const f of fs) this.features.set(f.id as string, f);
        this.onChange({ type: 'FeatureCollection', features: [...this.features.values()] });
        this.pending--;
        this.onLoading(this.pending > 0);
      })
      .catch((e) => {
        this.cells.delete(key); // allow a retry after a minute
        this.failedAt.set(key, Date.now());
        this.pending--;
        this.onLoading(this.pending > 0, `Couldn't load pistes (${(e as Error).message}). Will retry.`);
      });
    this.cells.set(key, p);
  }
}
