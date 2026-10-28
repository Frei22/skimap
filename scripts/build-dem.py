#!/usr/bin/env python3
"""
Builds a high-resolution elevation layer for Skimap from GeoTIFF elevation data
(Lantmäteriet Markhöjdmodell grid 1+, IGN RGE ALTI, swissALTI3D, Copernicus, ...).

Output is a single PMTiles archive of 256 px Terrarium-encoded PNG tiles in Web Mercator.
Host it on any static file host that supports HTTP range requests (Cloudflare R2, S3,
GitHub Releases, the site itself) and add it to VITE_DEM_LAYERS, e.g.

  VITE_DEM_LAYERS='[{"name":"Lantmäteriet 1 m","url":"pmtiles://https://example.com/lapland.pmtiles",
    "encoding":"terrarium","minzoom":10,"maxzoom":16,"resolution":1,
    "bounds":[17.9,68.3,18.5,68.6],"attribution":"© Lantmäteriet"}]'

Usage:
  pip install rasterio numpy pillow pmtiles
  python scripts/build-dem.py -o lapland.pmtiles --maxzoom 15 --bbox 17.9 68.3 18.5 68.6 dem/*.tif

Choosing --maxzoom: a z15 pixel is ~1.8 m in Lapland (68°N) and ~3.3 m in the Alps (46°N); z16 halves
that. For 1 m data use 15 in Lapland and 16 in the Alps.

Inputs can be in any CRS and may overlap (earlier files win). No-data is written as
Terrarium (0,0,0), which the app fills from the global elevation model.
"""
import argparse
import io
import math
import os
import sys
import tempfile
import warnings

import numpy as np
import rasterio
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds

TILE = 256
R = 6378137.0
HALF = math.pi * R


def tile_bounds_3857(z, x, y):
    size = 2 * HALF / 2**z
    minx = -HALF + x * size
    maxy = HALF - y * size
    return minx, maxy - size, minx + size, maxy


def lng2x(lng, z):
    return int((lng + 180) / 360 * 2**z)


def lat2y(lat, z):
    r = math.radians(lat)
    return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2**z)


def encode_terrarium(h, precision):
    """float32 metres (NaN = no data) → RGB PNG bytes. Rounding to `precision` shrinks the PNGs a lot."""
    valid = ~np.isnan(h)
    v = np.round(np.where(valid, h, 0) / precision) * precision + 32768.0
    r = np.floor(v / 256)
    g = np.floor(v) % 256
    b = np.floor((v - np.floor(v)) * 256)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    rgb[~valid] = 0
    buf = io.BytesIO()
    Image.fromarray(rgb, 'RGB').save(buf, 'PNG', optimize=True)
    return buf.getvalue()


class Sources:
    def __init__(self, paths):
        self.items = []
        for p in paths:
            src = rasterio.open(p)
            b = transform_bounds(src.crs, 'EPSG:3857', *src.bounds)
            self.items.append((src, b))
        if not self.items:
            sys.exit('No input files')

    def bounds_lnglat(self):
        bs = [transform_bounds('EPSG:3857', 'EPSG:4326', *b) for _, b in self.items]
        return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))

    def render(self, z, x, y):
        """Reprojects every overlapping source onto one tile (bilinear); NaN where nothing has data."""
        tb = tile_bounds_3857(z, x, y)
        out = np.full((TILE, TILE), np.nan, dtype=np.float32)
        for src, b in self.items:
            if b[2] <= tb[0] or b[0] >= tb[2] or b[3] <= tb[1] or b[1] >= tb[3]:
                continue
            dst = np.full((TILE, TILE), np.nan, dtype=np.float32)
            reproject(
                rasterio.band(src, 1), dst,
                src_nodata=src.nodata, dst_nodata=np.nan,
                dst_transform=from_bounds(*tb, TILE, TILE), dst_crs='EPSG:3857',
                resampling=Resampling.bilinear,
            )
            dst[(dst < -500) | (dst > 9000)] = np.nan
            fill = np.isnan(out) & ~np.isnan(dst)
            out[fill] = dst[fill]
            if not np.isnan(out).any():
                break
        return None if np.isnan(out).all() else out


def downsample(children):
    """2×2 child tiles (None = empty) → parent tile, NaN-aware mean."""
    full = np.full((TILE * 2, TILE * 2), np.nan, dtype=np.float32)
    for (dx, dy), t in children.items():
        if t is not None:
            full[dy * TILE:(dy + 1) * TILE, dx * TILE:(dx + 1) * TILE] = t
    if np.isnan(full).all():
        return None
    blocks = full.reshape(TILE, 2, TILE, 2)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)  # all-NaN blocks → NaN, as intended
        return np.nanmean(blocks, axis=(1, 3)).astype(np.float32)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='+', help='GeoTIFF elevation files (metres)')
    ap.add_argument('-o', '--output', required=True, help='output .pmtiles')
    ap.add_argument('--minzoom', type=int, default=10)
    ap.add_argument('--maxzoom', type=int, default=16)
    ap.add_argument('--bbox', type=float, nargs=4, metavar=('W', 'S', 'E', 'N'), help='limit to this lng/lat box')
    ap.add_argument('--precision', type=float, default=0.1, help='vertical precision in metres (default 0.1)')
    args = ap.parse_args()

    sources = Sources(args.inputs)
    w, s, e, n = args.bbox or sources.bounds_lnglat()
    print(f'bbox {w:.4f},{s:.4f},{e:.4f},{n:.4f}  zoom {args.minzoom}-{args.maxzoom}', flush=True)

    tmp = tempfile.mkdtemp(prefix='skimap-dem-')
    written = []  # (tileid, path)
    counts = {}

    def save(z, x, y, h):
        path = os.path.join(tmp, f'{z}-{x}-{y}.png')
        with open(path, 'wb') as f:
            f.write(encode_terrarium(h, args.precision))
        written.append((zxy_to_tileid(z, x, y), path))
        counts[z] = counts.get(z, 0) + 1

    def inside(z, x, y):
        return lng2x(w, z) <= x <= lng2x(e, z) and lat2y(n, z) <= y <= lat2y(s, z)

    def build(z, x, y):
        # Depth-first, so memory stays at a few tiles per zoom level however large the area is.
        if not inside(z, x, y):
            return None
        if z == args.maxzoom:
            h = sources.render(z, x, y)
        else:
            h = downsample({(dx, dy): build(z + 1, 2 * x + dx, 2 * y + dy) for dx in (0, 1) for dy in (0, 1)})
        if h is not None and z >= args.minzoom:
            save(z, x, y, h)
        return h

    z0 = args.minzoom
    roots = [(x, y) for x in range(lng2x(w, z0), lng2x(e, z0) + 1) for y in range(lat2y(n, z0), lat2y(s, z0) + 1)]
    for i, (x, y) in enumerate(roots):
        build(z0, x, y)
        print(f'  {i + 1}/{len(roots)} root tiles done, {len(written)} tiles', flush=True)

    if not written:
        sys.exit('No data inside the bbox')
    written.sort()
    with open(args.output, 'wb') as f:
        writer = Writer(f)
        for tileid, path in written:
            with open(path, 'rb') as t:
                writer.write_tile(tileid, t.read())
            os.remove(path)
        writer.finalize(
            {
                'tile_type': TileType.PNG,
                'tile_compression': Compression.NONE,
                'min_lon_e7': int(w * 1e7), 'min_lat_e7': int(s * 1e7),
                'max_lon_e7': int(e * 1e7), 'max_lat_e7': int(n * 1e7),
                'center_zoom': args.minzoom,
                'center_lon_e7': int((w + e) / 2 * 1e7), 'center_lat_e7': int((s + n) / 2 * 1e7),
            },
            {'name': os.path.basename(args.output), 'encoding': 'terrarium', 'attribution': ''},
        )
    os.rmdir(tmp)
    size = os.path.getsize(args.output) / 1e6
    print(f'wrote {args.output}: {len(written)} tiles, {size:.1f} MB, per zoom {dict(sorted(counts.items()))}')


if __name__ == '__main__':
    main()
