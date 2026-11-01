#!/usr/bin/env python3
"""IMDb's ratings export (imdb.com → Your Ratings → ⋯ → Export) into the grades lampa-native and Lampa share (KV GRADES).

    python3 -I proxy/imdb-import.py ratings.csv            # dry run: what would change, and IMDb score vs grade
    python3 -I proxy/imdb-import.py ratings.csv --write    # merge it in

Each title is found by its IMDb id (the worker's /find). A grade counts as watched: the film leaves My list, Finish later
and Continue browsing. Per title the newer one wins, as /grades does: IMDb's "Date Rated" against the grade's time,
so a grade given in Lampa after the IMDb rating (or removed since) stays. Runs again safely with a newer export.
"""
import csv
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

WORKER = 'https://torbox-proxy.sayenkofedor.workers.dev'
NPX = '/opt/homebrew/bin/npx'  # zsh's npx function is broken on this Mac


# IMDb's 1-10 → lampa-native's grades (Cub.GRADES): 2 Loved, 1 Good, 0 OK, -1 Bad. From the user's own: on the 111
# titles graded in both (2026-11-01) a 10 was Loved 27 of 34 times, a 9 Good 28 of 48, an 8 Good 20 of 23 (this
# mapping agrees with 70 % of them; 9 as Loved with 63 %).
def grade(score):
    return 2 if score >= 10 else 1 if score >= 7 else 0 if score >= 5 else -1


def find(imdb):
    # Cloudflare turns away Python's own User-Agent (403)
    ask = urllib.request.Request(f'{WORKER}/find/{imdb}', headers={'User-Agent': 'imdb-import'})
    with urllib.request.urlopen(ask, timeout=30) as r:
        return json.load(r)['card']


def wrangler(*args, **kw):
    return subprocess.run([NPX, 'wrangler', 'kv', 'key', *args, '--binding', 'GRADES', '--remote'],
                          check=True, capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__)),
                          **kw).stdout  # beside wrangler.toml


def main():
    rows = list(csv.DictReader(open(sys.argv[1], encoding='utf-8-sig')))
    write = '--write' in sys.argv
    keys = [k['name'] for k in json.loads(wrangler('list'))]
    if len(keys) != 1:
        sys.exit(f'expected one account in GRADES, found {keys}')
    who = keys[0]
    have = json.loads(wrangler('get', who) or '{}')
    with ThreadPoolExecutor(8) as pool:
        cards = list(pool.map(lambda r: find(r['Const']), rows))
    found, missing, kept, compare = {}, [], 0, Counter()
    for r, c in zip(rows, cards):
        if c is None:
            missing.append(f"{r['Const']} {r['Title']} ({r['Year']}, {r['Title Type']})")
            continue
        key = f'{c[1]}_{c[0]}'
        score = int(r['Your Rating'])
        t = int(datetime.strptime(r['Date Rated'], '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp() * 1000)
        old = have.get(key)
        if old is not None:
            compare[(score, str(old.get('g')))] += 1
            if old.get('t', 0) >= t:
                kept += 1
                continue
        tv = c[1] == 'tv'
        original = r['Original Title'] or r['Title']
        card = {'id': c[0], 'name' if tv else 'title': c[2], 'original_name' if tv else 'original_title': original,
                'source': 'tmdb'}
        if c[3]:
            card['first_air_date' if tv else 'release_date'] = c[3]
        if c[4]:
            card['poster_path'] = c[4]
        found[key] = {'g': grade(score), 't': t, 'card': card}
    print(f'{len(rows)} IMDb ratings: {len(found)} to add, {kept} already graded in Lampa (kept), {len(missing)} not on TMDB')
    print('IMDb score vs your grade in Lampa on the same title:', dict(sorted(compare.items())))
    print('new grades:', dict(Counter(v['g'] for v in found.values())))
    for m in missing:
        print('  not found:', m)
    if write and found:
        have.update(found)
        with tempfile.NamedTemporaryFile('w', suffix='.json') as f:
            json.dump(have, f)
            f.flush()
            wrangler('put', who, '--path', f.name)
        print(f'written: {len(have)} grades for {who}')


if __name__ == '__main__':
    main()
