"""Add a 10 km centre descriptor to every county tile.

The national index stores a 20 km fingerprint.  A query covering ~10 km is a
strict subset, so comparing its radial/density profile with the full 20 km
tile biases the prefilter.  This script recomputes a 50-int descriptor on the
central 10 km (half the 384 px tile) and merges it into each county JSON and
the national index.

Run after pipeline/build_national.py:
    python pipeline/add_center_desc.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
from build_national import descriptor  # noqa: E402

FP = ROOT / "data" / "fp"


def add_one(meta_path: Path) -> dict:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    rid = meta["id"]
    roads_path = meta_path.with_name(f"{rid}_r.png")
    if not roads_path.exists():
        return meta
    im = Image.open(roads_path).convert("L")
    w, h = im.size
    # central 50% linear = central 25% area = 10 km of a 20 km tile
    box = (w // 4, h // 4, w * 3 // 4, h * 3 // 4)
    crop = im.crop(box)
    arr = (np.asarray(crop) > 40).astype(np.uint8)
    meta["desc10"] = descriptor(arr)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return meta


def main():
    county_files = sorted(FP.glob("cn/*/*.json"))
    by_id = {}
    for p in county_files:
        try:
            m = add_one(p)
            by_id[m["id"]] = m
        except Exception as e:  # noqa: BLE001
            print("skip", p, e, flush=True)
    idx_path = FP / "index.json"
    if idx_path.exists():
        old = json.loads(idx_path.read_text(encoding="utf-8"))
        for m in old.get("counties", []):
            if m["id"] in by_id:
                m.update({k: by_id[m["id"]][k] for k in ("desc10",) if k in by_id[m["id"]]})
        old["counties"] = sorted(old["counties"], key=lambda m: m["id"])
        old["count"] = len(old["counties"])
        idx_path.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
    print(f"updated {len(by_id)} county descriptors", flush=True)


if __name__ == "__main__":
    main()
