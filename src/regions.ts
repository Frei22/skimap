export type Region = {
  id: string;
  name: string;
  /** Shown under the name in the region picker. */
  subtitle: string;
  country: string;
  /** [west, south, east, north] — area we fetch pistes/lifts for */
  bbox: [number, number, number, number];
  camera: { center: [number, number]; zoom: number; pitch: number; bearing: number };
  /** Elevation (m) where the winter filter starts painting snow on open ground. */
  snowline: number;
  /** Upper limit of forest (m): below it, dark pixels in the photo are taken to be trees. */
  treeline: number;
  /** Conifers stay dark in winter; leafless mountain birch lets the snow show through. */
  forest: 'conifer' | 'birch';
  avalanche: { name: string; url: string };
};

export const REGIONS: Region[] = [
  {
    id: 'chamonix',
    name: 'Chamonix Mont-Blanc',
    subtitle: 'Alps · France',
    country: 'FR',
    bbox: [6.74, 45.8, 7.06, 46.06],
    camera: { center: [6.885, 45.885], zoom: 12.6, pitch: 68, bearing: 155 },
    snowline: 750,
    treeline: 2100,
    forest: 'conifer',
    avalanche: { name: 'Météo-France BRA', url: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche' },
  },
  {
    id: 'riksgransen',
    name: 'Riksgränsen',
    subtitle: 'Lapland · Sweden',
    country: 'SE',
    bbox: [17.98, 68.36, 18.36, 68.5],
    camera: { center: [18.108, 68.418], zoom: 13.2, pitch: 62, bearing: 205 }, // from the lake towards Nordalsfjället
    snowline: 0,
    treeline: 550,
    forest: 'birch',
    avalanche: { name: 'Lavinprognoser.se', url: 'https://lavinprognoser.se/' },
  },
  {
    id: 'hemavan',
    name: 'Hemavan Tärnaby',
    subtitle: 'Lapland · Sweden',
    country: 'SE',
    bbox: [14.94, 65.74, 15.3, 65.9],
    camera: { center: [15.112, 65.826], zoom: 13.1, pitch: 62, bearing: 70 }, // from the village up the slopes
    snowline: 0,
    treeline: 800,
    forest: 'birch',
    avalanche: { name: 'Lavinprognoser.se', url: 'https://lavinprognoser.se/' },
  },
];

export const regionById = (id: string) => REGIONS.find((r) => r.id === id);

/** Snowline and treeline for an arbitrary location: the region it falls in, else a latitude-based guess. */
export type Climate = Pick<Region, 'snowline' | 'treeline' | 'forest'>;

export function climateAt(lng: number, lat: number): Climate {
  for (const r of REGIONS) {
    const [w, s, e, n] = r.bbox;
    if (lng >= w - 0.5 && lng <= e + 0.5 && lat >= s - 0.5 && lat <= n + 0.5) return r;
  }
  if (lat > 62) return { snowline: 0, treeline: 700, forest: 'birch' };
  if (lat > 55) return { snowline: 300, treeline: 1000, forest: 'conifer' };
  return { snowline: 1100, treeline: 2000, forest: 'conifer' };
}
