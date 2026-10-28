// Elevation profile as inline SVG: the area under the line is coloured by slope class.
import type { Profile } from './geo';
import { fmtDist, fmtEle } from './geo';
import { SLOPE_CLASSES } from './slope';

const W = 320, H = 110, PAD_L = 34, PAD_B = 16, PAD_T = 8;

function slopeColor(s: number) {
  let c = 'rgba(120,140,160,0.35)';
  for (const k of SLOPE_CLASSES) if (s >= k.min) c = `rgb(${k.color.join(',')})`;
  return c;
}

export function renderProfile(el: HTMLElement, p: Profile, onHover: (i: number | null) => void) {
  const span = Math.max(p.max - p.min, 50);
  const lo = p.min - span * 0.08, hi = p.max + span * 0.12;
  const sx = (d: number) => PAD_L + (d / p.length) * (W - PAD_L - 4);
  const sy = (h: number) => PAD_T + (1 - (h - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  const base = H - PAD_B;
  let bars = '';
  for (let i = 0; i < p.points.length - 1; i++) {
    const a = p.points[i], b = p.points[i + 1];
    bars += `<path d="M${sx(a.d)},${base}L${sx(a.d)},${sy(a.h)}L${sx(b.d)},${sy(b.h)}L${sx(b.d)},${base}Z" fill="${slopeColor(a.slope)}" stroke="none"/>`;
  }
  const line = p.points.map((q, i) => `${i ? 'L' : 'M'}${sx(q.d).toFixed(1)},${sy(q.h).toFixed(1)}`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="profile-svg" role="img" aria-label="Elevation profile">
      <text x="2" y="${sy(p.max) + 4}" class="axis">${Math.round(p.max)}</text>
      <text x="2" y="${sy(p.min) + 4}" class="axis">${Math.round(p.min)}</text>
      <line x1="${PAD_L}" x2="${W - 4}" y1="${base}" y2="${base}" class="axis-line"/>
      <text x="${W - 4}" y="${H - 3}" class="axis" text-anchor="end">${fmtDist(p.length)}</text>
      ${bars}
      <path d="${line}" fill="none" class="profile-line"/>
      <line class="cursor" x1="0" x2="0" y1="${PAD_T}" y2="${base}" visibility="hidden"/>
      <rect x="${PAD_L}" y="0" width="${W - PAD_L}" height="${H}" fill="transparent" class="hit"/>
    </svg>
    <div class="profile-readout"></div>`;
  const svg = el.querySelector('svg')!;
  const cursor = el.querySelector<SVGLineElement>('.cursor')!;
  const readout = el.querySelector<HTMLElement>('.profile-readout')!;
  const move = (clientX: number) => {
    const r = svg.getBoundingClientRect();
    const vx = ((clientX - r.left) / r.width) * W;
    const d = ((vx - PAD_L) / (W - PAD_L - 4)) * p.length;
    let best = 0;
    for (let i = 0; i < p.points.length; i++) if (Math.abs(p.points[i].d - d) < Math.abs(p.points[best].d - d)) best = i;
    const q = p.points[best];
    cursor.setAttribute('x1', `${sx(q.d)}`);
    cursor.setAttribute('x2', `${sx(q.d)}`);
    cursor.setAttribute('visibility', 'visible');
    readout.textContent = `${fmtDist(q.d)} · ${fmtEle(q.h)} · ${Math.round(q.slope)}°`;
    onHover(best);
  };
  const leave = () => {
    cursor.setAttribute('visibility', 'hidden');
    readout.textContent = '';
    onHover(null);
  };
  svg.addEventListener('pointermove', (e) => move(e.clientX));
  svg.addEventListener('pointerleave', leave);
}
