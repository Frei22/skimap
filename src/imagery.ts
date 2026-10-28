// `ski-imagery://z/x/y?mode=winter|summer` — a mosaic of the best orthophoto per tile, optionally
// turned into a winter scene (snow cover from elevation + slope, frosted forest, low-sun shading).
import { IMAGERY, type ImageryProvider } from './config';
import { SUN_ALT, terrainForTile } from './dem';
import { snowlineAt } from './regions';
import { TILE, clamp, decodePixels, encodePixels, parseTileUrl, smoothstep, tileBounds } from './tiles';

export const IMAGERY_PROTOCOL = 'ski-imagery';

/** Illumination of flat ground — snow shading is relative to this. */
const FLAT_SUN = Math.sin(SUN_ALT);

function covers(p: ImageryProvider, z: number, x: number, y: number) {
  if (z < p.minzoom) return false;
  if (!p.bounds) return true;
  const b = tileBounds(z, x, y);
  const [w, s, e, n] = p.bounds;
  return b.east > w && b.west < e && b.north > s && b.south < n;
}

const tileUrl = (p: ImageryProvider, z: number, x: number, y: number) =>
  p.url.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);

/** Fetches a provider tile at zoom `pz` ≤ z and crops+upscales the part covering tile (z,x,y). */
async function fetchProviderPixels(p: ImageryProvider, z: number, x: number, y: number, pz: number, signal: AbortSignal) {
  const s = 2 ** (z - pz);
  const res = await fetch(tileUrl(p, pz, Math.floor(x / s), Math.floor(y / s)), { signal });
  if (!res.ok || !(res.headers.get('content-type') ?? 'image').startsWith('image')) return null;
  const blob = await res.blob();
  if (s === 1) return decodePixels(blob);
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  const w = bmp.width / s;
  ctx.drawImage(bmp, (x % s) * w, (y % s) * w, w, w, 0, 0, TILE, TILE);
  bmp.close();
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

const isHole = (px: Uint8ClampedArray, p: number) =>
  px[p + 3] < 8 || (px[p] > 253 && px[p + 1] > 253 && px[p + 2] > 253);

/** Fraction of "no data" pixels (transparent or the pure white providers use outside coverage). */
function holeFraction(px: Uint8ClampedArray) {
  let holes = 0, n = 0;
  for (let p = 0; p < px.length; p += 4 * 7) {
    n++;
    if (isHole(px, p)) holes++;
  }
  return holes / n;
}

/** Near-uniform tiles (e.g. "no imagery here" placeholders) count as missing. */
function isBlank(px: Uint8ClampedArray) {
  let sum = 0, sum2 = 0, n = 0;
  for (let p = 0; p < px.length; p += 4 * 13) {
    const l = px[p] + px[p + 1] + px[p + 2];
    sum += l;
    sum2 += l * l;
    n++;
  }
  const mean = sum / n;
  return sum2 / n - mean * mean < 4;
}

async function tryProvider(p: ImageryProvider, z: number, x: number, y: number, pz: number, signal: AbortSignal) {
  try {
    const px = await fetchProviderPixels(p, z, x, y, pz, signal);
    return px && !isBlank(px) ? px : null;
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
}

/**
 * Mosaic: the first provider with real pixels wins and its no-data holes are filled by the next ones.
 * If nobody has the tile at this zoom (e.g. a provider stops one level early in some areas),
 * fall back to cropping the best provider's tile from up to three zooms lower.
 */
async function mosaic(z: number, x: number, y: number, signal: AbortSignal) {
  const candidates = IMAGERY.filter((p) => covers(p, z, x, y));
  let out: Uint8ClampedArray | null = null;
  for (const p of candidates) {
    const px = await tryProvider(p, z, x, y, Math.min(z, p.maxzoom), signal);
    if (!px) continue;
    if (!out) {
      out = px;
    } else {
      for (let i = 0; i < out.length; i += 4) {
        if (isHole(out, i) && !isHole(px, i)) {
          out[i] = px[i];
          out[i + 1] = px[i + 1];
          out[i + 2] = px[i + 2];
          out[i + 3] = 255;
        }
      }
    }
    if (holeFraction(out) < 0.1) break;
  }
  for (const p of candidates) {
    if (out) break;
    for (let pz = Math.min(z, p.maxzoom) - 1; !out && pz >= Math.max(p.minzoom, z - 3); pz--) {
      out = await tryProvider(p, z, x, y, pz, signal);
    }
  }
  return out;
}

/**
 * Turns a summer orthophoto into a winter scene, pixel by pixel:
 *  - open ground above the snowline gets snow, shaded by a low winter sun;
 *  - cliffs too steep to hold snow keep their (darkened, cooled) rock;
 *  - forest stays dark with a dusting of frost so tree lines still read;
 *  - the photo's own luminance is kept as fine texture (moraines, crevasses, tracks).
 */
async function winterize(px: Uint8ClampedArray, z: number, x: number, y: number) {
  const terrain = await terrainForTile(z, x, y, true);
  if (!terrain) return px;
  const b = tileBounds(z, x, y);
  const snowline = snowlineAt((b.west + b.east) / 2, (b.north + b.south) / 2);
  const { elevation, slope, shade } = terrain;
  // Detail strength: at low zooms the photo is mostly colour, not texture.
  const detail = smoothstep(10, 16, z);

  for (let i = 0, p = 0; i < elevation.length; i++, p += 4) {
    const r = px[p] / 255, g = px[p + 1] / 255, bl = px[p + 2] / 255;
    const L = 0.299 * r + 0.587 * g + 0.114 * bl;
    const greenness = g - (r + bl) / 2;

    // Forest: dark and green-ish (shadows are blue-ish, so they don't count).
    const tree = clamp((0.36 - L) / 0.16) * clamp((greenness + 0.005) * 25);
    // Snow holds on open ground above the snowline and on anything not cliff-steep.
    const above = smoothstep(snowline - 250, snowline + 250, elevation[i]);
    const s = slope[i];
    const stick = 1 - smoothstep(46, 62, s);
    const snow = above * stick * (1 - 0.8 * tree);

    // Snow colour: 1 on flat ground, brighter facing the sun, cold blue in shade.
    const v = clamp(0.9 + 0.6 * (shade[i] - FLAT_SUN), 0.42, 1.04);
    const tex = 1 + detail * 0.35 * (L - 0.45);
    const sr = (v - (1 - v) * 0.16) * tex;
    const sg = (v - (1 - v) * 0.05) * tex;
    const sb = (v + (1 - v) * 0.22) * tex;

    // Ground that isn't snowed in: cooler, less saturated, a bit darker.
    const gray = L;
    let gr = (gray + (r - gray) * 0.55) * 0.88, gg = (gray + (g - gray) * 0.55) * 0.9, gb = (gray + (bl - gray) * 0.55) * 0.96 + 0.02;
    // Frosted forest.
    const frost = 0.18 * above;
    gr = gr + (0.85 - gr) * frost * tree;
    gg = gg + (0.88 - gg) * frost * tree;
    gb = gb + (0.95 - gb) * frost * tree;

    px[p] = 255 * clamp(gr + (sr - gr) * snow);
    px[p + 1] = 255 * clamp(gg + (sg - gg) * snow);
    px[p + 2] = 255 * clamp(gb + (sb - gb) * snow);
    px[p + 3] = 255;
  }
  return px;
}

/** No imagery anywhere (offline provider, gap in coverage): draw the terrain itself as a winter relief. */
async function syntheticRelief(z: number, x: number, y: number, winter: boolean) {
  const t = await terrainForTile(z, x, y, true);
  if (!t) return null;
  const b = tileBounds(z, x, y);
  const snowline = winter ? snowlineAt((b.west + b.east) / 2, (b.north + b.south) / 2) : 2900;
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0, p = 0; i < t.elevation.length; i++, p += 4) {
    const h = t.elevation[i];
    // Base land colour by elevation: valley green → alpine meadow → rock.
    const rock = smoothstep(1800, 2600, h) * 0.6 + smoothstep(38, 55, t.slope[i]) * 0.6;
    const r0 = 0.42 + 0.2 * clamp(rock), g0 = 0.5 + 0.1 * clamp(rock), b0 = 0.36 + 0.24 * clamp(rock);
    const snow = smoothstep(snowline - 250, snowline + 250, h) * (1 - smoothstep(46, 62, t.slope[i]));
    const lit = 0.45 + 0.55 * t.shade[i];
    const sr = 0.66 + 0.34 * lit, sg = 0.72 + 0.28 * lit, sb = 0.84 + 0.16 * lit;
    px[p] = 255 * clamp((r0 * lit) * (1 - snow) + sr * snow);
    px[p + 1] = 255 * clamp((g0 * lit) * (1 - snow) + sg * snow);
    px[p + 2] = 255 * clamp((b0 * lit) * (1 - snow) + sb * snow);
    px[p + 3] = 255;
  }
  return px;
}

export async function imageryProtocol(params: { url: string }, abort: AbortController) {
  const { z, x, y, query } = parseTileUrl(params.url);
  const winter = query.get('mode') === 'winter';
  let px = await mosaic(z, x, y, abort.signal);
  if (px && winter) px = await winterize(px, z, x, y);
  if (!px) px = await syntheticRelief(z, x, y, winter);
  if (!px) throw new Error('No imagery for tile');
  return { data: await encodePixels(px) };
}
