// `ski-imagery://z/x/y?mode=winter|summer` (IMAGERY_PROTOCOL) — a mosaic of the best orthophoto per tile, optionally
// turned into a winter scene (snow cover from elevation + slope, frosted forest, low-sun shading).
import { IMAGERY, type ImageryProvider } from './config';
import { FLAT_SHADE, terrainForTile } from './dem';
import { snowlineAt } from './regions';
import { TILE, clamp, decodePixels, encodePixels, parseTileUrl, smoothstep, tileBounds } from './tiles';



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

/**
 * No-data mask for a provider tile: transparent pixels, plus pure white for providers that paint
 * areas outside their coverage white. (Only for those: pure white is also sunlit glacier.)
 */
function holeMask(px: Uint8ClampedArray, p: ImageryProvider) {
  const mask = new Uint8Array(px.length / 4);
  let holes = 0;
  for (let i = 0, q = 0; i < mask.length; i++, q += 4) {
    if (px[q + 3] < 8 || (p.whiteIsNoData && px[q] >= 254 && px[q + 1] >= 254 && px[q + 2] >= 254)) {
      mask[i] = 1;
      holes++;
    }
  }
  return { mask, holes };
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
  let mask: Uint8Array | null = null;
  let holes = 0;
  for (const p of candidates) {
    const px = await tryProvider(p, z, x, y, Math.min(z, p.maxzoom), signal);
    if (!px) continue;
    const m = holeMask(px, p);
    if (!out || !mask) {
      ({ mask, holes } = m);
      out = px;
    } else {
      for (let i = 0, q = 0; i < mask.length; i++, q += 4) {
        if (mask[i] && !m.mask[i]) {
          out[q] = px[q];
          out[q + 1] = px[q + 1];
          out[q + 2] = px[q + 2];
          out[q + 3] = 255;
          mask[i] = 0;
          holes--;
        }
      }
    }
    if (holes < 50) break; // a few stray pixels aren't worth another download
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

    // Lakes: flat and blue-green. Above the snowline they're frozen and snowed over.
    const water = (1 - smoothstep(2, 5, slope[i])) * clamp((bl - r) * 10) * clamp((g - r) * 10 + 0.5);
    // Forest: dark and green-ish (shadows are blue-ish, so they don't count).
    const tree = clamp((0.36 - L) / 0.16) * clamp((greenness + 0.005) * 25) * (1 - water);
    // Snow holds on open ground above the snowline and on anything not cliff-steep. Dark, non-green
    // pixels on steep ground are rock faces: the DEM smooths cliffs out, so the photo gets a say.
    const above = smoothstep(snowline - 250, snowline + 250, elevation[i]);
    const s = slope[i];
    const rock = clamp((0.55 - L) / 0.25) * (1 - clamp(greenness * 15));
    const stick = (1 - smoothstep(46, 62, s)) * (1 - rock) + (1 - smoothstep(30, 46, s)) * rock;
    const snow = above * stick * (1 - 0.8 * tree);

    // Snow, shaded by the terrain, with the photo's luminance kept as fine texture.
    const [sr, sg, sb] = snowColour(shade[i], 1 + detail * 0.35 * (L - 0.45));

    // Ground that isn't snowed in: cooler, less saturated, a bit darker (forest keeps more green).
    const gray = L;
    const sat = 0.55 + 0.25 * tree;
    let gr = (gray + (r - gray) * sat) * 0.86, gg = (gray + (g - gray) * sat) * 0.9, gb = (gray + (bl - gray) * sat) * 0.94 + 0.02;
    // Frosted forest.
    const frost = 0.2 * above;
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

/** Snow colour for a relative illumination: near-white on flat ground, cold blue in shade. */
function snowColour(shade: number, tex: number): [number, number, number] {
  const v = clamp(0.93 + 0.95 * (shade - FLAT_SHADE), 0.4, 1.05);
  return [(v - (1 - v) * 0.16) * tex, (v - (1 - v) * 0.05) * tex, (v + (1 - v) * 0.22) * tex];
}

/** No imagery anywhere (offline provider, gap in coverage): draw the terrain itself as a shaded relief. */
async function syntheticRelief(z: number, x: number, y: number, winter: boolean) {
  const t = await terrainForTile(z, x, y, true);
  if (!t) return null;
  const b = tileBounds(z, x, y);
  const snowline = winter ? snowlineAt((b.west + b.east) / 2, (b.north + b.south) / 2) : 2900;
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0, p = 0; i < t.elevation.length; i++, p += 4) {
    const h = t.elevation[i], s = t.slope[i];
    // Land colour by elevation and steepness: valley green → alpine meadow → rock.
    const rock = clamp(smoothstep(1800, 2600, h) * 0.6 + smoothstep(38, 55, s) * 0.6);
    const lit = clamp(0.75 + 0.9 * (t.shade[i] - FLAT_SHADE), 0.3, 1.1);
    const land = [(0.42 + 0.2 * rock) * lit, (0.5 + 0.1 * rock) * lit, (0.36 + 0.24 * rock) * lit];
    const snow = smoothstep(snowline - 250, snowline + 250, h) * (1 - smoothstep(46, 62, s));
    const sc = snowColour(t.shade[i], 1);
    px[p] = 255 * clamp(land[0] + (sc[0] - land[0]) * snow);
    px[p + 1] = 255 * clamp(land[1] + (sc[1] - land[1]) * snow);
    px[p + 2] = 255 * clamp(land[2] + (sc[2] - land[2]) * snow);
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
