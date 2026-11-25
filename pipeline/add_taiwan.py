"""Add Taiwan's 22 county-level units to data/counties.json.

DataV GeoAtlas returns no features for Taiwan, which is why the national index
was 22 short of the commonly cited ~2,896 county-level total.  Centres are the
city/county seats; adcodes use the 7101xx block so they are stable and do not
collide with mainland adcodes.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "counties.json"

# name, lat, lon, adcode, kind
TW = [
    ("台北市", 25.0330, 121.5654, "710101", "市"),
    ("新北市", 25.0114, 121.4618, "710102", "市"),
    ("桃园市", 24.9937, 121.3010, "710103", "市"),
    ("台中市", 24.1477, 120.6736, "710104", "市"),
    ("台南市", 22.9999, 120.2270, "710105", "市"),
    ("高雄市", 22.6273, 120.3014, "710106", "市"),
    ("基隆市", 25.1276, 121.7392, "710107", "市"),
    ("新竹市", 24.8138, 120.9675, "710108", "市"),
    ("嘉义市", 23.4801, 120.4491, "710109", "市"),
    ("新竹县", 24.8387, 121.0177, "710110", "县"),
    ("苗栗县", 24.5602, 120.8214, "710111", "县"),
    ("彰化县", 24.0756, 120.5440, "710112", "县"),
    ("南投县", 23.9609, 120.9719, "710113", "县"),
    ("云林县", 23.7092, 120.4313, "710114", "县"),
    ("嘉义县", 23.4518, 120.2555, "710115", "县"),
    ("屏东县", 22.5519, 120.5488, "710116", "县"),
    ("宜兰县", 24.7021, 121.7378, "710117", "县"),
    ("花莲县", 23.9911, 121.6112, "710118", "县"),
    ("台东县", 22.7583, 121.1444, "710119", "县"),
    ("澎湖县", 23.5711, 119.5793, "710120", "县"),
    ("金门县", 24.4321, 118.3171, "710121", "县"),
    ("连江县", 26.1602, 119.9517, "710122", "县"),
]


def main():
    data = json.loads(PATH.read_text(encoding="utf-8"))
    have = {int(c["adcode"]) for c in data["counties"]}
    added = 0
    for name, lat, lon, adcode, kind in TW:
        if adcode in have:
            continue
        data["counties"].append({
            "adcode": int(adcode),
            "name": name,
            "province": "台湾省",
            "province_adcode": 710000,
            "city": name if kind == "市" else "台湾省直辖",
            "lat": lat,
            "lon": lon,
        })
        added += 1
    data["counties"].sort(key=lambda c: int(c["adcode"]))
    PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"added {added}; total {len(data['counties'])}")


if __name__ == "__main__":
    main()
