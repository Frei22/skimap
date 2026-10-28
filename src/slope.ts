// `ski-slope://z/x/y?min=&max=&asp=` — slope-angle tiles computed in the browser from the DEM,
// optionally filtered to a range of angles and a set of aspects.
import { terrainForTile } from './dem';
import { ALL_ASPECTS, DEFAULT_SLOPE_FILTER, SLOPE_DOMAIN, colorForSlope } from './slope-filter';
import { Lru, TILE, encodePixels, parseTileUrl } from './tiles';

// Slope (half-degree steps) and aspect octant per pixel, so re-filtering a tile is just a recolour.
type SlopeGrid = { slope2: Uint8Array; octant: Uint8Array };
const grids = new Lru<string, Promise<SlopeGrid | null>>(160);
const FLAT = 255; // no meaningful aspect

function slopeGrid(z: number, x: number, y: number) {
  const key = `${z}/${x}/${y}`;
  let p = grids.get(key);
  if (!p) {
    p = terrainForTile(z, x, y).then((t) => {
      if (!t) return null;
      const slope2 = new Uint8Array(TILE * TILE), octant = new Uint8Array(TILE * TILE);
      for (let i = 0; i < slope2.length; i++) {
        slope2[i] = Math.min(180, Math.round(t.slope[i] * 2));
        octant[i] = t.slope[i] < 5 ? FLAT : Math.round(t.aspect[i] / 45) % 8;
      }
      return { slope2, octant };
    });
    grids.set(key, p);
    p.catch(() => grids.delete(key));
  }
  return p;
}

export async function slopeProtocol(params: { url: string }) {
  const { z, x, y, query } = parseTileUrl(params.url);
  const grid = await slopeGrid(z, x, y);
  if (!grid) throw new Error('No DEM');
  const min = Number(query.get('min') ?? DEFAULT_SLOPE_FILTER.min);
  const max = Number(query.get('max') ?? DEFAULT_SLOPE_FILTER.max);
  const aspects = Number(query.get('asp') ?? ALL_ASPECTS);
  const lo2 = min <= SLOPE_DOMAIN.min ? 0 : min * 2;
  const hi2 = max >= SLOPE_DOMAIN.max ? 180 : max * 2 + 1; // inclusive of the whole top degree
  const allAspects = (aspects & ALL_ASPECTS) === ALL_ASPECTS;

  // Colour per half degree, with the lowest shown half-degree at half opacity to soften the edge.
  const lut = new Uint8ClampedArray(181 * 4);
  for (let s2 = Math.max(lo2 - 1, 0); s2 <= hi2; s2++) {
    lut.set([...colorForSlope(Math.max(s2, lo2) / 2), s2 < lo2 ? 128 : 255], s2 * 4);
  }
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0, p = 0; i < grid.slope2.length; i++, p += 4) {
    if (!allAspects) {
      const o = grid.octant[i];
      if (o === FLAT || !(aspects & (1 << o))) continue;
    }
    const k = grid.slope2[i] * 4;
    px[p] = lut[k];
    px[p + 1] = lut[k + 1];
    px[p + 2] = lut[k + 2];
    px[p + 3] = lut[k + 3];
  }
  return { data: await encodePixels(px) };
}
