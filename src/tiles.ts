// Web-Mercator tile helpers shared by the custom tile protocols.

export const TILE = 256;
const EARTH_CIRCUMFERENCE = 40075016.686;

export const tile2lng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export function tile2lat(y: number, z: number) {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

export const lng2tileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;

export function lat2tileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

/** Ground metres covered by one pixel of a 256px tile at zoom z and latitude lat. */
export const metersPerPixel = (z: number, lat: number) =>
  (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);

/** Parses `proto://z/x/y?query` (anything after the zxy is optional). */
export function parseTileUrl(url: string) {
  const m = /:\/\/(\d+)\/(\d+)\/(\d+)(?:\?(.*))?$/.exec(url);
  if (!m) throw new Error(`Bad tile url ${url}`);
  return { z: +m[1], x: +m[2], y: +m[3], query: new URLSearchParams(m[4] ?? '') };
}

export function tileBounds(z: number, x: number, y: number) {
  return { west: tile2lng(x, z), east: tile2lng(x + 1, z), north: tile2lat(y, z), south: tile2lat(y + 1, z) };
}

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export function smoothstep(e0: number, e1: number, v: number) {
  const t = clamp((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Small LRU on top of Map's insertion order. */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private limit: number) {}
  get(k: K) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
  }
  delete(k: K) {
    this.map.delete(k);
  }
}

/** Decodes an encoded image (jpeg/png bytes) into RGBA pixels. */
export async function decodePixels(blob: Blob, size = TILE): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, size, size);
  bmp.close();
  return ctx.getImageData(0, 0, size, size).data;
}

export async function encodePixels(px: Uint8ClampedArray, size = TILE): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(size, size);
  canvas.getContext('2d')!.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
  return createImageBitmap(canvas);
}

/**
 * Busy tile servers answer 429/5xx or drop connections now and then. Retry those a couple of times
 * before giving up: giving up means a blurry fallback tile that stays until the page is reloaded.
 */
export async function fetchRetrying(url: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (signal?.aborted || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 400 * 3 ** attempt + Math.random() * 300));
    }
  }
}
