import type { Position } from 'geojson';
import { call } from './rpc';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distance(a: Position, b: Position) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Points every ~`step` metres along a polyline (always including the vertices). */
export function densify(line: Position[], step: number): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const n = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  if (line.length) out.push(line[line.length - 1]);
  return out;
}

export type Profile = {
  /** d: distance along the line (m), h: elevation (m), slope/aspect: of the terrain underneath (deg). */
  points: { d: number; h: number; slope: number; aspect: number; at: Position }[];
  length: number;
  ascent: number;
  descent: number;
  min: number;
  max: number;
  /** Steepest terrain the line crosses — what matters for avalanche terrain, not the line's own pitch. */
  steepest: number;
};

type TerrainSample = { elevation: number; slope: number; aspect: number } | null;

/** Samples the terrain along a polyline: elevation profile, climb, and the slope of the ground underneath. */
export async function profile(line: Position[]): Promise<Profile | null> {
  let length = 0;
  for (let i = 1; i < line.length; i++) length += distance(line[i - 1], line[i]);
  if (length < 1) return null;
  const pts = densify(line, Math.max(8, length / 600));
  const samples = await call<TerrainSample[]>('terrainAlong', [pts]);
  const points: Profile['points'] = [];
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) d += distance(pts[i - 1], pts[i]);
    const t = samples[i];
    if (t) points.push({ d, h: t.elevation, slope: t.slope, aspect: t.aspect, at: pts[i] });
  }
  if (points.length < 2) return null;
  // Ascent/descent with a small hysteresis so DEM noise doesn't inflate the totals.
  let ascent = 0, descent = 0, ref = points[0].h;
  for (const p of points) {
    if (p.h - ref > 3) { ascent += p.h - ref; ref = p.h; }
    else if (ref - p.h > 3) { descent += ref - p.h; ref = p.h; }
  }
  const hs = points.map((p) => p.h);
  const steepest = Math.max(...points.map((p) => p.slope));
  return { points, length, ascent, descent, min: Math.min(...hs), max: Math.max(...hs), steepest };
}

export const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
export const fmtEle = (m: number) => `${Math.round(m).toLocaleString('en').replace(/,/g, ' ')} m`;

const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const aspectName = (deg: number) => ASPECTS[Math.round(deg / 45) % 8];
