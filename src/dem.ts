// Elevation engine: fetches and decodes DEM tiles from the configured layers, merges a
// high-resolution regional DEM with the global one, and upsamples beyond native zoom.
// Shared by the 3D terrain, the slope overlay, the winter filter and point queries.
import { PMTiles } from 'pmtiles';
import { DEM_LAYERS, type DemEncoding, type DemLayer } from './config';
import { Lru, TILE, decodePixels, lat2tileY, lng2tileX, metersPerPixel, tileBounds } from './tiles';

export const DEM_MAXZOOM = Math.max(...DEM_LAYERS.map((l) => l.maxzoom));
const NODATA = -32768;

type Fetcher = (z: number, x: number, y: number, signal?: AbortSignal) => Promise<Blob | null>;

function makeFetcher(layer: DemLayer): Fetcher {
  if (layer.url.startsWith('pmtiles://')) {
    const archive = new PMTiles(layer.url.slice('pmtiles://'.length));
    return async (z, x, y, signal) => {
      const res = await archive.getZxy(z, x, y, signal);
      return res ? new Blob([res.data]) : null;
    };
  }
  return async (z, x, y, signal) => {
    const url = layer.url.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return res.blob();
  };
}

const layers = DEM_LAYERS.map((layer) => ({ layer, fetch: makeFetcher(layer) }));

function decode(px: Uint8ClampedArray, encoding: DemEncoding): Float32Array {
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    if (px[p + 3] === 0) {
      out[i] = NODATA;
      continue;
    }
    out[i] =
      encoding === 'terrarium'
        ? px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768
        : -10000 + (px[p] * 65536 + px[p + 1] * 256 + px[p + 2]) * 0.1;
    // Terrarium 0,0,0 is the agreed "no data" value in our build pipeline.
    if (encoding === 'terrarium' && px[p] === 0 && px[p + 1] === 0) out[i] = NODATA;
  }
  return out;
}

function intersects(layer: DemLayer, z: number, x: number, y: number) {
  if (!layer.bounds) return true;
  const b = tileBounds(z, x, y);
  const [w, s, e, n] = layer.bounds;
  return b.east > w && b.west < e && b.north > s && b.south < n;
}

/** Upsamples the 256² parent-region of `src` (tile at zoom pz) that covers tile (z,x,y). */
function crop(src: Float32Array, pz: number, z: number, x: number, y: number): Float32Array {
  const scale = 2 ** (z - pz);
  const ox = (x % scale) * (TILE / scale);
  const oy = (y % scale) * (TILE / scale);
  const out = new Float32Array(TILE * TILE);
  for (let j = 0; j < TILE; j++) {
    const sy = Math.min(Math.max(oy + (j + 0.5) / scale - 0.5, 0), TILE - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, TILE - 1);
    const fy = sy - y0;
    for (let i = 0; i < TILE; i++) {
      const sx = Math.min(Math.max(ox + (i + 0.5) / scale - 0.5, 0), TILE - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, TILE - 1);
      const fx = sx - x0;
      const a = src[y0 * TILE + x0], b = src[y0 * TILE + x1];
      const c = src[y1 * TILE + x0], d = src[y1 * TILE + x1];
      out[j * TILE + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

const cache = new Lru<string, Promise<Float32Array | null>>(400);

async function loadFromLayer(idx: number, z: number, x: number, y: number): Promise<Float32Array | null> {
  const { layer, fetch } = layers[idx];
  if (!intersects(layer, z, x, y) || z < layer.minzoom) return null;
  if (z > layer.maxzoom) {
    const pz = layer.maxzoom;
    const s = 2 ** (z - pz);
    const parent = await loadLayerTile(idx, pz, Math.floor(x / s), Math.floor(y / s));
    return parent && crop(parent, pz, z, x, y);
  }
  // A missing tile (404) is cached as null; network errors reject so the tile is retried later.
  const blob = await fetch(z, x, y);
  return blob && decode(await decodePixels(blob), layer.encoding);
}

function loadLayerTile(idx: number, z: number, x: number, y: number) {
  const key = `${idx}/${z}/${x}/${y}`;
  let p = cache.get(key);
  if (!p) {
    p = loadFromLayer(idx, z, x, y);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

const merged = new Lru<string, Promise<Float32Array | null>>(400);

/**
 * Elevation tile (256² metres, row-major) at any zoom ≤ DEM_MAXZOOM (higher zooms are upsampled).
 * Better layers win; their no-data holes are filled from the next layer down.
 */
export function getDemTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = merged.get(key);
  if (!p) {
    p = (async () => {
      let result: Float32Array | null = null;
      for (let i = 0; i < layers.length; i++) {
        let t: Float32Array | null;
        try {
          t = await loadLayerTile(i, z, x, y);
        } catch (e) {
          // A regional layer failing shouldn't hide the global one; the global one failing is an error.
          if (i === layers.length - 1 && !result) throw e;
          console.warn('DEM tile failed', layers[i].layer.name, z, x, y, e);
          continue;
        }
        if (!t) continue;
        if (!result) result = Float32Array.from(t);
        else for (let k = 0; k < result.length; k++) if (result[k] === NODATA) result[k] = t[k];
        if (!result.includes(NODATA)) break;
      }
      if (result) for (let k = 0; k < result.length; k++) if (result[k] === NODATA) result[k] = 0;
      return result;
    })();
    merged.set(key, p);
    p.catch(() => merged.delete(key));
  }
  return p;
}

/** Re-encodes a DEM tile as terrarium RGBA so MapLibre can use it for 3D terrain. */
export async function demTileAsTerrarium(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const t = await getDemTile(z, x, y);
  if (!t) return null;
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0, p = 0; i < t.length; i++, p += 4) {
    const v = t[i] + 32768;
    px[p] = Math.floor(v / 256);
    px[p + 1] = Math.floor(v) % 256;
    px[p + 2] = Math.floor((v - Math.floor(v)) * 256);
    px[p + 3] = 255;
  }
  const canvas = new OffscreenCanvas(TILE, TILE);
  canvas.getContext('2d')!.putImageData(new ImageData(px, TILE, TILE), 0, 0);
  return createImageBitmap(canvas);
}

/**
 * Elevation grid for tile (z,x,y) with a 1-pixel border on every side ((256+2)² samples),
 * so slope can be computed without seams. Uses DEM tiles at min(z, DEM_MAXZOOM).
 */
export async function demWindow(z: number, x: number, y: number): Promise<Float32Array | null> {
  const dz = Math.min(z, DEM_MAXZOOM);
  const scale = 2 ** (dz - z);
  const W = TILE + 2;
  // DEM-pixel coordinate range we need (pixel centres, with bilinear neighbours).
  const toDem = (g: number) => (g + 0.5) * scale - 0.5;
  const minD = toDem(x * TILE - 1), maxD = toDem((x + 1) * TILE) + 1;
  const minDy = toDem(y * TILE - 1), maxDy = toDem((y + 1) * TILE) + 1;
  const n = 2 ** dz;
  const tx0 = Math.max(0, Math.floor(minD / TILE)), tx1 = Math.min(n - 1, Math.floor(maxD / TILE));
  const ty0 = Math.max(0, Math.floor(minDy / TILE)), ty1 = Math.min(n - 1, Math.floor(maxDy / TILE));
  const tiles = new Map<string, Float32Array>();
  await Promise.all(
    [...Array((tx1 - tx0 + 1) * (ty1 - ty0 + 1)).keys()].map(async (k) => {
      const tx = tx0 + (k % (tx1 - tx0 + 1));
      const ty = ty0 + Math.floor(k / (tx1 - tx0 + 1));
      const t = await getDemTile(dz, tx, ty).catch(() => null);
      if (t) tiles.set(`${tx}/${ty}`, t);
    }),
  );
  const centre = tiles.get(`${Math.floor(x * scale)}/${Math.floor(y * scale)}`);
  if (!centre) return null;
  const cx = Math.floor(x * scale) * TILE, cy = Math.floor(y * scale) * TILE;

  const at = (gx: number, gy: number) => {
    gx = Math.max(0, Math.min(n * TILE - 1, gx));
    gy = Math.max(0, Math.min(n * TILE - 1, gy));
    const t = tiles.get(`${Math.floor(gx / TILE)}/${Math.floor(gy / TILE)}`);
    if (t) return t[(gy % TILE) * TILE + (gx % TILE)];
    // Neighbour missing: clamp into the centre tile.
    const lx = Math.max(0, Math.min(TILE - 1, gx - cx)), ly = Math.max(0, Math.min(TILE - 1, gy - cy));
    return centre[ly * TILE + lx];
  };

  const out = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    const dy = toDem(y * TILE + j - 1);
    const y0 = Math.floor(dy), fy = dy - y0;
    for (let i = 0; i < W; i++) {
      const dx = toDem(x * TILE + i - 1);
      const x0 = Math.floor(dx), fx = dx - x0;
      if (scale === 1) {
        out[j * W + i] = at(x0, y0);
        continue;
      }
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      out[j * W + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

export type Terrain = { elevation: Float32Array; slope: Float32Array; aspect: Float32Array; shade: Float32Array };

/** Sun used for the winter filter's snow shading: low early-afternoon winter sun from the south-south-west. */
const SUN_AZ = (205 * Math.PI) / 180;
export const SUN_ALT = (32 * Math.PI) / 180;

/**
 * Per-pixel elevation (m), slope (deg), aspect (deg, 0 = north, clockwise) and a 0..1
 * sun illumination for tile (z,x,y), using Horn's 3×3 gradient.
 */
export async function terrainForTile(z: number, x: number, y: number, withShade = false): Promise<Terrain | null> {
  const win = await demWindow(z, x, y);
  if (!win) return null;
  const W = TILE + 2;
  const elevation = new Float32Array(TILE * TILE);
  const slope = new Float32Array(TILE * TILE);
  const aspect = new Float32Array(TILE * TILE);
  const shade = new Float32Array(withShade ? TILE * TILE : 0);
  const sinAlt = Math.sin(SUN_ALT), cosAlt = Math.cos(SUN_ALT);
  for (let j = 0; j < TILE; j++) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (j + 0.5) / TILE)) / 2 ** z))) * 180) / Math.PI;
    const cell = metersPerPixel(z, lat);
    for (let i = 0; i < TILE; i++) {
      const r0 = j * W + i, r1 = r0 + W, r2 = r1 + W;
      const a = win[r0], b = win[r0 + 1], c = win[r0 + 2];
      const d = win[r1], e = win[r1 + 1], f = win[r1 + 2];
      const g = win[r2], h = win[r2 + 1], k = win[r2 + 2];
      const dzdx = (c + 2 * f + k - (a + 2 * d + g)) / (8 * cell); // + towards east
      const dzdy = (g + 2 * h + k - (a + 2 * b + c)) / (8 * cell); // + towards south
      const grad = Math.hypot(dzdx, dzdy);
      const o = j * TILE + i;
      elevation[o] = e;
      const s = Math.atan(grad);
      slope[o] = (s * 180) / Math.PI;
      // Downslope direction: towards decreasing elevation.
      aspect[o] = ((Math.atan2(-dzdx, dzdy) * 180) / Math.PI + 360) % 360; // 0 = north, clockwise
      if (withShade) {
        // Lambert shading: surface normal (-dzdx, dzdy, 1) in an east/north/up frame.
        const nx = -dzdx, ny = dzdy, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        const lx = Math.sin(SUN_AZ) * cosAlt, ly = Math.cos(SUN_AZ) * cosAlt, lz = sinAlt;
        shade[o] = Math.max(0, (nx * lx + ny * ly + nz * lz) / len);
      }
    }
  }
  return { elevation, slope, aspect, shade };
}

/** Bilinear elevation at a coordinate, using the best available DEM. */
export async function elevationAt(lng: number, lat: number, z = DEM_MAXZOOM): Promise<number | null> {
  const fx = lng2tileX(lng, z), fy = lat2tileY(lat, z);
  const tx = Math.floor(fx), ty = Math.floor(fy);
  const t = await getDemTile(z, tx, ty);
  if (!t) return null;
  const px = Math.min(Math.max((fx - tx) * TILE - 0.5, 0), TILE - 1.001);
  const py = Math.min(Math.max((fy - ty) * TILE - 0.5, 0), TILE - 1.001);
  const x0 = Math.floor(px), y0 = Math.floor(py), ax = px - x0, ay = py - y0;
  const v = (i: number, j: number) => t[j * TILE + i];
  return (v(x0, y0) * (1 - ax) + v(x0 + 1, y0) * ax) * (1 - ay) + (v(x0, y0 + 1) * (1 - ax) + v(x0 + 1, y0 + 1) * ax) * ay;
}

/** Slope (deg) and aspect (deg) at a point, from elevations ~1 DEM pixel apart. */
export async function slopeAt(lng: number, lat: number) {
  const d = Math.max(metersPerPixel(DEM_MAXZOOM, lat), 5);
  const dLat = d / 111320, dLng = d / (111320 * Math.cos((lat * Math.PI) / 180));
  const [n, s, e, w, c] = await Promise.all([
    elevationAt(lng, lat + dLat), elevationAt(lng, lat - dLat),
    elevationAt(lng + dLng, lat), elevationAt(lng - dLng, lat), elevationAt(lng, lat),
  ]);
  if ([n, s, e, w, c].some((v) => v === null)) return null;
  const dzdx = (e! - w!) / (2 * d), dzdy = (n! - s!) / (2 * d);
  const slope = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  const aspect = ((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI + 360) % 360;
  return { elevation: c!, slope, aspect };
}
