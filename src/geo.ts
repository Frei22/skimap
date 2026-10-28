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
  points: { d: number; h: number; slope: number; at: Position }[];
  length: number;
  ascent: number;
  descent: number;
  min: number;
  max: number;
  steepest: number;
};

/** Samples the DEM along a polyline and derives length, climb and the steepest ~30 m pitch. */
export async function profile(line: Position[]): Promise<Profile | null> {
  let length = 0;
  for (let i = 1; i < line.length; i++) length += distance(line[i - 1], line[i]);
  if (length < 1) return null;
  const step = Math.max(8, length / 600);
  const pts = densify(line, step);
  const hs = await call<(number | null)[]>('elevations', [pts]);
  const points: Profile['points'] = [];
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) d += distance(pts[i - 1], pts[i]);
    if (hs[i] !== null) points.push({ d, h: hs[i]!, slope: 0, at: pts[i] });
  }
  if (points.length < 2) return null;
  // Slope over a window of ≥30 m horizontal, which matches what you feel on skis better than per-sample noise.
  let steepest = 0;
  for (let i = 0, j = 0; i < points.length; i++) {
    while (j < points.length - 1 && points[j].d - points[i].d < 30) j++;
    const run = points[j].d - points[i].d;
    if (run >= 15) {
      const s = (Math.atan(Math.abs(points[j].h - points[i].h) / run) * 180) / Math.PI;
      points[i].slope = s;
      steepest = Math.max(steepest, s);
    } else if (i > 0) points[i].slope = points[i - 1].slope;
  }
  // Ascent/descent with a small hysteresis so DEM noise doesn't inflate the totals.
  let ascent = 0, descent = 0, ref = points[0].h;
  for (const p of points) {
    if (p.h - ref > 3) { ascent += p.h - ref; ref = p.h; }
    else if (ref - p.h > 3) { descent += ref - p.h; ref = p.h; }
  }
  const hsOnly = points.map((p) => p.h);
  return { points, length, ascent, descent, min: Math.min(...hsOnly), max: Math.max(...hsOnly), steepest };
}

export const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
export const fmtEle = (m: number) => `${Math.round(m).toLocaleString('en').replace(/,/g, ' ')} m`;

const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const aspectName = (deg: number) => ASPECTS[Math.round(deg / 45) % 8];
