// Data sources. Everything here is free to use; see DATA.md for licences and how to add better data.

export type DemEncoding = 'terrarium' | 'mapbox';

export type DemLayer = {
  name: string;
  /** XYZ template (`https://…/{z}/{x}/{y}.png`) or `pmtiles://https://…/file.pmtiles` */
  url: string;
  encoding: DemEncoding;
  minzoom: number;
  maxzoom: number;
  bounds?: [number, number, number, number];
  attribution: string;
};

const env = import.meta.env;

/**
 * Elevation layers, best first. The last one must cover the whole world.
 * A high-resolution regional DEM (e.g. IGN RGE ALTI 1 m for Chamonix, built with
 * scripts/build-dem.sh) can be prepended via VITE_DEM_LAYERS (JSON array of DemLayer).
 */
export const DEM_LAYERS: DemLayer[] = [
  ...(env.VITE_DEM_LAYERS ? (JSON.parse(env.VITE_DEM_LAYERS) as DemLayer[]) : []),
  {
    name: 'Mapzen Terrain Tiles (AWS Open Data)',
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    minzoom: 0,
    maxzoom: 14,
    attribution:
      '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Terrain: Mapzen, EU-DEM, SRTM</a>',
  },
];

export type ImageryProvider = {
  id: string;
  name: string;
  url: string;
  minzoom: number;
  /** Highest zoom the provider serves; above that we crop & upscale its tiles. */
  maxzoom: number;
  bounds?: [number, number, number, number];
  attribution: string;
};

/**
 * Orthophoto providers, tried in order for every tile (the first one that has real pixels wins).
 * National mapping agencies have far sharper imagery than global mosaics, so they come first.
 */
export const IMAGERY: ImageryProvider[] = [
  {
    id: 'ign',
    name: 'IGN France — BD ORTHO 20 cm',
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    minzoom: 9,
    maxzoom: 19,
    bounds: [-5.2, 41.3, 9.6, 51.1],
    attribution: '<a href="https://geoservices.ign.fr/" target="_blank">© IGN</a>',
  },
  {
    id: 'swisstopo',
    name: 'swisstopo SWISSIMAGE 10 cm',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    minzoom: 9,
    maxzoom: 19,
    bounds: [5.95, 45.81, 10.5, 47.81],
    attribution: '<a href="https://www.swisstopo.admin.ch/" target="_blank">© swisstopo</a>',
  },
  ...(env.VITE_SE_ORTHO_URL
    ? [
        {
          id: 'lantmateriet',
          name: 'Lantmäteriet Ortofoto',
          url: env.VITE_SE_ORTHO_URL as string,
          minzoom: 6,
          maxzoom: 19,
          bounds: [10.9, 55.3, 24.2, 69.1] as [number, number, number, number],
          attribution: '<a href="https://www.lantmateriet.se/" target="_blank">© Lantmäteriet</a>',
        },
      ]
    : []),
  {
    id: 'esri',
    name: 'Esri World Imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minzoom: 0,
    maxzoom: 18,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
];

export const IMAGERY_MAXZOOM = 19;

/** Vector basemap used only for place names, peaks and lakes (free, no key). */
export const LABELS_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
