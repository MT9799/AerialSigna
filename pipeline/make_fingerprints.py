#!/usr/bin/env python3
"""Rasterise cached Overpass ways into square road-network fingerprints.

Streaming: ways are read one at a time with ijson, so a 27 MB response does not
turn into hundreds of MB of Python dicts.  For every city/FOV this writes, at
1024x1024:
  <city>_<fov>_roads.png   white road centrelines on black
  <city>_<fov>_dist.png    distance to nearest road, 4 px per grey level
  <city>_<fov>_class.png   road class id (1 motorway .. 6 residential)
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from osm_io import iter_ways

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "cache"
OUT = ROOT / "data" / "fp"
N = 1024
SS = 2

CLASS_ID = {
    "motorway": 1, "motorway_link": 1,
    "trunk": 2, "trunk_link": 2,
    "primary": 3, "primary_link": 3,
    "secondary": 4, "secondary_link": 4,
    "tertiary": 5, "tertiary_link": 5,
    "residential": 6, "unclassified": 6, "living_street": 6,
}
WIDTH_M = {1: 42, 2: 34, 3: 26, 4: 19, 5: 13, 6: 7}


def chamfer_distance(binary: np.ndarray) -> np.ndarray:
    """3x3 chamfer distance (1, sqrt2) without SciPy; fits tight memory limits."""
    h, w = binary.shape
    d = np.where(binary, 0.0, 1e6).astype(np.float32)
    for y in range(h):
        row = d[y]
        if y:
            prev = d[y - 1]
            np.minimum(row, prev + 1.0, out=row)
            np.minimum(row[1:], prev[:-1] + 1.4142, out=row[1:])
            np.minimum(row[:-1], prev[1:] + 1.4142, out=row[:-1])
        for x in range(1, w):
            v = row[x - 1] + 1.0
            if v < row[x]:
                row[x] = v
    for y in range(h - 1, -1, -1):
        row = d[y]
        if y < h - 1:
            nxt = d[y + 1]
            np.minimum(row, nxt + 1.0, out=row)
            np.minimum(row[1:], nxt[:-1] + 1.4142, out=row[1:])
            np.minimum(row[:-1], nxt[1:] + 1.4142, out=row[:-1])
        for x in range(w - 2, -1, -1):
            v = row[x + 1] + 1.0
            if v < row[x]:
                row[x] = v
    return d


def m_per_deg(lat_deg: float) -> tuple[float, float]:
    p = math.radians(lat_deg)
    mlat = 111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
    mlon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p)
    return mlat, mlon


def allowed(fov: int, cls: int) -> bool:
    if fov >= 40:
        return cls <= 4
    if fov >= 20:
        return cls <= 5
    return True


def iter_city_ways(cid: str):
    for layer in ("major", "local"):
        p = CACHE / f"{cid}_{layer}.json"
        if not p.exists():
            continue
        for el in iter_ways(p):
            cls = CLASS_ID.get((el.get("tags") or {}).get("highway"))
            if cls is None:
                continue
            pts = [(g["lon"], g["lat"]) for g in el["geometry"]]
            if len(pts) >= 2:
                yield cls, pts


def render(city: dict, fov: int, ways) -> dict:
    lat0, lon0 = city["lat"], city["lon"]
    mlat, mlon = m_per_deg(lat0)
    size_m = fov * 1000.0
    px_per_m = N / size_m
    half = size_m / 2.0

    img = Image.new("L", (N * SS, N * SS), 0)
    cls_img = Image.new("L", (N * SS, N * SS), 0)
    draw = ImageDraw.Draw(img)
    cdraw = ImageDraw.Draw(cls_img)
    counts = {i: 0 for i in range(1, 7)}

    for cls, pts_in in ways:
        if not allowed(fov, cls):
            continue
        pts = []
        for lon, lat in pts_in:
            x = (lon - lon0) * mlon * px_per_m
            y = -(lat - lat0) * mlat * px_per_m
            pts.append((N * SS / 2 + x * SS, N * SS / 2 + y * SS))
        if len(pts) < 2:
            continue
        if not any(-40 <= x <= N * SS + 40 and -40 <= y <= N * SS + 40 for x, y in pts):
            continue
        w = max(1, int(round(WIDTH_M[cls] * px_per_m * SS)))
        draw.line(pts, fill=255, width=w, joint="curve")
        cdraw.line(pts, fill=cls, width=w, joint="curve")
        counts[cls] += 1

    img = img.resize((N, N), Image.LANCZOS)
    cls_img = cls_img.resize((N, N), Image.NEAREST)
    arr = np.asarray(img)
    binary = arr > 24
    dist = chamfer_distance(binary)
    dist8 = np.clip(dist * 4.0, 0, 255).astype(np.uint8)

    OUT.mkdir(parents=True, exist_ok=True)
    cid = city["id"]
    img.save(OUT / f"{cid}_{fov}_roads.png", optimize=True)
    Image.fromarray(dist8).save(OUT / f"{cid}_{fov}_dist.png", optimize=True)
    cls_img.save(OUT / f"{cid}_{fov}_class.png", optimize=True)

    meta = {
        "id": cid, "name": city["name"], "name_en": city["name_en"],
        "province": city["province"], "lat": lat0, "lon": lon0,
        "fov_km": fov, "size_px": N, "m_per_px": size_m / N,
        "bbox": [lat0 - half / mlat, lon0 - half / mlon, lat0 + half / mlat, lon0 + half / mlon],
        "road_px": int(binary.sum()),
        "counts": {str(k): v for k, v in counts.items() if v},
    }
    (OUT / f"{cid}_{fov}_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cities", nargs="*")
    ap.add_argument("--fovs", nargs="*", type=int, default=[5, 10, 20, 40])
    args = ap.parse_args()
    catalog = json.loads((ROOT / "data" / "cities.json").read_text(encoding="utf-8"))
    wanted = set(args.cities or [])
    done = 0
    for city in catalog["cities"]:
        if wanted and city["id"] not in wanted:
            continue
        if not (CACHE / f"{city['id']}_major.json").exists():
            print(f"[skip] {city['id']} no major cache")
            continue
        for fov in args.fovs:
            meta = render(city, fov, iter_city_ways(city["id"]))
            done += 1
            print(f"[fp] {city['id']:12s} {fov:>2} km  roads={meta['road_px']:6d}  classes={meta['counts']}")
    print(f"wrote {done} fingerprints to {OUT}")


if __name__ == "__main__":
    main()
