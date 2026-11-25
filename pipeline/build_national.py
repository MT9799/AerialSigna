"""Build China's county-level OSM road fingerprints from OpenFreeMap vector tiles.

No GDAL, no pyosmium, no protobuf package: a tiny MVT reader + Pillow.
Run:  python pipeline/build_national.py --test beijing
      python pipeline/build_national.py --all
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from mvt import lonlat_to_tile_f, read_tile, road_class  # noqa: E402
from make_fingerprints import chamfer_distance  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "cache" / "mvt"
Z9CACHE = ROOT / "pipeline" / "cache" / "z9_2k"
OUT = ROOT / "data" / "fp" / "cn"
TILE_URL = "https://tiles.openfreemap.org/planet/20250122/{z}/{x}/{y}.pbf"
UA = "AerialSigna/0.1 (road-fingerprint research)"
Z9_PX = 2048
CT_PX = 384
HALF_KM = 10.0

# class -> line width at 4096 px / ~80 km tile (~20 m/px)
WIDTH = {1: 3, 2: 2, 3: 2, 4: 2, 5: 1, 6: 1, 7: 1}


def log(*a):
    print(*a, flush=True)


def fetch(url: str, path: Path, retries: int = 4) -> bytes:
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for k in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                data = r.read()
            if data:
                path.write_bytes(data)
                return data
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.0 + 1.5 * k)
    raise RuntimeError(f"fetch failed {url}: {last}")


def render_z9(zx: int, zy: int) -> Path:
    """Render a 4x4 block of z11 vector tiles into one 2048 px z9 road mask."""
    out = Z9CACHE / str(zx) / f"{zy}.png"
    if out.exists() and out.stat().st_size > 0:
        return out
    t0 = time.time()
    canvas = Image.new("L", (Z9_PX, Z9_PX), 0)
    draw = ImageDraw.Draw(canvas)
    n = 0
    for dy in range(4):
        for dx in range(4):
            tx, ty = zx * 4 + dx, zy * 4 + dy
            pbf = CACHE / "11" / str(tx) / f"{ty}.pbf"
            try:
                data = fetch(TILE_URL.format(z=11, x=tx, y=ty), pbf)
                layers = read_tile(data)
            except Exception as e:  # noqa: BLE001
                log("tile fail", 11, tx, ty, e)
                continue
            feats = layers.get("transportation", [])
            ox, oy = dx * (Z9_PX // 4), dy * (Z9_PX // 4)
            unit = (Z9_PX // 4) / 4096.0
            for f in feats:
                cls = road_class(f["tags"])
                if not cls:
                    continue
                w = WIDTH.get(cls, 1)
                for line in f["lines"]:
                    if len(line) < 2:
                        continue
                    pts = [(ox + x * unit, oy + y * unit) for x, y in line]
                    draw.line(pts, fill=255, width=w)
                    n += 1
    # Some regions (notably Taiwan) have no transportation features at z11
    # in the current OpenFreeMap build, while z12 is complete. Fall back to
    # 4x4 z12 children for those z9 tiles.
    if n == 0:
        canvas = Image.new("L", (Z9_PX, Z9_PX), 0)
        draw = ImageDraw.Draw(canvas)
        for dy in range(8):
            for dx in range(8):
                tx, ty = zx * 8 + dx, zy * 8 + dy
                pbf = CACHE / "12" / str(tx) / f"{ty}.pbf"
                try:
                    data = fetch(TILE_URL.format(z=12, x=tx, y=ty), pbf)
                    layers = read_tile(data)
                except Exception as e:  # noqa: BLE001
                    log("tile fail", 12, tx, ty, e)
                    continue
                feats = layers.get("transportation", [])
                ox, oy = dx * (Z9_PX // 8), dy * (Z9_PX // 8)
                unit = (Z9_PX // 8) / 4096.0
                for f in feats:
                    cls = road_class(f["tags"])
                    if not cls:
                        continue
                    w = max(1, WIDTH.get(cls, 1) // 2)
                    for line in f["lines"]:
                        if len(line) < 2:
                            continue
                        pts = [(ox + x * unit, oy + y * unit) for x, y in line]
                        draw.line(pts, fill=255, width=w)
                        n += 1
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, optimize=True)
    log(f"z9 {zx}/{zy}: {n} lines, {time.time()-t0:.1f}s")
    return out


def county_px(c: dict) -> Tuple[float, float, float, float]:
    """Return the 20 km bbox of a county seat in z9 pixel coordinates."""
    lat, lon = c["lat"], c["lon"]
    hlat = HALF_KM / 110.57
    hlon = HALF_KM / (111.32 * max(0.2, math.cos(math.radians(lat))))
    x0, y0 = lonlat_to_tile_f(lon - hlon, lat + hlat, 9)
    x1, y1 = lonlat_to_tile_f(lon + hlon, lat - hlat, 9)
    return x0 * Z9_PX, y0 * Z9_PX, x1 * Z9_PX, y1 * Z9_PX


def crop_county(c: dict, tiles: Dict[Tuple[int, int], Path]) -> Tuple[Image.Image, Tuple[float, float, float, float]]:
    x0, y0, x1, y1 = county_px(c)
    ix0, iy0 = int(math.floor(x0 / Z9_PX)), int(math.floor(y0 / Z9_PX))
    ix1, iy1 = int(math.floor(x1 / Z9_PX)), int(math.floor(y1 / Z9_PX))
    # Build a small mosaic covering the bbox.
    w = (ix1 - ix0 + 1) * Z9_PX
    h = (iy1 - iy0 + 1) * Z9_PX
    mosaic = Image.new("L", (w, h), 0)
    for ty in range(iy0, iy1 + 1):
        for tx in range(ix0, ix1 + 1):
            p = tiles.get((tx, ty))
            if p and p.exists():
                mosaic.paste(Image.open(p), ((tx - ix0) * Z9_PX, (ty - iy0) * Z9_PX))
    box = (x0 - ix0 * Z9_PX, y0 - iy0 * Z9_PX, x1 - ix0 * Z9_PX, y1 - iy0 * Z9_PX)
    crop = mosaic.crop(tuple(int(round(v)) for v in box)).resize((CT_PX, CT_PX), Image.LANCZOS)
    return crop, (x0, y0, x1, y1)


def descriptor(roads: np.ndarray) -> List[int]:
    """Rotation-aware coarse descriptor: 36-bin orientation hist + 12 radial bins + density."""
    h, w = roads.shape
    ys, xs = np.nonzero(roads > 0)
    out: List[int] = []
    if len(xs) < 10:
        return [0] * 50
    # gradient orientation on a blurred/downsampled mask
    small = np.asarray(Image.fromarray((roads > 0).astype(np.uint8) * 255).resize((128, 128), Image.BILINEAR), dtype=np.float32) / 255.0
    gy, gx = np.gradient(small)
    mag = np.hypot(gx, gy)
    ang = (np.degrees(np.arctan2(gy, gx)) + 180.0) % 180.0
    hist, _ = np.histogram(ang, bins=36, range=(0, 180), weights=mag)
    hist = hist / (hist.sum() + 1e-6)
    out += [int(round(v * 255)) for v in hist]
    # radial density around centroid
    cx, cy = xs.mean(), ys.mean()
    r = np.hypot(xs - cx, ys - cy) / (0.5 * min(h, w))
    rh, _ = np.histogram(r, bins=12, range=(0, 1.0))
    rh = rh / (rh.sum() + 1e-6)
    out += [int(round(v * 255)) for v in rh]
    out.append(int(round(len(xs) / (h * w) * 255)))
    out.append(int(round(math.log2(max(1, len(xs))) * 16)))
    return out


def build_county(c: dict, tiles: Dict[Tuple[int, int], Path]) -> dict:
    x0, y0, x1, y1 = county_px(c)
    need = {}
    for ty in range(int(math.floor(y0 / Z9_PX)), int(math.floor(y1 / Z9_PX)) + 1):
        for tx in range(int(math.floor(x0 / Z9_PX)), int(math.floor(x1 / Z9_PX)) + 1):
            need[(tx, ty)] = tiles[(tx, ty)]
    crop, _ = crop_county(c, need)
    arr = np.asarray(crop, dtype=np.uint8)
    binary = arr > 40
    roads = Image.fromarray((binary.astype(np.uint8) * 255))
    dist = chamfer_distance(binary)
    # 4 px per grey level keeps the PNG small while preserving sub-pixel ranking
    d8 = np.clip(dist / 4.0, 0, 255).astype(np.uint8)
    rid = str(c["adcode"])
    province_dir = OUT / str(c["province_adcode"])
    province_dir.mkdir(parents=True, exist_ok=True)
    roads.save(province_dir / f"{rid}_r.png", optimize=True)
    Image.fromarray(d8).save(province_dir / f"{rid}_d.png", optimize=True)
    meta = {
        "id": rid, "name": c["name"], "city": c.get("city", ""),
        "province": c["province"],
        "province_adcode": c["province_adcode"], "lat": c["lat"], "lon": c["lon"],
        "fov_km": 20, "px": CT_PX, "roads_px": int(binary.sum()),
        "z9": [int(math.floor(x0 / Z9_PX)), int(math.floor(y0 / Z9_PX))],
        "desc": descriptor(binary),
    }
    (province_dir / f"{rid}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--test", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--province", default="")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    data = json.loads((ROOT / "data" / "counties.json").read_text(encoding="utf-8"))
    counties = data["counties"]
    if args.test:
        counties = [c for c in counties
                    if args.test in c["name"] or args.test in c["province"]
                    or args.test in c.get("city", "")]
    if args.province:
        counties = [c for c in counties if args.province in c["province"]]
    if args.limit:
        counties = counties[: args.limit]
    if not counties:
        log("no counties matched")
        return

    # Which z9 tiles are needed?
    needed = set()
    for c in counties:
        x0, y0, x1, y1 = county_px(c)
        for ty in range(int(math.floor(y0 / Z9_PX)), int(math.floor(y1 / Z9_PX)) + 1):
            for tx in range(int(math.floor(x0 / Z9_PX)), int(math.floor(x1 / Z9_PX)) + 1):
                needed.add((tx, ty))
    log(f"{len(counties)} counties, {len(needed)} z9 tiles")

    tiles: Dict[Tuple[int, int], Path] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(render_z9, tx, ty): (tx, ty) for tx, ty in sorted(needed)}
        for fut in as_completed(futs):
            tx, ty = futs[fut]
            try:
                tiles[(tx, ty)] = fut.result()
            except Exception as e:  # noqa: BLE001
                log("z9 fail", tx, ty, e)

    index = []
    t0 = time.time()
    for i, c in enumerate(counties):
        need = {}
        x0, y0, x1, y1 = county_px(c)
        for ty in range(int(math.floor(y0 / Z9_PX)), int(math.floor(y1 / Z9_PX)) + 1):
            for tx in range(int(math.floor(x0 / Z9_PX)), int(math.floor(x1 / Z9_PX)) + 1):
                if (tx, ty) in tiles:
                    need[(tx, ty)] = tiles[(tx, ty)]
        try:
            m = build_county(c, need)
            index.append(m)
        except Exception as e:  # noqa: BLE001
            log("county fail", c["name"], e)
        if (i + 1) % 25 == 0:
            log(f"{i+1}/{len(counties)} {time.time()-t0:.0f}s")
    # merge into national index
    idx_path = ROOT / "data" / "fp" / "index.json"
    old = []
    if idx_path.exists():
        try:
            old = json.loads(idx_path.read_text(encoding="utf-8")).get("counties", [])
        except Exception:  # noqa: BLE001
            old = []
    by_id = {m["id"]: m for m in old}
    for m in index:
        by_id[m["id"]] = m
    allc = sorted(by_id.values(), key=lambda m: m["id"])
    idx_path.write_text(json.dumps({"schema": 1, "count": len(allc), "counties": allc}, ensure_ascii=False), encoding="utf-8")
    log(f"index {len(allc)} counties -> {idx_path}")


if __name__ == "__main__":
    main()
