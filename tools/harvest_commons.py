"""Harvest geotagged night aerial photos from Wikimedia Commons for testing."""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "AerialSigna" / "samples" / "commons"
API = "https://commons.wikimedia.org/w/api.php"
UA = "AerialSigna/0.1 (research; contact: local)"

QUERIES = [
    "Beijing night aerial", "Shanghai night aerial", "Guangzhou night aerial",
    "Shenzhen night aerial", "Chengdu night aerial", "Chongqing night aerial",
    "Wuhan night aerial", "Xi'an night aerial", "Hangzhou night aerial",
    "Nanjing night aerial", "Hong Kong night aerial", "Taipei night aerial",
    "Tokyo night aerial", "Seoul night aerial", "Singapore night aerial",
    "Bangkok night aerial", "New York night aerial", "London night aerial",
    "Paris night aerial", "Dubai night aerial", "night city from airplane",
    "aerial night city lights", "ISS city at night China",
]


def api(params: dict) -> dict:
    params = dict(params); params["format"] = "json"
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return json.load(urllib.request.urlopen(req, timeout=45))


def clean(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html or "").strip()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for q in QUERIES:
        try:
            d = api({
                "action": "query", "generator": "search", "gsrsearch": q,
                "gsrnamespace": 6, "gsrlimit": 12, "prop": "imageinfo",
                "iiprop": "url|size|extmetadata|coordinates", "iiurlwidth": 1800,
            })
        except Exception as e:  # noqa: BLE001
            print("query fail", q, e); continue
        pages = (d.get("query") or {}).get("pages", {})
        for p in pages.values():
            ii = (p.get("imageinfo") or [{}])[0]
            if not ii.get("thumburl"):
                continue
            meta = ii.get("extmetadata") or {}
            coord = ii.get("coordinates") or []
            rows.append({
                "query": q, "title": p.get("title"), "width": ii.get("width"),
                "height": ii.get("height"), "url": ii.get("url"), "thumb": ii.get("thumburl"),
                "lat": coord[0]["lat"] if coord else None,
                "lon": coord[0]["lon"] if coord else None,
                "desc": clean((meta.get("ImageDescription") or {}).get("value", ""))[:400],
                "artist": clean((meta.get("Artist") or {}).get("value", ""))[:200],
                "license": clean((meta.get("LicenseShortName") or {}).get("value", "")),
            })
        print(q, len(pages))
    (OUT.parent / "commons_harvest.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print("total", len(rows))


if __name__ == "__main__":
    main()
