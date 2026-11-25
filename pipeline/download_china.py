#!/usr/bin/env python3
"""Parallel ranged download of the China OSM extract (openstreetmap.fr mirror).

The mirror supports HTTP Range and is much faster with several connections than
the single-stream Geofabrik endpoint (which is unreachable here).
"""
from __future__ import annotations

import concurrent.futures as cf
import os
import sys
import time
from pathlib import Path

import requests

URL = "https://download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf"
OUT = Path(__file__).resolve().parent / "cache" / "china-latest.osm.pbf"
CHUNK = 8 * 1024 * 1024
THREADS = 16


def total_size() -> int:
    r = requests.head(URL, timeout=60, allow_redirects=True)
    r.raise_for_status()
    return int(r.headers["Content-Length"])


def download_chunk(args):
    idx, start, end = args
    for attempt in range(4):
        try:
            r = requests.get(URL, headers={"Range": f"bytes={start}-{end}"}, timeout=180)
            if r.status_code == 206 and len(r.content) == end - start + 1:
                with open(OUT, "r+b") as f:
                    f.seek(start)
                    f.write(r.content)
                return len(r.content)
            time.sleep(2 + attempt * 3)
        except Exception:  # noqa: BLE001
            time.sleep(2 + attempt * 3)
    raise RuntimeError(f"chunk {idx} failed")


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    total = total_size()
    if OUT.exists() and OUT.stat().st_size == total:
        print(f"already complete: {total/1e9:.2f} GB")
        return
    print(f"downloading {total/1e9:.2f} GB with {THREADS} connections")
    with open(OUT, "wb") as f:
        f.truncate(total)
    chunks = []
    for i, start in enumerate(range(0, total, CHUNK)):
        chunks.append((i, start, min(start + CHUNK - 1, total - 1)))
    t0 = time.time()
    done = 0
    with cf.ThreadPoolExecutor(THREADS) as ex:
        for n in ex.map(download_chunk, chunks):
            done += n
            if done % (128 * 1024 * 1024) < CHUNK:
                el = time.time() - t0
                print(f"{done/1e9:.2f}/{total/1e9:.2f} GB  {done/1e6/el:.1f} MB/s", flush=True)
    print(f"done in {time.time()-t0:.0f}s, size={OUT.stat().st_size}")


if __name__ == "__main__":
    main()
