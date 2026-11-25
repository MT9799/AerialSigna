"""Memory-lean reader for Overpass `out geom` JSON.

A 27 MB Overpass response expands to several hundred MB of Python dicts if
loaded with json.load().  We stream the top-level elements array instead and
keep only the fields the rasteriser needs.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / ".pylibs"))
from typing import Iterator


def iter_elements(path: Path, keep=lambda el: True) -> Iterator[dict]:
    try:
        import ijson
    except Exception:
        ijson = None
    if ijson is not None:
        with open(path, "rb") as f:
            for obj in ijson.items(f, "elements.item", use_float=True):
                if keep(obj):
                    yield obj
        return
    text = path.read_text(encoding="utf-8")
    key = '"elements"'
    i = text.find(key)
    if i < 0:
        return
    i = text.find("[", i)
    if i < 0:
        return
    i += 1
    dec = json.JSONDecoder()
    n = len(text)
    while i < n:
        while i < n and text[i] in " \t\r\n,":
            i += 1
        if i >= n or text[i] == "]":
            break
        try:
            obj, i = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            break
        if keep(obj):
            yield obj


def iter_ways(path: Path) -> Iterator[dict]:
    def is_way(el):
        return (
            el.get("type") == "way"
            and isinstance(el.get("geometry"), list)
            and len(el["geometry"]) >= 2
            and (el.get("tags") or {}).get("highway")
        )

    yield from iter_elements(path, is_way)
