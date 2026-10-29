#!/usr/bin/env python3
"""
Downloads Lantmäteriet's 1 m terrain model (Markhöjdmodell Nedladdning, grid 1+) for a bounding
box, via the STAC-hojd API. Searching is open; downloading needs a free Geotorget account with
the product ordered. Credentials come from the environment, never the command line:

  LANTMATERIET_USER       Geotorget user name (Basic auth)
  LANTMATERIET_PASSWORD   Geotorget password

Usage:
  python scripts/fetch-lantmateriet.py --bbox 17.85 68.30 18.50 68.56 --out dem-src/riksgransen
  python scripts/build-dem.py -o public/dem/riksgransen.pmtiles --minzoom 10 --maxzoom 15 \\
      --bbox 17.85 68.30 18.50 68.56 dem-src/riksgransen/*.tif

Files are 10 × 10 km GeoTIFFs in SWEREF 99 TM (a few hundred MB each); existing files are skipped.
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = 'https://api.lantmateriet.se/stac-hojd/v1'
UA = 'skimap-dem-builder/1.0'


def request(url, data=None, auth=None):
    headers = {'User-Agent': UA, 'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(data).encode()
    if auth:
        headers['Authorization'] = 'Basic ' + base64.b64encode(f'{auth[0]}:{auth[1]}'.encode()).decode()
    return urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=120)


def get_json(url, data=None):
    with request(url, data) as r:
        return json.load(r)


def pick_collections():
    """The 1 m terrain model: 'dtm-cog' when offered, else the per-area 'mhm-*' collections."""
    cols = [c['id'] for c in get_json(f'{API}/collections').get('collections', [])]
    if 'dtm-cog' in cols:
        return ['dtm-cog']
    mhm = [c for c in cols if c.startswith('mhm')]
    if mhm:
        return mhm
    sys.exit(f'No terrain-model collection found. Collections offered: {", ".join(cols)}')


def search(bbox, collections):
    body = {'bbox': bbox, 'collections': collections, 'limit': 100}
    url = f'{API}/search'
    while url:
        page = get_json(url, body)
        yield from page.get('features', [])
        nxt = next((l for l in page.get('links', []) if l.get('rel') == 'next'), None)
        if not nxt:
            break
        url, body = nxt['href'], nxt.get('body', None)
        if nxt.get('method', 'GET').upper() == 'GET':
            body = None


def data_asset(item):
    assets = item.get('assets', {})
    if 'data' in assets:
        return assets['data']['href']
    tifs = [a['href'] for a in assets.values() if a.get('href', '').lower().endswith(('.tif', '.tiff'))]
    return tifs[0] if tifs else None


def download(url, path, auth):
    tmp = path + '.part'
    try:
        with request(url, auth=auth) as r, open(tmp, 'wb') as f:
            total = int(r.headers.get('Content-Length') or 0)
            done = 0
            while chunk := r.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
            if total and done != total:
                raise IOError(f'incomplete download ({done} of {total} bytes)')
    except urllib.error.HTTPError as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        if e.code in (401, 403):
            sys.exit(f'{e.code} for {url}: check LANTMATERIET_USER/LANTMATERIET_PASSWORD and that '
                     '"Markhöjdmodell Nedladdning" is ordered on Geotorget.')
        raise
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', type=float, nargs=4, metavar=('W', 'S', 'E', 'N'), required=True)
    ap.add_argument('--out', required=True, help='directory for the GeoTIFFs')
    args = ap.parse_args()

    user, password = os.environ.get('LANTMATERIET_USER'), os.environ.get('LANTMATERIET_PASSWORD')
    if not user or not password:
        sys.exit('Set LANTMATERIET_USER and LANTMATERIET_PASSWORD (your Geotorget login).')
    os.makedirs(args.out, exist_ok=True)

    collections = pick_collections()
    items = list(search(args.bbox, collections))
    print(f'{len(items)} tiles in {",".join(collections)} for bbox {args.bbox}', flush=True)
    if not items:
        sys.exit('Nothing found for this bbox.')
    for i, item in enumerate(items, 1):
        href = data_asset(item)
        if not href:
            print(f'  {item.get("id")}: no GeoTIFF asset, skipping', flush=True)
            continue
        path = os.path.join(args.out, os.path.basename(href.split('?')[0]))
        if os.path.exists(path):
            print(f'  [{i}/{len(items)}] {os.path.basename(path)} (cached)', flush=True)
            continue
        download(href, path, (user, password))
        print(f'  [{i}/{len(items)}] {os.path.basename(path)} {os.path.getsize(path) / 1e6:.0f} MB', flush=True)


if __name__ == '__main__':
    main()
