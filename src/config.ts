// Data sources. Everything here is free to use; see DATA.md for licences and how to add better data.

export type DemEncoding = 'terrarium' | 'mapbox' | 'bil32';

export type DemLayer = {
  name: string;
  /**
   * Tile URL template(s): XYZ (`{z}/{x}/{y}`), WMS (`{bbox-epsg-3857}`) or `pmtiles://https://…`.
   * Several templates for the same data are used round-robin (more parallel downloads).
   */
  url: string | string[];
  /** terrarium/mapbox: RGB-encoded PNG. bil32: raw little-endian float32 grid (IGN WMS). */
  encoding: DemEncoding;
  /**
   * 'geographic': the service stores a lat/lon grid with square-degree pixels and resamples
   * anything else with nearest-neighbour (duplicated rows → striped slopes). We request that
   * native grid ({bbox-epsg-4326}, {width}, {height}) and reproject it in the browser instead.
   */
  grid?: 'mercator' | 'geographic';
  minzoom: number;
  maxzoom: number;
  /**
   * True ground resolution of the data in metres. Tiles are often served at a finer zoom than
   * the data (Mapzen's 25 m EU-DEM is linearly interpolated up to z14); reading them at their
   * real resolution and upsampling smoothly avoids striped slope & snow shading.
   */
  resolution?: number;
  bounds?: [number, number, number, number];
  attribution: string;
};

// Also loaded by Node scripts (scripts/*.ts), where import.meta.env doesn't exist.
const env: Record<string, string | undefined> = import.meta.env ?? {};

/**
 * Elevation layers, best first. The last one must cover the whole world.
 * More regional layers (e.g. a Lantmäteriet 1 m DEM for Sweden built with scripts/build-dem.sh)
 * can be prepended via VITE_DEM_LAYERS (JSON array of DemLayer).
 */
export const DEM_LAYERS: DemLayer[] = [
  ...(env.VITE_DEM_LAYERS ? (JSON.parse(env.VITE_DEM_LAYERS) as DemLayer[]) : []),
  ...(env.VITE_IGN_DEM === 'off'
    ? []
    : [
        {
          // LiDAR HD terrain model (~1 m) where flown, RGE ALTI elsewhere in France.
          name: 'IGN LiDAR HD / RGE ALTI',
          url: 'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G&STYLES=&CRS=EPSG:4326&BBOX={bbox-epsg-4326}&WIDTH={width}&HEIGHT={height}&FORMAT=image/x-bil;bits=32',
          encoding: 'bil32' as const,
          grid: 'geographic' as const,
          // Below z14 IGN has to shrink 1 m data on the fly (10+ s per request); the 25 m global
          // model is as good there. z16 (~1.7 m) is enough for the ~3 m slope/shading baseline.
          minzoom: 14,
          maxzoom: 16,
          resolution: 1,
          bounds: [-5.2, 41.3, 9.6, 51.1] as [number, number, number, number],
          attribution: '<a href="https://geoservices.ign.fr/lidarhd" target="_blank">Elevation: IGN LiDAR HD, RGE ALTI</a>',
        },
      ]),
  {
    name: 'Mapzen Terrain Tiles (AWS Open Data)',
    url: [
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
      'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png',
    ],
    encoding: 'terrarium',
    minzoom: 0,
    maxzoom: 14,
    resolution: 25, // EU-DEM in Europe; SRTM (30 m) elsewhere
    attribution:
      '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank">Terrain: Mapzen, EU-DEM, SRTM</a>',
  },
];

/** Highest zoom any elevation layer serves. */
export const DEM_MAXZOOM = Math.max(...DEM_LAYERS.map((l) => l.maxzoom));

/** 3D terrain mesh detail stops here; beyond it, more DEM detail only feeds slope & snow shading. */
export const TERRAIN_MAXZOOM = 15;

export type ImageryProvider = {
  id: string;
  name: string;
  url: string;
  minzoom: number;
  /** Highest zoom the provider serves; above that we crop & upscale its tiles. */
  maxzoom: number;
  bounds?: [number, number, number, number];
  /** Provider paints areas outside its coverage pure white (rather than transparent). */
  whiteIsNoData?: boolean;
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
    whiteIsNoData: true,
    attribution: '<a href="https://geoservices.ign.fr/" target="_blank">© IGN</a>',
  },
  {
    id: 'swisstopo',
    name: 'swisstopo SWISSIMAGE 10 cm',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    minzoom: 9,
    maxzoom: 19,
    bounds: [5.95, 45.81, 10.5, 47.81],
    whiteIsNoData: true,
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
  'https://overpass.kumi.systems/api/interpreter',
];
