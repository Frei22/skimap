import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { DEM_LAYERS, DEM_MAXZOOM, GLYPHS, IMAGERY, IMAGERY_MAXZOOM, LABELS_TILEJSON, TERRAIN_MAXZOOM } from './config';
import { DEM_PROTOCOL, IMAGERY_PROTOCOL } from './protocols';
import { slopeTileUrl, type SlopeFilter } from './slope-filter';

/**
 * With only the global DEM, MapLibre loads it directly (fastest path). With a regional high-res
 * DEM configured, tiles go through our protocol, which merges the layers.
 */
const direct = DEM_LAYERS.length === 1 && DEM_LAYERS[0].encoding !== 'bil32' ? DEM_LAYERS[0] : null;
const demSource = {
  type: 'raster-dem' as const,
  tiles: direct ? [direct.url].flat() : [`${DEM_PROTOCOL}://{z}/{x}/{y}`],
  tileSize: 256,
  maxzoom: Math.min(DEM_MAXZOOM, TERRAIN_MAXZOOM),
  encoding: direct ? (direct.encoding as 'terrarium' | 'mapbox') : ('terrarium' as const),
};

export const DIFFICULTY_COLORS: Record<string, string> = {
  novice: '#22a45d',
  easy: '#2468d8',
  intermediate: '#e0312b',
  advanced: '#121212',
  expert: '#121212',
  extreme: '#121212',
  freeride: '#f07f1a',
  unknown: '#7a7f88',
};

export const DIFFICULTY_LABELS: Record<string, string> = {
  novice: 'Green',
  easy: 'Blue',
  intermediate: 'Red',
  advanced: 'Black',
  expert: 'Expert',
  extreme: 'Extreme',
  freeride: 'Freeride / itinerary',
  unknown: 'Unknown difficulty',
};

const difficultyColor: ExpressionSpecification = [
  'match', ['get', 'difficulty'],
  ...Object.entries(DIFFICULTY_COLORS).flatMap(([k, v]) => [k, v]),
  DIFFICULTY_COLORS.unknown,
] as unknown as ExpressionSpecification;

const lineWidth = (base: number): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.5], ['zoom'], 10, base * 0.9, 12, base * 1.4, 14, base * 2.2, 16, base * 3.6, 18, base * 6]

const LINES: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
const POLYS: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const FONT_ITALIC = ['Noto Sans Italic'];
const NAME: ExpressionSpecification = ['coalesce', ['get', 'name:latin'], ['get', 'name']];

export type Toggles = {
  winter: boolean;
  slope: boolean;
  pistes: boolean;
  contours: boolean;
  labels: boolean;
  hillshade: boolean;
};

/** Which style layers each toggle controls. */
export const LAYER_GROUPS: Record<Exclude<keyof Toggles, 'winter'>, string[]> = {
  slope: ['slope'],
  pistes: [
    'piste-area', 'piste-casing', 'piste-line', 'skitour-line', 'nordic-line', 'lift-casing', 'lift-line',
    'station', 'piste-label', 'lift-label', 'hut', 'hut-label',
  ],
  contours: ['contour-minor', 'contour-major', 'contour-label'],
  labels: ['place-label', 'peak-label', 'water-label'],
  hillshade: ['hillshade'],
};

export function imageryTiles(winter: boolean) {
  return [`${IMAGERY_PROTOCOL}://{z}/{x}/{y}?mode=${winter ? 'winter' : 'summer'}`];
}

export function buildStyle(
  t: Toggles, contourTiles: string, imageryTileSize: number, exaggeration: number, slopeFilter: SlopeFilter,
): StyleSpecification {
  const vis = (on: boolean) => ({ visibility: on ? ('visible' as const) : ('none' as const) });
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': '#dfe6ee' } },
    {
      id: 'imagery', type: 'raster', source: 'imagery',
      paint: { 'raster-fade-duration': 120, 'raster-resampling': 'linear' },
    },
    {
      id: 'hillshade', type: 'hillshade', source: 'dem-hillshade', layout: vis(t.hillshade),
      paint: {
        'hillshade-exaggeration': 0.35,
        'hillshade-shadow-color': '#2b3a55',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#2b3a55',
      },
    },
    {
      id: 'slope', type: 'raster', source: 'slope', layout: vis(t.slope),
      paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.62, 15, 0.5], 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
    },
    {
      id: 'contour-minor', type: 'line', source: 'contours', 'source-layer': 'contours', layout: vis(t.contours),
      filter: ['!=', ['get', 'level'], 1],
      paint: { 'line-color': 'rgba(70,60,50,0.38)', 'line-width': 0.6 },
    },
    {
      id: 'contour-major', type: 'line', source: 'contours', 'source-layer': 'contours', layout: vis(t.contours),
      filter: ['==', ['get', 'level'], 1],
      paint: { 'line-color': 'rgba(70,55,40,0.6)', 'line-width': 1.1 },
    },
    {
      id: 'contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours',
      filter: ['==', ['get', 'level'], 1],
      layout: {
        ...vis(t.contours), 'symbol-placement': 'line', 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'],
        'text-font': FONT, 'text-size': 10, 'text-max-angle': 25, 'symbol-spacing': 400,
      },
      paint: { 'text-color': 'rgba(60,45,30,0.9)', 'text-halo-color': 'rgba(255,255,255,0.75)', 'text-halo-width': 1.2 },
    },
    // --- Pistes & lifts --------------------------------------------------------------------
    {
      id: 'piste-area', type: 'fill', source: 'osm', layout: vis(t.pistes),
      filter: ['all', ['==', ['get', 'kind'], 'piste'], ['==', ['get', 'piste'], 'downhill'], POLYS],
      paint: { 'fill-color': difficultyColor, 'fill-opacity': 0.12 },
    },
    {
      id: 'piste-casing', type: 'line', source: 'osm', layout: { ...vis(t.pistes), 'line-cap': 'round', 'line-join': 'round' },
      filter: ['all', ['==', ['get', 'kind'], 'piste'], ['==', ['get', 'piste'], 'downhill'], LINES],
      paint: { 'line-color': 'rgba(255,255,255,0.85)', 'line-width': lineWidth(2.5), 'line-blur': 0.5 },
    },
    {
      id: 'piste-line', type: 'line', source: 'osm', layout: { ...vis(t.pistes), 'line-cap': 'round', 'line-join': 'round' },
      filter: ['all', ['==', ['get', 'kind'], 'piste'], ['==', ['get', 'piste'], 'downhill'], LINES],
      paint: {
        'line-color': difficultyColor,
        'line-width': lineWidth(1.5),
        'line-dasharray': ['match', ['get', 'difficulty'], ['freeride', 'expert', 'extreme'], ['literal', [2, 1.4]], ['literal', [1, 0]]],
      },
    },
    {
      id: 'skitour-line', type: 'line', source: 'osm', layout: { ...vis(t.pistes), 'line-cap': 'round', 'line-join': 'round' },
      filter: ['all', ['==', ['get', 'kind'], 'piste'], ['==', ['get', 'piste'], 'skitour'], LINES],
      paint: { 'line-color': '#7b2fd0', 'line-width': lineWidth(1.3), 'line-dasharray': [2.5, 1.5] },
    },
    {
      id: 'nordic-line', type: 'line', source: 'osm', layout: { ...vis(t.pistes), 'line-cap': 'round' },
      minzoom: 12,
      filter: ['all', ['==', ['get', 'kind'], 'piste'], ['in', ['get', 'piste'], ['literal', ['nordic', 'sled']]]],
      paint: { 'line-color': '#0e8a8a', 'line-width': lineWidth(1), 'line-dasharray': [0.6, 1.4] },
    },
    {
      id: 'lift-casing', type: 'line', source: 'osm', layout: { ...vis(t.pistes), 'line-cap': 'round' },
      filter: ['==', ['get', 'kind'], 'lift'],
      paint: { 'line-color': 'rgba(255,255,255,0.9)', 'line-width': lineWidth(2.2) },
    },
    {
      id: 'lift-line', type: 'line', source: 'osm', layout: { ...vis(t.pistes), 'line-cap': 'round' },
      filter: ['==', ['get', 'kind'], 'lift'],
      paint: {
        'line-color': '#1b1d22',
        'line-width': lineWidth(1),
        'line-dasharray': ['match', ['get', 'lift'], ['drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet'], ['literal', [3, 1.5]], ['literal', [1, 0]]],
      },
    },
    {
      id: 'station', type: 'circle', source: 'osm', minzoom: 13, layout: vis(t.pistes),
      filter: ['==', ['get', 'kind'], 'station'],
      paint: { 'circle-radius': 3.5, 'circle-color': '#fff', 'circle-stroke-color': '#1b1d22', 'circle-stroke-width': 1.5 },
    },
    {
      id: 'hut', type: 'circle', source: 'osm', minzoom: 11, layout: vis(t.pistes),
      filter: ['==', ['get', 'kind'], 'hut'],
      paint: { 'circle-radius': 5, 'circle-color': '#b5462a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
    },
    {
      id: 'hut-label', type: 'symbol', source: 'osm', minzoom: 12.5,
      filter: ['==', ['get', 'kind'], 'hut'],
      layout: {
        ...vis(t.pistes), 'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': 11,
        'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true,
      },
      paint: { 'text-color': '#6b2410', 'text-halo-color': '#fff', 'text-halo-width': 1.4 },
    },
    {
      id: 'piste-label', type: 'symbol', source: 'osm', minzoom: 13,
      filter: ['all', ['==', ['get', 'kind'], 'piste'], ['!=', ['get', 'name'], '']],
      layout: {
        ...vis(t.pistes), 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT_BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10.5, 17, 14], 'text-max-angle': 30, 'symbol-spacing': 350,
      },
      paint: {
        'text-color': ['match', ['get', 'piste'], 'skitour', '#5a1fa0', 'nordic', '#0a6464', difficultyColor],
        'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.6,
      },
    },
    {
      id: 'lift-label', type: 'symbol', source: 'osm', minzoom: 13.5,
      filter: ['all', ['==', ['get', 'kind'], 'lift'], ['!=', ['get', 'name'], '']],
      layout: {
        ...vis(t.pistes), 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT_ITALIC,
        'text-size': 11, 'text-max-angle': 30, 'symbol-spacing': 400, 'text-offset': [0, -0.8],
      },
      paint: { 'text-color': '#1b1d22', 'text-halo-color': 'rgba(255,255,255,0.95)', 'text-halo-width': 1.4 },
    },
    // --- Route planner ---------------------------------------------------------------------
    {
      id: 'route-casing', type: 'line', source: 'route', filter: LINES,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8] },
    },
    {
      id: 'route-line', type: 'line', source: 'route', filter: LINES,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ff3b6b', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 4.5] },
    },
    {
      id: 'route-points', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5.5, 'circle-color': '#ff3b6b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
    },
    // --- Names -----------------------------------------------------------------------------
    {
      id: 'water-label', type: 'symbol', source: 'labels', 'source-layer': 'water_name', minzoom: 11,
      layout: { ...vis(t.labels), 'text-field': NAME, 'text-font': FONT_ITALIC, 'text-size': 11 },
      paint: { 'text-color': '#1c4e80', 'text-halo-color': 'rgba(255,255,255,0.8)', 'text-halo-width': 1.2 },
    },
    {
      id: 'peak-label', type: 'symbol', source: 'labels', 'source-layer': 'mountain_peak', minzoom: 10,
      filter: ['in', ['get', 'class'], ['literal', ['peak', 'volcano']]],
      layout: {
        ...vis(t.labels),
        'text-field': ['format', '▲ ', { 'font-scale': 0.7 }, NAME, {}, ['case', ['has', 'ele'], ['concat', '\n', ['to-string', ['get', 'ele']], ' m'], ''], { 'font-scale': 0.8 }],
        'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 13],
        'text-anchor': 'bottom', 'text-max-width': 8, 'symbol-sort-key': ['-', 0, ['coalesce', ['get', 'ele'], 0]],
      },
      paint: { 'text-color': '#2a2018', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5 },
    },
    {
      id: 'place-label', type: 'symbol', source: 'labels', 'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'hamlet', 'suburb', 'locality']]],
      layout: {
        ...vis(t.labels), 'text-field': NAME, 'text-font': FONT_BOLD,
        'text-size': ['match', ['get', 'class'], ['city', 'town'], 15, 'village', 13, 11],
        'symbol-sort-key': ['match', ['get', 'class'], 'city', 0, 'town', 1, 'village', 2, 3],
      },
      paint: { 'text-color': '#16181d', 'text-halo-color': 'rgba(255,255,255,0.92)', 'text-halo-width': 1.8 },
    },
  ];

  const imageryAttribution = IMAGERY.map((p) => p.attribution).join(' · ');
  return {
    version: 8,
    glyphs: GLYPHS,
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#7fb0e6',
      'horizon-color': '#dbe8f6',
      'fog-color': '#e9f0f8',
      'fog-ground-blend': 0.75,
      'horizon-fog-blend': 0.6,
      'sky-horizon-blend': 0.7,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 8, 1, 11, 0],
    },
    terrain: { source: 'dem', exaggeration },
    sources: {
      imagery: {
        type: 'raster', tiles: imageryTiles(t.winter), tileSize: imageryTileSize, maxzoom: IMAGERY_MAXZOOM,
        attribution: imageryAttribution,
      },
      dem: { ...demSource, attribution: DEM_LAYERS.map((l) => l.attribution).join(' · ') },
      'dem-hillshade': demSource,
      slope: { type: 'raster', tiles: [slopeTileUrl(slopeFilter)], tileSize: 256, minzoom: 8, maxzoom: DEM_MAXZOOM + 1 },
      contours: { type: 'vector', tiles: [contourTiles], maxzoom: 15, minzoom: 10 },
      labels: {
        type: 'vector', url: LABELS_TILEJSON,
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a>',
      },
      osm: {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
      },
      route: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers,
  };
}
