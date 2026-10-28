// `ski-slope://z/x/y` — avalanche-terrain slope classes computed in the browser from the DEM.
import { terrainForTile } from './dem';
import { TILE, encodePixels, parseTileUrl } from './tiles';

export const SLOPE_PROTOCOL = 'ski-slope';

/** Slope classes as used in avalanche terrain maps (lower bound in degrees, colour). */
export const SLOPE_CLASSES: { min: number; color: [number, number, number]; label: string }[] = [
  { min: 27, color: [245, 228, 70], label: '27–29°' },
  { min: 30, color: [246, 160, 40], label: '30–34°' },
  { min: 35, color: [228, 52, 44], label: '35–39°' },
  { min: 40, color: [170, 38, 160], label: '40–44°' },
  { min: 45, color: [80, 40, 140], label: '45–49°' },
  { min: 50, color: [25, 22, 40], label: '50°+' },
];

const LUT = new Uint8ClampedArray(91 * 4);
for (let d = 0; d <= 90; d++) {
  let cls = -1;
  for (let c = 0; c < SLOPE_CLASSES.length; c++) if (d >= SLOPE_CLASSES[c].min) cls = c;
  if (cls < 0) continue;
  LUT.set([...SLOPE_CLASSES[cls].color, 255], d * 4);
}

export async function slopeProtocol(params: { url: string }) {
  const { z, x, y } = parseTileUrl(params.url);
  const t = await terrainForTile(z, x, y);
  if (!t) throw new Error('No DEM');
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0, p = 0; i < t.slope.length; i++, p += 4) {
    const d = t.slope[i];
    // Fade in over the first degree so class edges are soft rather than stair-stepped.
    const k = Math.min(90, Math.floor(d)) * 4;
    px[p] = LUT[k];
    px[p + 1] = LUT[k + 1];
    px[p + 2] = LUT[k + 2];
    px[p + 3] = d < 26 ? 0 : d < 27 ? (d - 26) * 255 : LUT[k + 3];
    if (d >= 26 && d < 27) px.set(SLOPE_CLASSES[0].color, p);
  }
  return { data: await encodePixels(px) };
}
