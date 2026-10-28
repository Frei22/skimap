// Slope-angle classes and the slope filter (angle range + aspects). Used by the page and the tile workers.
import { SLOPE_PROTOCOL } from './protocols';

/** Slope classes as used in avalanche terrain maps (lower bound in degrees, colour). */
export const SLOPE_CLASSES: { min: number; color: [number, number, number]; label: string }[] = [
  { min: 27, color: [245, 228, 70], label: '27–29°' },
  { min: 30, color: [246, 160, 40], label: '30–34°' },
  { min: 35, color: [228, 52, 44], label: '35–39°' },
  { min: 40, color: [170, 38, 160], label: '40–44°' },
  { min: 45, color: [80, 40, 140], label: '45–49°' },
  { min: 50, color: [25, 22, 40], label: '50°+' },
];
/** Gentler terrain only gets a colour when the filter asks for it (e.g. "show me everything under 25°"). */
export const LOW_SLOPE_COLOR: [number, number, number] = [96, 186, 92];

/** Range the filter slider covers. A handle at an end means "no limit on that side". */
export const SLOPE_DOMAIN = { min: 15, max: 60 };

export const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export const ALL_ASPECTS = 0xff;

export type SlopeFilter = {
  /** Lowest angle shown (deg); SLOPE_DOMAIN.min means no lower limit. */
  min: number;
  /** Highest angle shown (deg); SLOPE_DOMAIN.max means no upper limit. */
  max: number;
  /** Bit i set = show slopes facing ASPECTS[i]. */
  aspects: number;
};

export const DEFAULT_SLOPE_FILTER: SlopeFilter = { min: 27, max: SLOPE_DOMAIN.max, aspects: ALL_ASPECTS };

export const slopeTileUrl = (f: SlopeFilter) => `${SLOPE_PROTOCOL}://{z}/{x}/{y}?min=${f.min}&max=${f.max}&asp=${f.aspects}`;

export function colorForSlope(deg: number): [number, number, number] {
  let c = LOW_SLOPE_COLOR;
  for (const k of SLOPE_CLASSES) if (deg >= k.min) c = k.color;
  return c;
}

/** "30–45° · N, NE, E" */
export function describeFilter(f: SlopeFilter) {
  const lo = f.min <= SLOPE_DOMAIN.min, hi = f.max >= SLOPE_DOMAIN.max;
  const range = lo && hi ? 'All angles' : lo ? `Up to ${f.max}°` : hi ? `${f.min}° and steeper` : `${f.min}–${f.max}°`;
  if ((f.aspects & ALL_ASPECTS) === ALL_ASPECTS) return range;
  const names = ASPECTS.filter((_, i) => f.aspects & (1 << i));
  return `${range} · ${names.length ? names.join(', ') : 'no aspects'}`;
}
