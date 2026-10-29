import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapGeoJSONFeature, RasterTileSource } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import mlcontour from 'maplibre-contour';
import type { Feature, LineString, MultiLineString, Position } from 'geojson';
import { DEM_LAYERS, IMAGERY } from './config';
import { aspectName, distance, distanceBySlope, fmtDist, fmtEle, profile, type Profile } from './geo';
import { DEM_PROTOCOL, IMAGERY_PROTOCOL, SLOPE_PROTOCOL } from './protocols';
import { OsmStore } from './osm';
import { renderProfile } from './profile-chart';
import { REGIONS, regionById, type Region } from './regions';
import { areaKey, call } from './rpc';
import {
  ALL_ASPECTS, ASPECTS, DEFAULT_SLOPE_FILTER, LOW_SLOPE_COLOR, SLOPE_CLASSES, SLOPE_DOMAIN,
  describeFilter, slopeTileUrl, type SlopeFilter,
} from './slope-filter';
import { DIFFICULTY_COLORS, DIFFICULTY_LABELS, LAYER_GROUPS, buildStyle, imageryTiles, type Toggles } from './style';
import { parseTileUrl } from './tiles';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- settings
type Settings = Toggles & { region: string; exaggeration: number; hd: boolean; slopeFilter: SlopeFilter };
const SETTINGS_KEY = 'skimap:settings:v2';
const defaults: Settings = {
  region: 'chamonix',
  winter: true,
  slope: false,
  pistes: true,
  contours: false,
  labels: true,
  hillshade: false,
  exaggeration: 1,
  hd: window.devicePixelRatio >= 2, // detail first; switch off under Layers if a phone struggles
  slopeFilter: DEFAULT_SLOPE_FILTER,
};
const settings: Settings = { ...defaults };
try {
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) Object.assign(settings, JSON.parse(saved));
  else {
    // v1 → v2: keep everything except "sharp imagery", which is now on by default on retina screens.
    const { hd: _, ...v1 } = JSON.parse(localStorage.getItem('skimap:settings:v1') ?? '{}');
    Object.assign(settings, v1);
  }
} catch {
  /* storage unavailable */
}
const save = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
};
let region: Region = regionById(settings.region) ?? REGIONS[0];

// ---------------------------------------------------------------- protocols (work happens in a Web Worker)
maplibregl.addProtocol(IMAGERY_PROTOCOL, (p, abort) => call<ImageBitmap>('imagery', [p.url], abort.signal, areaKey(p.url)).then((data) => ({ data })));
maplibregl.addProtocol(SLOPE_PROTOCOL, (p, abort) => call<ImageBitmap>('slope', [p.url], abort.signal, areaKey(p.url)).then((data) => ({ data })));
maplibregl.addProtocol(DEM_PROTOCOL, (p, abort) => {
  const { z, x, y } = parseTileUrl(p.url);
  return call<ImageBitmap>('dem', [z, x, y], abort.signal).then((data) => ({ data }));
});
maplibregl.setWorkerUrl(workerUrl);
// Our protocol tiles wait on workers, not the network; a deep queue keeps them from starving the DEM.
maplibregl.setMaxParallelImageRequests(64);

// Contours come from the global DEM (maplibre-contour fetches it directly in its own worker).
const globalDem = DEM_LAYERS[DEM_LAYERS.length - 1];
const contourDem = new mlcontour.DemSource({
  url: [globalDem.url].flat()[0],
  encoding: globalDem.encoding === 'mapbox' ? 'mapbox' : 'terrarium',
  maxzoom: globalDem.maxzoom,
  worker: true,
});
contourDem.setupMaplibre(maplibregl);
const contourTiles = contourDem.contourProtocolUrl({
  multiplier: 1,
  thresholds: { 10: [200, 1000], 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50] },
  elevationKey: 'ele',
  levelKey: 'level',
  contourLayer: 'contours',
});

// ---------------------------------------------------------------- map
const hasHash = /^#\d/.test(location.hash);
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(settings, contourTiles, settings.hd ? 128 : 256, settings.exaggeration, settings.slopeFilter),
  center: region.camera.center,
  zoom: region.camera.zoom,
  pitch: region.camera.pitch,
  bearing: region.camera.bearing,
  maxPitch: 85,
  hash: true,
  attributionControl: { compact: true },
  canvasContextAttributes: { antialias: true },
});
if (!hasHash) map.jumpTo(region.camera);

// ---------------------------------------------------------------- pistes & lifts
const status = $('#status');
let statusTimer = 0;
function setStatus(text: string | null, spinning = false) {
  clearTimeout(statusTimer);
  if (!text) {
    status.hidden = true;
    return;
  }
  status.innerHTML = `${spinning ? '<i class="spin"></i>' : ''}${esc(text)}`;
  status.hidden = false;
  if (!spinning) statusTimer = window.setTimeout(() => (status.hidden = true), 5000);
}

const osm = new OsmStore(
  (fc) => (map.getSource('osm') as GeoJSONSource | undefined)?.setData(fc),
  (busy, error) => (error ? setStatus(error) : setStatus(busy ? 'Loading pistes & lifts…' : null, busy)),
);

function loadVisibleOsm() {
  if (!settings.pistes || map.getZoom() < 10.5) return;
  const c = map.getCenter();
  const b = map.getBounds();
  // In a pitched view the bounds reach the horizon — only load what's reasonably near the centre.
  const dLat = 0.25, dLng = 0.25 / Math.cos((c.lat * Math.PI) / 180);
  osm.ensure(
    Math.max(b.getWest(), c.lng - dLng),
    Math.max(b.getSouth(), c.lat - dLat),
    Math.min(b.getEast(), c.lng + dLng),
    Math.min(b.getNorth(), c.lat + dLat),
  );
}
map.on('load', loadVisibleOsm);
// On phones the expanded attribution covers a lot of map; start it collapsed behind its (i) button.
map.on('load', () => {
  if (matchMedia('(max-width: 640px)').matches) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});
map.on('moveend', loadVisibleOsm);

// ---------------------------------------------------------------- region picker
const regionBtn = $('#region-btn');
const regionMenu = $('#region-menu');
const FLAGS: Record<string, string> = { FR: '🇫🇷', SE: '🇸🇪', CH: '🇨🇭', IT: '🇮🇹', AT: '🇦🇹', NO: '🇳🇴' };
function renderRegions() {
  $('#region-name').textContent = region.name;
  regionMenu.innerHTML = REGIONS.map(
    (r) => `<li><button role="option" data-region="${r.id}" aria-selected="${r.id === region.id}">
      <span class="flag">${FLAGS[r.country] ?? '🏔'}</span><span><b>${esc(r.name)}</b><small>${esc(r.subtitle)}</small></span>
    </button></li>`,
  ).join('');
}
renderRegions();
regionBtn.addEventListener('click', () => {
  regionMenu.hidden = !regionMenu.hidden;
  regionBtn.setAttribute('aria-expanded', `${!regionMenu.hidden}`);
});
regionMenu.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-region]')?.dataset.region;
  const r = id && regionById(id);
  if (!r) return;
  region = r;
  settings.region = r.id;
  save();
  renderRegions();
  regionMenu.hidden = true;
  closeCard();
  map.flyTo({ ...r.camera, duration: 4000, essential: true });
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.region-picker')) regionMenu.hidden = true;
});

// ---------------------------------------------------------------- layers sheet
const layersSheet = $('#layers');
$('#btn-layers').addEventListener('click', () => {
  layersSheet.hidden = !layersSheet.hidden;
  $('#btn-layers').setAttribute('aria-pressed', `${!layersSheet.hidden}`);
});
layersSheet.querySelector('[data-close]')!.addEventListener('click', () => {
  layersSheet.hidden = true;
  $('#btn-layers').setAttribute('aria-pressed', 'false');
});

function syncSeason() {
  layersSheet.querySelectorAll<HTMLElement>('[data-season]').forEach((b) => {
    b.setAttribute('aria-checked', `${(b.dataset.season === 'winter') === settings.winter}`);
  });
}
syncSeason();
layersSheet.querySelectorAll<HTMLElement>('[data-season]').forEach((b) =>
  b.addEventListener('click', () => {
    const winter = b.dataset.season === 'winter';
    if (winter === settings.winter) return;
    settings.winter = winter;
    save();
    syncSeason();
    (map.getSource('imagery') as RasterTileSource).setTiles(imageryTiles(winter));
  }),
);

function applyToggle(key: keyof typeof LAYER_GROUPS) {
  for (const id of LAYER_GROUPS[key]) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', settings[key] ? 'visible' : 'none');
  if (key === 'slope') syncSlopePanel();
  if (key === 'pistes') loadVisibleOsm();
}
function setToggle(key: keyof typeof LAYER_GROUPS, on: boolean) {
  settings[key] = on;
  save();
  const input = layersSheet.querySelector<HTMLInputElement>(`[data-toggle="${key}"]`);
  if (input) input.checked = on;
  applyToggle(key);
}
layersSheet.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach((input) => {
  const key = input.dataset.toggle as keyof typeof LAYER_GROUPS;
  input.checked = settings[key];
  input.addEventListener('change', () => setToggle(key, input.checked));
});

const exag = $<HTMLInputElement>('#exaggeration');
exag.value = `${settings.exaggeration}`;
$('#exag-val').textContent = `${settings.exaggeration.toFixed(1)}×`;
exag.addEventListener('input', () => {
  settings.exaggeration = +exag.value;
  $('#exag-val').textContent = `${settings.exaggeration.toFixed(1)}×`;
  map.setTerrain({ source: 'dem', exaggeration: settings.exaggeration });
  save();
});

const hd = $<HTMLInputElement>('#hd');
hd.checked = settings.hd;
hd.addEventListener('change', () => {
  settings.hd = hd.checked;
  save();
  // tileSize can't change in place: rebuild the imagery source under the same layer.
  const src = map.getStyle().sources.imagery;
  map.removeLayer('imagery');
  map.removeSource('imagery');
  map.addSource('imagery', { ...src, tileSize: settings.hd ? 128 : 256 } as maplibregl.RasterSourceSpecification);
  map.addLayer({ id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 120, 'raster-resampling': 'linear' } }, 'hillshade');
});

$('#sources').innerHTML =
  'Imagery: ' + IMAGERY.map((p) => esc(p.name)).join(', ') + '. Elevation: ' + DEM_LAYERS.map((l) => esc(l.name)).join(', ') +
  '. Pistes &amp; huts: © OpenStreetMap contributors. Slope angles are computed from elevation data and can miss small terrain features — always check the avalanche forecast.';

// ---------------------------------------------------------------- slope angle filter
const slopePanel = $('#slope-panel');
const slopeMin = $<HTMLInputElement>('#slope-min');
const slopeMax = $<HTMLInputElement>('#slope-max');
const aspectBtn = $('#slope-aspect-btn');
const aspectBox = $('#slope-aspects');
const rose = document.querySelector<SVGSVGElement>('#aspect-rose')!;
const { min: DMIN, max: DMAX } = SLOPE_DOMAIN;
const pct = (deg: number) => ((deg - DMIN) / (DMAX - DMIN)) * 100;
const rgb = (c: [number, number, number]) => `rgb(${c.join(',')})`;

for (const input of [slopeMin, slopeMax]) {
  input.min = `${DMIN}`;
  input.max = `${DMAX}`;
}
// Colour bar: the legend and the slider track in one.
const stops = [{ min: DMIN, color: LOW_SLOPE_COLOR }, ...SLOPE_CLASSES];
$('#slope-track').style.background = `linear-gradient(90deg, ${stops
  .map((c, i) => `${rgb(c.color)} ${pct(c.min)}% ${i + 1 < stops.length ? pct(stops[i + 1].min) : 100}%`)
  .join(', ')})`;
$('#slope-ticks').innerHTML = [20, 30, 40, 50, DMAX]
  .map((d) => `<span style="left:${pct(d)}%">${d === DMAX ? `${d}°+` : `${d}°`}</span>`)
  .join('');

// Compass rose of eight toggleable wedges, north up.
const wedge = (i: number) => {
  const a0 = ((i * 45 - 22.5 - 90) * Math.PI) / 180, a1 = ((i * 45 + 22.5 - 90) * Math.PI) / 180;
  const p = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  return `M${p(17, a0)} L${p(50, a0)} A50 50 0 0 1 ${p(50, a1)} L${p(17, a1)} A17 17 0 0 0 ${p(17, a0)}Z`;
};
rose.innerHTML =
  ASPECTS.map((name, i) => {
    const a = ((i * 45 - 90) * Math.PI) / 180;
    return `<path class="wedge" data-aspect="${i}" d="${wedge(i)}" role="button" aria-label="${name}"></path>
      <text x="${(34 * Math.cos(a)).toFixed(1)}" y="${(34 * Math.sin(a)).toFixed(1)}">${name}</text>`;
  }).join('') + `<circle class="centre" r="15" data-aspect="all" role="button" aria-label="All aspects"></circle><text class="centre-label">All</text>`;

let slopeTimer = 0;
function setSlopeFilter(f: SlopeFilter, immediate = false) {
  settings.slopeFilter = f;
  save();
  syncSlopePanel();
  if (!settings.slope) setToggle('slope', true);
  // Re-rendering is cheap (workers keep slope per tile) but debounce while a handle is dragged.
  clearTimeout(slopeTimer);
  const apply = () => (map.getSource('slope') as RasterTileSource | undefined)?.setTiles([slopeTileUrl(settings.slopeFilter)]);
  if (immediate) apply();
  else slopeTimer = window.setTimeout(apply, 180);
}

function syncSlopePanel() {
  const f = settings.slopeFilter;
  slopePanel.hidden = !settings.slope;
  $('#btn-slope').setAttribute('aria-pressed', `${settings.slope}`);
  slopeMin.value = `${f.min}`;
  slopeMax.value = `${f.max}`;
  slopePanel.querySelector<HTMLElement>('.mask.lo')!.style.width = `${pct(f.min)}%`;
  slopePanel.querySelector<HTMLElement>('.mask.hi')!.style.width = `${100 - pct(f.max)}%`;
  $('#slope-summary').textContent = describeFilter(f);
  slopePanel.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) => {
    const [lo, hi] = b.dataset.preset!.split(',').map(Number);
    b.setAttribute('aria-pressed', `${lo === f.min && hi === f.max}`);
  });
  rose.querySelectorAll<SVGPathElement>('.wedge').forEach((w) => w.classList.toggle('on', !!(f.aspects & (1 << +w.dataset.aspect!))));
  aspectBtn.classList.toggle('on', (f.aspects & ALL_ASPECTS) !== ALL_ASPECTS);
  document.documentElement.style.setProperty('--slope-panel-h', `${slopePanel.hidden ? 0 : slopePanel.offsetHeight}px`);
}

slopeMin.addEventListener('input', () => {
  const v = Math.min(+slopeMin.value, settings.slopeFilter.max);
  setSlopeFilter({ ...settings.slopeFilter, min: v });
});
slopeMax.addEventListener('input', () => {
  const v = Math.max(+slopeMax.value, settings.slopeFilter.min);
  setSlopeFilter({ ...settings.slopeFilter, max: v });
});
slopePanel.querySelectorAll<HTMLElement>('[data-preset]').forEach((b) =>
  b.addEventListener('click', () => {
    const [min, max] = b.dataset.preset!.split(',').map(Number);
    setSlopeFilter({ ...settings.slopeFilter, min, max }, true);
  }),
);
rose.addEventListener('click', (e) => {
  const id = (e.target as Element).getAttribute('data-aspect');
  if (id === null) return;
  const f = settings.slopeFilter;
  const aspects = id === 'all' ? ALL_ASPECTS : f.aspects ^ (1 << +id);
  setSlopeFilter({ ...f, aspects }, true);
});
aspectBtn.addEventListener('click', () => {
  aspectBox.hidden = !aspectBox.hidden;
  aspectBtn.setAttribute('aria-expanded', `${!aspectBox.hidden}`);
  syncSlopePanel();
});
$('#btn-slope').addEventListener('click', () => setToggle('slope', !settings.slope));
$('#slope-close').addEventListener('click', () => setToggle('slope', false));
new ResizeObserver(syncSlopePanel).observe(slopePanel);
syncSlopePanel();

// ---------------------------------------------------------------- camera controls
$('#btn-zoom-in').addEventListener('click', () => map.zoomIn());
$('#btn-zoom-out').addEventListener('click', () => map.zoomOut());
const btn3d = $('#btn-3d');
const sync3d = () => (btn3d.textContent = map.getPitch() > 5 ? '2D' : '3D');
btn3d.addEventListener('click', () => map.easeTo({ pitch: map.getPitch() > 5 ? 0 : 65, duration: 900 }));
const needle = $('#compass-needle');
$('#btn-compass').addEventListener('click', () => map.easeTo({ bearing: 0, duration: 600 }));
map.on('rotate', () => (needle.style.transform = `rotate(${-map.getBearing()}deg)`));
map.on('pitchend', sync3d);
sync3d();
needle.style.transform = `rotate(${-map.getBearing()}deg)`;

let meMarker: maplibregl.Marker | null = null;
$('#btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Location is not available in this browser');
  setStatus('Finding you…', true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStatus(null);
      const ll: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      if (!meMarker) {
        const el = document.createElement('div');
        el.className = 'me-dot';
        meMarker = new maplibregl.Marker({ element: el });
      }
      meMarker.setLngLat(ll).addTo(map);
      map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 14), duration: 2500 });
    },
    (err) => setStatus(`Couldn't get your location (${err.message})`),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

// ---------------------------------------------------------------- info cards
const card = $('#card');
let cardToken = 0;
let hoverMarker: maplibregl.Marker | null = null;
function showHover(at: Position | null) {
  if (!at) return hoverMarker?.remove();
  if (!hoverMarker) {
    const el = document.createElement('div');
    el.className = 'hover-dot';
    hoverMarker = new maplibregl.Marker({ element: el });
  }
  hoverMarker.setLngLat(at as [number, number]).addTo(map);
}
function closeCard() {
  card.hidden = true;
  cardToken++;
  showHover(null);
  pinMarker?.remove();
}
function openCard(html: string) {
  card.innerHTML = html;
  card.hidden = false;
  card.querySelector('[data-close]')?.addEventListener('click', closeCard);
  return ++cardToken;
}
const closeBtn = `<button class="icon-btn" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
const sk = '<i class="skeleton"></i>';

function statsHtml(p: Profile | null, kind: 'piste' | 'lift' | 'route') {
  if (!p) return `<p class="muted">No elevation data here.</p>`;
  const cells =
    kind === 'route'
      ? [
          [fmtDist(p.length), 'Distance'],
          [`↑ ${fmtEle(p.ascent)}`, 'Ascent'],
          [`↓ ${fmtEle(p.descent)}`, 'Descent'],
          [fmtEle(p.max), 'Highest'],
          [`${Math.round(p.steepest)}°`, 'Max slope'],
          [tourTime(p), 'Est. time'],
        ]
      : [
          [fmtDist(p.length), 'Length'],
          [fmtEle(p.max - p.min), kind === 'lift' ? 'Rise' : 'Vertical'],
          [kind === 'lift' ? fmtEle(p.max) : `${Math.round(p.steepest)}°`, kind === 'lift' ? 'Top' : 'Max slope'],
          [fmtEle(p.max), 'Top'],
          [fmtEle(p.min), 'Bottom'],
          [`${Math.round((Math.atan((p.max - p.min) / p.length) * 180) / Math.PI)}°`, 'Avg. pitch'],
        ];
  if (kind === 'lift') cells.splice(2, 1);
  const stats = `<div class="stats">${cells.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
  return kind === 'lift' ? stats : stats + slopeMixHtml(p);
}

/** How much of the line crosses each slope class, as a bar plus the 30°+ / 35°+ distances. */
function slopeMixHtml(p: Profile) {
  const bands = distanceBySlope(p, SLOPE_CLASSES.map((c) => c.min));
  const colors = [[176, 188, 202], ...SLOPE_CLASSES.map((c) => c.color)]; // neutral below 27°, as in the profile
  const labels = ['under 27°', ...SLOPE_CLASSES.map((c) => c.label)];
  const over = (deg: number) => bands.reduce((a, d, i) => a + (i > 0 && SLOPE_CLASSES[i - 1].min >= deg ? d : 0), 0);
  const d30 = over(30), d35 = over(35);
  const text = d30 < 1
    ? 'No terrain of 30° or steeper on this line'
    : `30°+ for ${fmtDist(d30)} (${Math.round((d30 / p.length) * 100)}%)` + (d35 >= 1 ? ` · 35°+ for ${fmtDist(d35)}` : '');
  const bar = bands
    .map((d, i) => (d > 0 ? `<i style="flex:${d.toFixed(1)};background:rgb(${colors[i].join(',')})" title="${labels[i]}: ${fmtDist(d)}"></i>` : ''))
    .join('');
  return `<div class="slope-mix" aria-label="Distance by slope angle">${bar}</div><div class="slope-mix-text">${text}</div>`;
}

/** Ski-touring time: 4 km/h on the flat, 400 m/h up, 1500 m/h down (Swiss/DAV rule of thumb). */
function tourTime(p: Profile) {
  const th = p.length / 4000;
  const tv = p.ascent / 400 + p.descent / 1500;
  const h = Math.max(th, tv) + Math.min(th, tv) / 2;
  const mins = Math.max(5, Math.round((h * 60) / 5) * 5); // round the total, so 3 h 58 becomes 4h 00, not 3h 60
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return hh ? `${hh}h ${String(mm).padStart(2, '0')}` : `${mm} min`;
}

const LIFT_NAMES: Record<string, string> = {
  cable_car: 'Cable car', gondola: 'Gondola', chair_lift: 'Chairlift', drag_lift: 'Drag lift', 't-bar': 'T-bar',
  'j-bar': 'J-bar', platter: 'Platter lift', rope_tow: 'Rope tow', magic_carpet: 'Magic carpet', mixed_lift: 'Mixed lift',
};
const PISTE_TYPES: Record<string, string> = {
  downhill: 'Piste', skitour: 'Ski-touring route', nordic: 'Cross-country trail', sled: 'Sledge run', hike: 'Winter hiking trail',
};

function longestLine(f: Feature): Position[] {
  const g = f.geometry as LineString | MultiLineString;
  if (g.type === 'LineString') return g.coordinates;
  if (g.type === 'MultiLineString') {
    let best: Position[] = [];
    let bestLen = -1;
    for (const part of g.coordinates) {
      let len = 0;
      for (let i = 1; i < part.length; i++) len += distance(part[i - 1], part[i]);
      if (len > bestLen) (bestLen = len), (best = part);
    }
    return best;
  }
  return [];
}

async function showFeature(f: MapGeoJSONFeature) {
  const p = f.properties as Record<string, string>;
  // Query results are clipped to tiles; use the full feature from the source when we can.
  const full = ((map.getSource('osm') as GeoJSONSource).serialize().data as GeoJSON.FeatureCollection | undefined)?.features?.find(
    (x) => x.id === f.id || x.properties?.osm === p.osm,
  );
  const feature: Feature = full ?? (f as unknown as Feature);
  if (p.kind === 'hut') {
    openCard(`<div class="card-head"><div class="grow"><span class="chip" style="--c:#b5462a">${p.hut === 'alpine_hut' ? 'Mountain hut' : 'Shelter'}</span>
      <h2 style="margin-top:8px">${esc(p.name || 'Unnamed hut')}</h2>${p.ele ? `<div class="sub">${esc(p.ele)} m</div>` : ''}</div>${closeBtn}</div>
      <div class="actions"><a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/${p.osm[0] === 'n' ? 'node' : 'way'}/${p.osm.slice(1)}">View on OpenStreetMap</a></div>`);
    return;
  }
  const isLift = p.kind === 'lift';
  const color = isLift ? '#1b1d22' : p.piste === 'skitour' ? '#7b2fd0' : p.piste === 'nordic' ? '#0e8a8a' : DIFFICULTY_COLORS[p.difficulty] ?? '#777';
  const chip = isLift ? LIFT_NAMES[p.lift] ?? 'Lift' : p.piste === 'downhill' ? DIFFICULTY_LABELS[p.difficulty] ?? 'Piste' : PISTE_TYPES[p.piste] ?? 'Route';
  const title = p.name || (isLift ? 'Unnamed lift' : 'Unnamed ' + (PISTE_TYPES[p.piste] ?? 'piste').toLowerCase());
  const sub = isLift ? '' : [p.piste === 'downhill' ? 'Piste' : '', p.grooming ? `Grooming: ${p.grooming.replace(/_/g, ' ')}` : ''].filter(Boolean).join(' · ');
  const token = openCard(`<div class="card-head"><div class="grow"><span class="chip" style="--c:${color}">${esc(chip)}</span>
    <h2 style="margin-top:8px">${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${closeBtn}</div>
    <div class="stats">${`<div class="stat"><b>${sk}</b><span>&nbsp;</span></div>`.repeat(3)}</div><div class="profile"></div>`);
  const line = longestLine(feature);
  if (line.length < 2) return;
  const prof = await profile(line);
  if (token !== cardToken) return;
  card.querySelector('.stats')!.outerHTML = statsHtml(prof, isLift ? 'lift' : 'piste');
  if (prof) renderProfile(card.querySelector('.profile')!, prof, (i) => showHover(i === null ? null : prof.points[i].at));
}

let pinMarker: maplibregl.Marker | null = null;
async function showPoint(lngLat: maplibregl.LngLat) {
  if (!pinMarker) {
    const el = document.createElement('div');
    el.className = 'hover-dot';
    pinMarker = new maplibregl.Marker({ element: el });
  }
  pinMarker.setLngLat(lngLat).addTo(map);
  const token = openCard(`<div class="card-head"><div class="grow"><h2>${sk}</h2><div class="sub">${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}</div></div>${closeBtn}</div>`);
  const info = await call<{ elevation: number; slope: number; aspect: number } | null>('pointInfo', [lngLat.lng, lngLat.lat]).catch(() => null);
  if (token !== cardToken) return;
  if (!info) {
    card.querySelector('h2')!.textContent = 'No elevation data';
    return;
  }
  const cls = [...SLOPE_CLASSES].reverse().find((c) => info.slope >= c.min);
  const rose = `<div class="aspect-rose" title="Slope faces ${aspectName(info.aspect)}"><svg viewBox="-22 -22 44 44">
    <circle r="20" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="1.5"/>
    <text y="-12" text-anchor="middle" font-size="8" fill="currentColor" stroke="none" font-weight="700">N</text>
    <path d="M0 0 L0 -15" stroke="${cls ? `rgb(${cls.color.join(',')})` : 'currentColor'}" stroke-width="3.5" transform="rotate(${info.aspect})"/>
    <circle r="2.5" fill="currentColor" stroke="none"/></svg></div>`;
  card.innerHTML = `<div class="card-head"><div class="grow"><h2>${fmtEle(info.elevation)}</h2>
      <div class="sub">${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}</div></div>${rose}${closeBtn}</div>
    <div class="stats">
      <div class="stat"><b>${Math.round(info.slope)}°</b><span>Slope</span></div>
      <div class="stat"><b>${aspectName(info.aspect)}</b><span>Aspect</span></div>
      <div class="stat"><b>${cls ? `<span class="chip" style="--c:rgb(${cls.color.join(',')});color:${cls.min >= 40 ? '#fff' : '#111'}">${cls.label}</span>` : '&lt; 27°'}</b><span>Class</span></div>
    </div>
    <div class="actions">
      <button class="btn primary" data-route-start>Plan route from here</button>
      <a class="btn" href="${region.avalanche.url}" target="_blank" rel="noopener">Avalanche forecast</a>
    </div>`;
  card.querySelector('[data-close]')!.addEventListener('click', closeCard);
  card.querySelector('[data-route-start]')!.addEventListener('click', () => {
    closeCard();
    startRoute([lngLat.lng, lngLat.lat]);
  });
}

// ---------------------------------------------------------------- route planner
let routeMode = false;
let routePts: Position[] = [];
const btnRoute = $('#btn-route');
function setRouteData() {
  const features: Feature[] = routePts.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
  if (routePts.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routePts } });
  (map.getSource('route') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
}
async function renderRoute() {
  setRouteData();
  const token = openCard(`<div class="card-head"><div class="grow"><span class="chip" style="--c:var(--danger)">Route</span>
      <h2 style="margin-top:8px">${routePts.length < 2 ? 'Tap the map to add points' : 'Your route'}</h2></div>${closeBtn}</div>
    <div class="route-body">${routePts.length > 1 ? `<div class="stats">${`<div class="stat"><b>${sk}</b><span>&nbsp;</span></div>`.repeat(3)}</div>` : '<p class="muted">Click along your line — up the skin track and down the descent. Stats, steepness and time update as you go.</p>'}</div>
    <div class="profile"></div>
    <div class="actions">
      <button class="btn" data-undo ${routePts.length ? '' : 'disabled'}>Undo</button>
      <button class="btn" data-clear ${routePts.length ? '' : 'disabled'}>Clear</button>
      <button class="btn" data-gpx ${routePts.length > 1 ? '' : 'disabled'}>GPX</button>
      <button class="btn primary" data-done>Done</button>
    </div>`);
  card.querySelector('[data-close]')!.addEventListener('click', stopRoute);
  card.querySelector('[data-done]')!.addEventListener('click', () => {
    routeMode = false;
    document.body.classList.remove('route-mode');
    btnRoute.setAttribute('aria-pressed', 'false');
    card.querySelector('[data-done]')?.remove();
  });
  card.querySelector('[data-undo]')!.addEventListener('click', () => {
    routePts.pop();
    renderRoute();
  });
  card.querySelector('[data-clear]')!.addEventListener('click', () => {
    routePts = [];
    renderRoute();
  });
  card.querySelector('[data-gpx]')!.addEventListener('click', exportGpx);
  if (routePts.length < 2) return;
  const prof = await profile(routePts);
  if (token !== cardToken) return;
  card.querySelector('.route-body')!.innerHTML = statsHtml(prof, 'route');
  if (prof) renderProfile(card.querySelector('.profile')!, prof, (i) => showHover(i === null ? null : prof.points[i].at));
}
function startRoute(first?: Position) {
  routeMode = true;
  routePts = first ? [first] : routePts;
  document.body.classList.add('route-mode');
  btnRoute.setAttribute('aria-pressed', 'true');
  renderRoute();
}
function stopRoute() {
  routeMode = false;
  routePts = [];
  document.body.classList.remove('route-mode');
  btnRoute.setAttribute('aria-pressed', 'false');
  setRouteData();
  closeCard();
}
btnRoute.addEventListener('click', () => (routeMode ? stopRoute() : startRoute()));

async function exportGpx() {
  const hs = await call<(number | null)[]>('elevations', [routePts]);
  const pts = routePts
    .map((c, i) => `<trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${hs[i] !== null ? `<ele>${hs[i]!.toFixed(1)}</ele>` : ''}</trkpt>`)
    .join('\n      ');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Skimap" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Skimap route</name><trkseg>
      ${pts}
  </trkseg></trk>
</gpx>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = 'skimap-route.gpx';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- map clicks
const CLICKABLE = ['piste-line', 'skitour-line', 'nordic-line', 'lift-line', 'hut', 'piste-area'];
map.on('click', (e) => {
  regionMenu.hidden = true;
  if (routeMode) {
    routePts.push([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]);
    renderRoute();
    return;
  }
  if (!card.hidden && routePts.length) return; // keep a finished route's card until closed
  const pad = 8;
  const hits = settings.pistes
    ? map.queryRenderedFeatures(
        [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]],
        { layers: CLICKABLE.filter((id) => map.getLayer(id)) },
      )
    : [];
  // Prefer lifts & lines over piste areas.
  hits.sort((a, b) => Number(a.layer.id === 'piste-area') - Number(b.layer.id === 'piste-area'));
  if (hits.length) showFeature(hits[0]);
  else showPoint(e.lngLat);
});
for (const id of CLICKABLE) {
  map.on('mouseenter', id, () => !routeMode && (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
}

// ---------------------------------------------------------------- cursor readout (desktop)
const readout = $('#readout');
let readoutBusy = false;
let readoutNext: maplibregl.LngLat | null = null;
async function updateReadout(ll: maplibregl.LngLat) {
  if (readoutBusy) {
    readoutNext = ll;
    return;
  }
  readoutBusy = true;
  const info = await call<{ elevation: number; slope: number; aspect: number } | null>('pointInfo', [ll.lng, ll.lat]).catch(() => null);
  readoutBusy = false;
  if (info) {
    readout.textContent = `${fmtEle(info.elevation)} · ${Math.round(info.slope)}° ${aspectName(info.aspect)}`;
    readout.hidden = false;
  }
  if (readoutNext) {
    const n = readoutNext;
    readoutNext = null;
    updateReadout(n);
  }
}
if (matchMedia('(pointer: fine)').matches) {
  map.on('mousemove', (e) => updateReadout(e.lngLat));
  map.getCanvas().addEventListener('mouseleave', () => (readout.hidden = true));
}

// ---------------------------------------------------------------- first-run hint
const hint = $('#hint');
try {
  if (!localStorage.getItem('skimap:hinted')) {
    hint.textContent = matchMedia('(pointer: coarse)').matches
      ? 'Two fingers to tilt & rotate · tap anywhere for slope & elevation'
      : 'Right-drag or Ctrl+drag to tilt & rotate · click anywhere for slope & elevation';
    hint.hidden = false;
    setTimeout(() => (hint.hidden = true), 7000);
    localStorage.setItem('skimap:hinted', '1');
  }
} catch {
  /* ignore */
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (routeMode) stopRoute();
    else closeCard();
    layersSheet.hidden = true;
    regionMenu.hidden = true;
  }
});

// Handy when debugging from the console.
Object.assign(window, { map, skimapCall: call });
