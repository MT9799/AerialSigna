#!/usr/bin/env python3
"""Build the county-level place index from DataV GeoAtlas boundaries.

DataV publishes one GeoJSON per administrative unit.  Province files list
prefecture cities (or districts, for municipalities); city files list counties.
Each feature carries `center` [lon, lat], the government seat, which is the
right anchor for an urban fingerprint.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "counties.json"
BASE = "https://geo.datav.aliyun.com/areas_v3/bound/{adcode}_full.json"
UA = {"User-Agent": "AerialSigna/0.1 (county index build)"}


def get(adcode: int):
    url = BASE.format(adcode=adcode)
    for attempt in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=60)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.6 + attempt)
    return None


def point(props):
    p = props.get("center") or props.get("centroid")
    if not p or len(p) != 2:
        return None
    lon, lat = float(p[0]), float(p[1])
    if not (3 < lat < 54 and 73 < lon < 136):
        return None
    return lon, lat


def main() -> None:
    top = get(100000)
    provinces = []
    for f in top["features"]:
        p = f["properties"]
        if p.get("level") != "province":
            continue
        provinces.append({
            "adcode": p["adcode"], "name": p["name"],
            "center": point(p), "children": p.get("childrenNum", 0),
        })
    print(f"{len(provinces)} provinces")

    def work(prov):
        data = get(prov["adcode"])
        rows = []
        if not data:
            return rows
        for f in data.get("features", []):
            p = f["properties"]
            lvl = p.get("level")
            pt = point(p)
            if not pt:
                continue
            if lvl == "district" or (lvl == "city" and p.get("childrenNum", 0) == 0):
                rows.append({
                    "adcode": p["adcode"], "name": p["name"],
                    "province": prov["name"], "province_adcode": prov["adcode"],
                    "city": prov["name"] if lvl == "district" else p["name"],
                    "level": "district", "lon": pt[0], "lat": pt[1],
                })
            elif lvl == "city":
                sub = get(p["adcode"])
                if not sub:
                    continue
                for g in sub.get("features", []):
                    q = g["properties"]
                    qt = point(q)
                    if not qt:
                        continue
                    rows.append({
                        "adcode": q["adcode"], "name": q["name"],
                        "province": prov["name"], "province_adcode": prov["adcode"],
                        "city": p["name"], "level": "district",
                        "lon": qt[0], "lat": qt[1],
                    })
        return rows

    allrows = []
    with cf.ThreadPoolExecutor(6) as ex:
        for i, rows in enumerate(ex.map(work, provinces)):
            allrows.extend(rows)
            print(f"[{i+1}/{len(provinces)}] {provinces[i]['name']}: {len(rows)}")
    seen = {}
    for r in allrows:
        seen[r["adcode"]] = r
    rows = sorted(seen.values(), key=lambda r: (r["province_adcode"], r["adcode"]))
    out = {
        "schema": 1,
        "country": "CN",
        "note": "County-level units from DataV GeoAtlas; lon/lat is the government seat (center).",
        "count": len(rows),
        "provinces": [p for p in provinces if p["center"]],
        "counties": rows,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {len(rows)} county-level units -> {OUT}")


if __name__ == "__main__":
    main()
