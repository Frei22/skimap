// Elevation engine: fetches and decodes DEM tiles from the configured layers, merges a
// high-resolution regional DEM with the global one, and upsamples beyond native zoom.
// Shared by the 3D terrain, the slope overlay, the winter filter and point queries.
import { PMTiles } from 'pmtiles';
import { DEM_LAYERS, DEM_MAXZOOM, type DemEncoding, type DemLayer } from './config';
import { Lru, TILE, decodePixels, lat2tileY, lng2tileX, metersPerPixel, tile2lat, tileBounds } from './tiles';

const NODATA = -32768;

type Fetcher = (z: number, x: number, y: number, signal?: AbortSignal) => Promise<Float32Array | null>;

const pick = (url: string | string[], x: number, y: number) => (Array.isArray(url) ? url[(x + y) % url.length] : url);

export function fillTemplate(template: string, z: number, x: number, y: number) {
  const b = tileBounds(z, x, y);
  const R = 6378137;
  const mx = (lng: number) => ((R * lng * Math.PI) / 180).toFixed(2);
  const my = (lat: number) => (R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))).toFixed(2);
  return template
    .replace('{z}', `${z}`)
    .replace('{x}', `${x}`)
    .replace('{y}', `${y}`)
    .replace('{bbox-epsg-3857}', `${mx(b.west)},${my(b.south)},${mx(b.east)},${my(b.north)}`);
}

function makeFetcher(layer: DemLayer): Fetcher {
  const url0 = pick(layer.url, 0, 0);
  if (url0.startsWith('pmtiles://')) {
    const archive = new PMTiles(url0.slice('pmtiles://'.length));
    return async (z, x, y, signal) => {
      const res = await archive.getZxy(z, x, y, signal);
      if (!res) return null;
      if (layer.encoding === 'bil32') return decodeBil(res.data);
      return decode(await decodePixels(new Blob([res.data])), layer.encoding);
    };
  }
  return async (z, x, y, signal) => {
    const res = await fetch(fillTemplate(pick(layer.url, x, y), z, x, y), { signal });
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`DEM ${res.status}`);
    if (layer.encoding === 'bil32') return decodeBil(await res.arrayBuffer());
    return decode(await decodePixels(await res.blob()), layer.encoding);
  };
}

/**
 * Raw float32 grid (IGN's WMS `image/x-bil;bits=32`). Anything that doesn't look like a sane
 * 256² elevation grid (an XML error page, wrong size, garbage values) is rejected.
 */
function decodeBil(buf: ArrayBuffer): Float32Array {
  if (buf.byteLength !== TILE * TILE * 4) throw new Error(`BIL size ${buf.byteLength}`);
  const v = new Float32Array(buf);
  let bad = 0;
  for (let i = 0; i < v.length; i++) {
    const h = v[i];
    if (!(h > -1000)) v[i] = NODATA; // IGN no-data is -99999
    else if (h > 9000) bad++;
  }
  if (bad > v.length * 0.01) throw new Error('BIL values out of range');
  return v;
}

function decode(px: Uint8ClampedArray, encoding: Exclude<DemEncoding, 'bil32'>): Float32Array {
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    if (px[p + 3] === 0 || (encoding === 'terrarium' && px[p] === 0 && px[p + 1] === 0)) {
      out[i] = NODATA; // transparent, or terrarium 0,0,x: "no data" in our build pipeline
      continue;
    }
    out[i] =
      encoding === 'terrarium'
        ? px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768
        : -10000 + (px[p] * 65536 + px[p + 1] * 256 + px[p + 2]) * 0.1;
  }
  return out;
}

/** Stops asking a layer that keeps failing (CORS, outage) for the rest of the session. */
const failures = new Map<DemLayer, number>();
const MAX_FAILURES = 6;

const layers = DEM_LAYERS.map((layer) => ({ layer, fetch: makeFetcher(layer) }));

function intersects(layer: DemLayer, z: number, x: number, y: number) {
  if (!layer.bounds) return true;
  const b = tileBounds(z, x, y);
  const [w, s, e, n] = layer.bounds;
  return b.east > w && b.west < e && b.north > s && b.south < n;
}

/** Catmull-Rom spline through p0..p3, evaluated between p1 (t=0) and p2 (t=1). */
function cubic(p0: number, p1: number, p2: number, p3: number, t: number) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/**
 * Bicubic sample of a grid accessor at fractional pixel position (fx, fy). Unlike bilinear
 * interpolation this keeps slopes continuous, so upsampled terrain shades smoothly instead of
 * showing the source grid as a faint checkerboard.
 */
function bicubic(at: (i: number, j: number) => number, fx: number, fy: number) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const row = (j: number) => cubic(at(x0 - 1, j), at(x0, j), at(x0 + 1, j), at(x0 + 2, j), tx);
  return cubic(row(y0 - 1), row(y0), row(y0 + 1), row(y0 + 2), ty);
}

/**
 * Resamples tiles of zoom `sz` (≤ z) onto the pixel grid of tile (z,x,y), with `border` extra
 * pixels on each side. Neighbouring source tiles are read as needed so there are no seams;
 * upsampling is bicubic. Returns null when the source has no tile under (z,x,y) itself.
 */
async function resample(
  source: (tx: number, ty: number) => Promise<Float32Array | null>,
  sz: number, z: number, x: number, y: number, border: number,
): Promise<Float32Array | null> {
  const scale = 2 ** (sz - z);
  const W = TILE + 2 * border;
  const toSrc = (g: number) => (g + 0.5) * scale - 0.5; // our pixel centre → source pixel coordinate
  const pad = scale === 1 ? 0 : 2; // bicubic needs two neighbours on each side
  const n = 2 ** sz;
  const tx0 = Math.max(0, Math.floor((toSrc(x * TILE - border) - pad) / TILE));
  const tx1 = Math.min(n - 1, Math.floor((toSrc((x + 1) * TILE - 1 + border) + pad) / TILE));
  const ty0 = Math.max(0, Math.floor((toSrc(y * TILE - border) - pad) / TILE));
  const ty1 = Math.min(n - 1, Math.floor((toSrc((y + 1) * TILE - 1 + border) + pad) / TILE));
  const tiles = new Map<number, Float32Array>();
  const key = (tx: number, ty: number) => ty * n + tx;
  const cx = Math.floor(x * scale), cy = Math.floor(y * scale);
  await Promise.all(
    [...Array((tx1 - tx0 + 1) * (ty1 - ty0 + 1)).keys()].map(async (k) => {
      const tx = tx0 + (k % (tx1 - tx0 + 1));
      const ty = ty0 + Math.floor(k / (tx1 - tx0 + 1));
      // Only the centre tile is required; a failing neighbour just clamps the edge.
      const t = await (tx === cx && ty === cy ? source(tx, ty) : source(tx, ty).catch(() => null));
      if (t) tiles.set(key(tx, ty), t);
    }),
  );
  const centre = tiles.get(key(cx, cy));
  if (!centre) return null;

  const at = (gx: number, gy: number) => {
    gx = Math.max(0, Math.min(n * TILE - 1, gx));
    gy = Math.max(0, Math.min(n * TILE - 1, gy));
    const t = tiles.get(key(Math.floor(gx / TILE), Math.floor(gy / TILE)));
    if (t) return t[(gy % TILE) * TILE + (gx % TILE)];
    const lx = Math.max(0, Math.min(TILE - 1, gx - cx * TILE)), ly = Math.max(0, Math.min(TILE - 1, gy - cy * TILE));
    return centre[ly * TILE + lx];
  };

  const out = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    const sy = toSrc(y * TILE + j - border);
    for (let i = 0; i < W; i++) {
      const sx = toSrc(x * TILE + i - border);
      out[j * W + i] = scale === 1 ? at(sx, sy) : bicubic(at, sx, sy);
    }
  }
  return out;
}

// ~256 KB per tile; two caches of 96 keep each worker around 50 MB.
const cache = new Lru<string, Promise<Float32Array | null>>(96);

/** Zoom at which a layer's tiles carry its full detail at this location (see DemLayer.resolution). */
function layerNativeZoom(layer: DemLayer, z: number, y: number) {
  if (!layer.resolution) return layer.maxzoom;
  const lat = tile2lat(y + 0.5, z);
  const nz = Math.round(Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / layer.resolution));
  return Math.max(layer.minzoom, Math.min(layer.maxzoom, nz));
}

async function loadFromLayer(idx: number, z: number, x: number, y: number): Promise<Float32Array | null> {
  const { layer, fetch } = layers[idx];
  if (!intersects(layer, z, x, y) || z < layer.minzoom) return null;
  const native = layerNativeZoom(layer, z, y);
  if (z > native) return resample((tx, ty) => loadLayerTile(idx, native, tx, ty), native, z, x, y, 0);
  if ((failures.get(layer) ?? 0) >= MAX_FAILURES && idx < layers.length - 1) return null;
  // A missing tile (404) is cached as null; other errors reject so the tile is retried later.
  try {
    const t = await fetch(z, x, y);
    failures.set(layer, 0);
    return t;
  } catch (e) {
    const n = (failures.get(layer) ?? 0) + 1;
    failures.set(layer, n);
    if (n === MAX_FAILURES && idx < layers.length - 1) console.warn(`DEM layer "${layer.name}" disabled after repeated errors`, e);
    throw e;
  }
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

const merged = new Lru<string, Promise<Float32Array | null>>(96);

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
          continue;
        }
        if (!t) continue;
        if (!result) {
          if (!t.includes(NODATA)) return t; // common case: one complete layer, no copy needed
          result = Float32Array.from(t);
        } else for (let k = 0; k < result.length; k++) if (result[k] === NODATA) result[k] = t[k];
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

/** Zoom at which the best elevation layer covering this tile has full resolution. */
function nativeZoom(z: number, x: number, y: number) {
  for (const { layer } of layers) {
    if (z < layer.minzoom || !intersects(layer, z, x, y)) continue;
    if ((failures.get(layer) ?? 0) >= MAX_FAILURES && layer !== layers[layers.length - 1].layer) continue;
    return Math.min(z, layerNativeZoom(layer, z, y));
  }
  return Math.min(z, DEM_MAXZOOM);
}

/**
 * Elevation grid for tile (z,x,y) with a 1-pixel border on every side ((256+2)² samples),
 * so slope can be computed without seams. Reads DEM tiles at their native resolution and,
 * when zoomed in further, upsamples bicubically across tile borders.
 */
export function demWindow(z: number, x: number, y: number): Promise<Float32Array | null> {
  const dz = nativeZoom(z, x, y);
  return resample((tx, ty) => getDemTile(dz, tx, ty), dz, z, x, y, 1);
}

export type Terrain = { elevation: Float32Array; slope: Float32Array; aspect: Float32Array; shade: Float32Array };

/**
 * Lights for the winter filter's snow shading: a low early-afternoon winter sun from the
 * south-south-west, plus a softer cartographic light from the north-west so that slopes facing
 * away from the sun still show their form.
 */
const light = (azDeg: number, altDeg: number, weight: number) => {
  const az = (azDeg * Math.PI) / 180, alt = (altDeg * Math.PI) / 180;
  return { x: Math.sin(az) * Math.cos(alt) * weight, y: Math.cos(az) * Math.cos(alt) * weight, z: Math.sin(alt) * weight, w: weight };
};
const LIGHTS = [light(205, 32, 0.65), light(315, 45, 0.35)];
/** Shade value of flat ground, so callers can shade relative to it. */
export const FLAT_SHADE = LIGHTS.reduce((a, l) => a + l.z, 0);

/**
 * Per-pixel elevation (m), slope (deg), aspect (deg, 0 = north, clockwise) and a 0..1
 * illumination for tile (z,x,y), using Horn's 3×3 gradient.
 */
export async function terrainForTile(z: number, x: number, y: number, withShade = false): Promise<Terrain | null> {
  const win = await demWindow(z, x, y);
  if (!win) return null;
  const W = TILE + 2;
  const elevation = new Float32Array(TILE * TILE);
  const slope = new Float32Array(TILE * TILE);
  const aspect = new Float32Array(TILE * TILE);
  const shade = new Float32Array(withShade ? TILE * TILE : 0);
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
        // Lambert shading per light; surface normal (-dzdx, dzdy, 1) in an east/north/up frame.
        const nx = -dzdx, ny = dzdy;
        const len = Math.hypot(nx, ny, 1);
        let sh = 0;
        for (const l of LIGHTS) sh += Math.max(0, nx * l.x + ny * l.y + l.z);
        shade[o] = sh / len;
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

/**
 * Slope (deg) and aspect (deg) at a point, from elevations 8 m either side: about the scale of
 * the slope you'd ski or trigger, and robust to boulder-sized bumps in a 1 m model.
 */
export async function slopeAt(lng: number, lat: number) {
  const d = Math.max(metersPerPixel(DEM_MAXZOOM, lat), 8);
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
