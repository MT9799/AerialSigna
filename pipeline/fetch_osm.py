#!/usr/bin/env python3
"""Fetch OpenStreetMap road geometry for the AerialSigna city index.

Two layers per city:
  major  motorway/trunk/primary/secondary/tertiary (+ links), bbox half 0.30 deg
  local  residential/unclassified/living_street,            bbox half 0.075 deg

The raw Overpass JSON is cached under pipeline/cache/ and is not committed.
Run:
  python pipeline/fetch_osm.py --cities beijing shanghai guangzhou
  python pipeline/fetch_osm.py --all --skip-existing
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "cache"
CITIES_JSON = ROOT / "data" / "cities.json"
UA = "AerialSigna/0.1 (academic road-network matching; contact: local)"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]
MAJOR = "^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"
LOCAL = "^(residential|unclassified|living_street)$"


def bbox(lat: float, lon: float, half: float) -> str:
    return f"{lat - half:.6f},{lon - half:.6f},{lat + half:.6f},{lon + half:.6f}"


def query(expr: str) -> str:
    return f"[out:json][timeout:300];way[\"highway\"~\"{expr}\"]({{bbox}});out geom;"


def fetch(name: str, lat: float, lon: float, half: float, expr: str, skip: bool) -> bool:
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{name}.json"
    if skip and out.exists() and out.stat().st_size > 1000:
        print(f"[skip] {name} {out.stat().st_size/1e6:.1f} MB")
        return True
    data = query(expr).replace("{bbox}", bbox(lat, lon, half))
    last = None
    for attempt in range(5):
        ep = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            t0 = time.time()
            r = requests.post(ep, data={"data": data}, headers={"User-Agent": UA}, timeout=360)
            dt = time.time() - t0
            if r.status_code != 200:
                last = f"HTTP {r.status_code} {r.text[:120]}"
                print(f"[retry {attempt+1}] {name} {ep.split('/')[2]} {last} ({dt:.0f}s)")
            else:
                meta = r.json()
                els = meta.get("elements", [])
                out.write_bytes(r.content)
                print(f"[ok] {name} {len(els)} ways {len(r.content)/1e6:.1f} MB {dt:.0f}s")
                return True
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)
            print(f"[retry {attempt+1}] {name} {ep.split('/')[2]} {last}")
        time.sleep(8 + attempt * 8 + random.random() * 3)
    print(f"[fail] {name}: {last}")
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cities", nargs="*", help="city ids; default all")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--layer", choices=["major", "local", "both"], default="both")
    args = ap.parse_args()
    catalog = json.loads(CITIES_JSON.read_text(encoding="utf-8"))
    wanted = None if args.all else set(args.cities or [])
    todo = [c for c in catalog["cities"] if wanted is None or c["id"] in wanted]
    if not todo:
        sys.exit("no matching cities")
    print(f"{len(todo)} cities, layer={args.layer}")
    for i, c in enumerate(todo):
        print(f"--- {i+1}/{len(todo)} {c['name']} ({c['id']})")
        if args.layer in ("major", "both"):
            fetch(f"{c['id']}_major", c["lat"], c["lon"], 0.30, MAJOR, args.skip_existing)
        if args.layer in ("local", "both"):
            fetch(f"{c['id']}_local", c["lat"], c["lon"], 0.075, LOCAL, args.skip_existing)
        time.sleep(2)


if __name__ == "__main__":
    main()
