// `ski-imagery://z/x/y?mode=winter|summer` (IMAGERY_PROTOCOL) — a mosaic of the best orthophoto per tile, optionally
// turned into a winter scene (snow cover from elevation + slope, frosted forest, low-sun shading).
import { IMAGERY, type ImageryProvider } from './config';
import { FLAT_SHADE, terrainForTile } from './dem';
import { climateAt } from './regions';
import { TILE, clamp, decodePixels, encodePixels, metersPerPixel, parseTileUrl, smoothstep, tile2lat, tileBounds } from './tiles';



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
  const { snowline, treeline, forest } = climateAt((b.west + b.east) / 2, (b.north + b.south) / 2);
  const birch = forest === 'birch';
  const { elevation, slope, shade } = terrain;
  // Detail strength: at low zooms the photo is mostly colour, not texture.
  const detail = smoothstep(10, 16, z);

  // Classify on lightly smoothed colour, so JPEG blocks and single pixels can't flip a decision;
  // the unsmoothed photo still provides the texture.
  const soft = boxBlur(px, 2);

  // Canopy texture: forest is busy (crowns and their shadows), meadow is smooth even where it's
  // just as dark. Local contrast over a window of a few crowns (~5 m) tells them apart, once the
  // pixels are small enough to resolve crowns at all.
  const mpp = metersPerPixel(z, tile2lat(y + 0.5, z));
  const textureWeight = 1 - smoothstep(3, 8, mpp);
  const R = Math.min(8, Math.max(1, Math.round(5 / mpp)));
  const lum = new Float32Array(TILE * TILE), lum2 = new Float32Array(TILE * TILE);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    lum[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) / 255;
    lum2[i] = lum[i] * lum[i];
  }
  // Two box passes ≈ a Gaussian: no square halos around lone trees.
  const r2 = Math.max(1, Math.ceil(R * 0.7));
  const localMean = blur1(blur1(lum, r2), r2), localSq = blur1(blur1(lum2, r2), r2);

  for (let i = 0, p = 0; i < elevation.length; i++, p += 4) {
    const r = px[p] / 255, g = px[p + 1] / 255, bl = px[p + 2] / 255;
    const L = 0.299 * r + 0.587 * g + 0.114 * bl;
    const sr0 = soft[p] / 255, sg0 = soft[p + 1] / 255, sb0 = soft[p + 2] / 255;
    const sL = 0.299 * sr0 + 0.587 * sg0 + 0.114 * sb0;
    const greenness = sg0 - (sr0 + sb0) / 2;

    // Lakes: flat and blue-green. Above the snowline they're frozen and snowed over.
    const water = (1 - smoothstep(2, 5, slope[i])) * clamp((sb0 - sr0) * 10) * clamp((sg0 - sr0) * 10 + 0.5);
    // Forest: below the treeline, dark pixels are trees, even in deep shadow where the photo has no
    // green left (IGN's morning imagery is nearly black on north-facing forest). Blue shadow on snow
    // or water doesn't count.
    const belowTreeline = 1 - smoothstep(treeline - 200, treeline + 100, elevation[i]);
    const m = localMean[i];
    const contrast = Math.sqrt(Math.max(0, localSq[i] - m * m)) / (m + 0.04);
    // Measured on IGN's 20 cm imagery: conifer canopy ~0.13–0.16, alpine meadow ~0.03.
    const canopy = 1 - textureWeight + textureWeight * smoothstep(0.05, 0.11, contrast);
    // Within forest, a crown is darker than its surroundings; the lighter gaps get snow. This also
    // keeps the meadow next to a lone tree white.
    const crown = 1 - textureWeight + textureWeight * clamp((m - L) * 15 + 0.6);
    const tree = clamp((0.4 - sL) / 0.16) * clamp((greenness + 0.04) * 25) * canopy * crown * belowTreeline * (1 - water);
    // Snow holds on open ground above the snowline and on anything not cliff-steep. Dark, non-green
    // pixels on steep ground are rock faces: the DEM smooths cliffs out, so the photo gets a say.
    const above = smoothstep(snowline - 250, snowline + 250, elevation[i]);
    const s = slope[i];
    const rock = clamp((0.55 - sL) / 0.25) * (1 - clamp(greenness * 15)) * (1 - tree);
    const stick = (1 - smoothstep(46, 62, s)) * (1 - rock) + (1 - smoothstep(30, 46, s)) * rock;
    // Light-grey rock outcrops above the treeline (granite blocks, boulder fields) are brighter than
    // the dark-rock rule catches: grey, textured, mid-brightness. They stay visible, dusted with snow.
    const satS = Math.max(sr0, sg0, sb0) - Math.min(sr0, sg0, sb0);
    const structure = smoothstep(0.04, 0.12, contrast);
    const outcrop = structure * (1 - clamp(satS * 6)) * smoothstep(treeline, treeline + 300, elevation[i]) *
      smoothstep(0.3, 0.45, sL) * (1 - smoothstep(0.72, 0.85, sL));
    const snow = above * stick * (1 - (birch ? 0.35 : 0.97) * tree) * (1 - 0.6 * outcrop);

    // Snow, shaded by the terrain, with the photo's light and shadow kept as texture (roof edges,
    // cast shadows, tracks), more so when zoomed in. Where the photo already shows snow (winter
    // imagery, glaciers), its own light is the real thing: keep it and add half the relief shading.
    // Snow colour comes from the relief: white in the light, blue in shade. Where the photo already
    // shows snow (glaciers, winter imagery) its own light is the real thing, so it leads instead.
    const vDem = snowLight(shade[i]);
    const photoSnow = clamp((sL - 0.6) / 0.2) * clamp(1 - satS * 5);
    const vPhoto = (L / 0.88) * (1 + 0.5 * (vDem - 0.97));
    const tint = snowTint(vDem + (vPhoto - vDem) * photoSnow);
    // Then the photo's fine detail as a neutral brightness change, so rocks, roofs and tree edges
    // read grey rather than as blue shadow. Only where the photo has real structure: on open meadow
    // the summer texture is grass and stones, which would look like dirty snow. Only a little of the
    // photo's broad light, too: summer cast shadows don't belong on the snow.
    const texF = 1 + (1 - photoSnow) * detail * (1.4 * structure * (L - sL) + 0.22 * (Math.min(sL, 0.75) - 0.45));
    const sr = tint[0] * texF, sg = tint[1] * texF, sb = tint[2] * texF;

    // Ground that isn't snowed in: cooler, less saturated, a bit darker...
    let gr = (L + (r - L) * 0.55) * 0.86, gg = (L + (g - L) * 0.55) * 0.9, gb = (L + (bl - L) * 0.55) * 0.94 + 0.02;
    // ...except forest: conifers in dark winter green with the photo's crown texture, lightly frosted;
    // bare birch as a grey-brown haze.
    const frost = 0.15 * above;
    const tr = birch ? 0.42 + 0.4 * L : (0.5 * L + 0.02) * (1 - frost) + 0.85 * frost;
    const tg = birch ? 0.38 + 0.4 * L : (0.8 * L + 0.06) * (1 - frost) + 0.88 * frost;
    const tb = birch ? 0.36 + 0.4 * L : (0.6 * L + 0.05) * (1 - frost) + 0.95 * frost;
    gr += (tr - gr) * tree;
    gg += (tg - gg) * tree;
    gb += (tb - gb) * tree;

    px[p] = 255 * clamp(gr + (sr - gr) * snow);
    px[p + 1] = 255 * clamp(gg + (sg - gg) * snow);
    px[p + 2] = 255 * clamp(gb + (sb - gb) * snow);
    px[p + 3] = 255;
  }
  return px;
}

/** Box blur of a single-channel tile (two separable passes, edges clamped). */
function blur1(src: Float32Array, radius: number) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const n = 2 * radius + 1;
  for (let pass = 0; pass < 2; pass++) {
    const a = pass === 0 ? src : tmp, b = pass === 0 ? tmp : out;
    for (let line = 0; line < TILE; line++) {
      const at = (k: number) => {
        const kk = Math.min(TILE - 1, Math.max(0, k));
        return pass === 0 ? line * TILE + kk : kk * TILE + line;
      };
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += a[at(k)];
      for (let k = 0; k < TILE; k++) {
        b[at(k)] = sum / n;
        sum += a[at(k + radius + 1)] - a[at(k - radius)];
      }
    }
  }
  return out;
}

/** Box blur of an RGBA tile with the given radius (two separable passes, edges clamped). */
function boxBlur(px: Uint8ClampedArray, radius: number) {
  const tmp = new Float32Array(px.length), out = new Uint8ClampedArray(px.length);
  const n = 2 * radius + 1;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? px : tmp, dst = pass === 0 ? tmp : out;
    for (let a = 0; a < TILE; a++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        const idx = (k: number) => {
          const kk = Math.min(TILE - 1, Math.max(0, k));
          return (pass === 0 ? a * TILE + kk : kk * TILE + a) * 4 + c;
        };
        for (let k = -radius; k <= radius; k++) sum += src[idx(k)];
        for (let k = 0; k < TILE; k++) {
          dst[idx(k)] = sum / n;
          sum += src[idx(k + radius + 1)] - src[idx(k - radius)];
        }
      }
    }
  }
  return out;
}

/** Brightness of snow for a relative illumination: ~0.97 on flat ground, more facing the light (soft-clipped later). */
const snowLight = (shade: number) => clamp(0.97 + 0.95 * (shade - FLAT_SHADE), 0.5, 1.15);

/** Snow colour for a brightness: white in the light, increasingly cold blue in shade. */
function snowTint(v: number): [number, number, number] {
  // Soft knee instead of clipping: sunlit snow stays just below white, so its texture survives.
  const k = v < 0.82 ? v : 0.82 + 0.17 * Math.tanh((v - 0.82) / 0.17);
  const warm = Math.max(0, k - 0.93) * 0.15; // a touch of warmth in the light
  return [k - (1 - k) * 0.16 + warm, k - (1 - k) * 0.05, k + (1 - k) * 0.22 - warm * 0.6];
}

/** No imagery anywhere (offline provider, gap in coverage): draw the terrain itself as a shaded relief. */
async function syntheticRelief(z: number, x: number, y: number, winter: boolean) {
  const t = await terrainForTile(z, x, y, true);
  if (!t) return null;
  const b = tileBounds(z, x, y);
  const snowline = winter ? climateAt((b.west + b.east) / 2, (b.north + b.south) / 2).snowline : 2900;
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0, p = 0; i < t.elevation.length; i++, p += 4) {
    const h = t.elevation[i], s = t.slope[i];
    // Land colour by elevation and steepness: valley green → alpine meadow → rock.
    const rock = clamp(smoothstep(1800, 2600, h) * 0.6 + smoothstep(38, 55, s) * 0.6);
    const lit = clamp(0.75 + 0.9 * (t.shade[i] - FLAT_SHADE), 0.3, 1.1);
    const land = [(0.42 + 0.2 * rock) * lit, (0.5 + 0.1 * rock) * lit, (0.36 + 0.24 * rock) * lit];
    const snow = smoothstep(snowline - 250, snowline + 250, h) * (1 - smoothstep(46, 62, s));
    const sc = snowTint(snowLight(t.shade[i]));
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
