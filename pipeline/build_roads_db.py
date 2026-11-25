#!/usr/bin/env python3
"""Build a compact, spatially indexed road database from the China OSM PBF.

Only drivable classes used by the matcher are kept.  Residential roads are
retained only inside a ~5 km core around every county seat, because at the
national 20 km / 384 px scale they are sub-pixel and mostly add noise.

Output: pipeline/cache/roads.sqlite
  ways(id, cls, minlat, maxlat, minlon, maxlon, geom)
  grid(cell_lat, cell_lon, id)

geom is a little-endian int32 array of 1e7-degree coordinates:
  lon0, lat0, dlon1, dlat1, dlon2, dlat2, ...
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import struct
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline" / ".pylibs"))
import osmium  # noqa: E402

PBF = ROOT / "pipeline" / "cache" / "china-latest.osm.pbf"
DB = ROOT / "pipeline" / "cache" / "roads.sqlite"
COUNTIES = ROOT / "data" / "counties.json"
IDX = ROOT / "pipeline" / "cache" / "node.idx"

CLS = {
    "motorway": 1, "motorway_link": 1,
    "trunk": 2, "trunk_link": 2,
    "primary": 3, "primary_link": 3,
    "secondary": 4, "secondary_link": 4,
    "tertiary": 5, "tertiary_link": 5,
    "residential": 6, "unclassified": 6, "living_street": 6,
}
KEEP = set(CLS)


def core_cells() -> set[tuple[int, int]]:
    data = json.loads(COUNTIES.read_text(encoding="utf-8"))
    cells = set()
    for c in data["counties"]:
        la, lo = c["lat"], c["lon"]
        for dla in (-1, 0, 1):
            for dlo in (-1, 0, 1):
                cells.add((math.floor(la / 0.05) + dla, math.floor(lo / 0.05) + dlo))
    return cells


def encode(pts: list[tuple[float, float]]) -> bytes:
    vals = []
    px = py = 0
    for i, (lon, lat) in enumerate(pts):
        x, y = round(lon * 1e7), round(lat * 1e7)
        if i == 0:
            vals.extend((x, y))
        else:
            vals.extend((x - px, y - py))
        px, py = x, y
    return struct.pack("<%di" % len(vals), *vals)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="debug: stop after N kept ways")
    args = ap.parse_args()
    if DB.exists():
        DB.unlink()
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(DB) + suffix)
        if p.exists():
            p.unlink()
    if IDX.exists():
        IDX.unlink()

    cells = core_cells()
    print(f"residential core cells: {len(cells)}")
    db = sqlite3.connect(DB)
    db.executescript("""
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA cache_size=-200000;
        PRAGMA page_size=4096;
        CREATE TABLE ways(id INTEGER PRIMARY KEY, cls INTEGER, minlat REAL, maxlat REAL,
                          minlon REAL, maxlon REAL, geom BLOB);
        CREATE TABLE grid(cell_lat INTEGER, cell_lon INTEGER, id INTEGER);
        CREATE INDEX grid_cell ON grid(cell_lat, cell_lon);
    """)
    idx = osmium.index.create_map(f"sparse_file_array,{IDX}")
    fp = (osmium.FileProcessor(str(PBF))
          .with_locations(idx)
          .with_filter(osmium.filter.KeyFilter("highway")))

    t0 = time.time()
    batch = []
    kept = seen = 0
    for obj in fp:
        if not obj.is_way():
            continue
        seen += 1
        hw = obj.tags.get("highway")
        cls = CLS.get(hw)
        if cls is None:
            continue
        pts = []
        in_core = False
        for n in obj.nodes:
            loc = n.location
            if not loc.valid():
                continue
            lon, lat = loc.lon, loc.lat
            pts.append((lon, lat))
            if cls == 6:
                if (math.floor(lat / 0.05), math.floor(lon / 0.05)) in cells:
                    in_core = True
        if len(pts) < 2:
            continue
        if cls == 6 and not in_core:
            continue
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        batch.append((
            obj.id, cls, min(lats), max(lats), min(lons), max(lons), encode(pts)
        ))
        kept += 1
        if len(batch) >= 5000:
            db.executemany("INSERT INTO ways VALUES (?,?,?,?,?,?,?)", batch)
            g = []
            for b in batch:
                for ca in range(math.floor(b[2] / 0.05), math.floor(b[3] / 0.05) + 1):
                    for co in range(math.floor(b[4] / 0.05), math.floor(b[5] / 0.05) + 1):
                        g.append((ca, co, b[0]))
            db.executemany("INSERT INTO grid VALUES (?,?,?)", g)
            db.commit()
            batch.clear()
            el = time.time() - t0
            print(f"{kept:8d} kept / {seen:9d} ways  {kept/max(el,1):.0f}/s  {el:.0f}s", flush=True)
        if args.limit and kept >= args.limit:
            break
    if batch:
        db.executemany("INSERT INTO ways VALUES (?,?,?,?,?,?,?)", batch)
        g = []
        for b in batch:
            for ca in range(math.floor(b[2] / 0.05), math.floor(b[3] / 0.05) + 1):
                for co in range(math.floor(b[4] / 0.05), math.floor(b[5] / 0.05) + 1):
                    g.append((ca, co, b[0]))
        db.executemany("INSERT INTO grid VALUES (?,?,?)", g)
    db.commit()
    db.execute("ANALYZE")
    db.commit()
    db.close()
    print(f"done: {kept} ways, {DB.stat().st_size/1e6:.0f} MB in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
