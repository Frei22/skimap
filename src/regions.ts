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
    avalanche: { name: 'Météo-France BRA', url: 'https://meteofrance.com/meteo-montagne/alpes-du-nord/risques-avalanche' },
  },
  {
    id: 'riksgransen',
    name: 'Riksgränsen',
    subtitle: 'Lapland · Sweden',
    country: 'SE',
    bbox: [17.98, 68.36, 18.36, 68.5],
    camera: { center: [18.12, 68.412], zoom: 13.2, pitch: 64, bearing: 12 },
    snowline: 0,
    avalanche: { name: 'Lavinprognoser.se', url: 'https://lavinprognoser.se/' },
  },
  {
    id: 'hemavan',
    name: 'Hemavan Tärnaby',
    subtitle: 'Lapland · Sweden',
    country: 'SE',
    bbox: [14.94, 65.74, 15.3, 65.9],
    camera: { center: [15.09, 65.795], zoom: 13.1, pitch: 66, bearing: 320 },
    snowline: 0,
    avalanche: { name: 'Lavinprognoser.se', url: 'https://lavinprognoser.se/' },
  },
];

export const regionById = (id: string) => REGIONS.find((r) => r.id === id);

/** Snowline for an arbitrary location: use the region it falls in, else a latitude-based guess. */
export function snowlineAt(lng: number, lat: number): number {
  for (const r of REGIONS) {
    const [w, s, e, n] = r.bbox;
    if (lng >= w - 0.5 && lng <= e + 0.5 && lat >= s - 0.5 && lat <= n + 0.5) return r.snowline;
  }
  if (lat > 62) return 0;
  if (lat > 55) return 300;
  return 1100;
}
