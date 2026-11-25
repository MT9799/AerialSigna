"""Tiny, dependency-free Mapbox Vector Tile reader.

Only what AerialSigna needs: the `transportation` layer, its tags, and
line geometry.  Everything is stdlib so the build works on a bare Python.
"""
from __future__ import annotations

import math
from typing import Dict, Iterator, List, Tuple


def _varint(buf: bytes, i: int) -> Tuple[int, int]:
    v = 0
    shift = 0
    while True:
        c = buf[i]
        i += 1
        v |= (c & 0x7F) << shift
        if not c & 0x80:
            return v, i
        shift += 7


def _fields(buf: bytes) -> Iterator[Tuple[int, int, object]]:
    i = 0
    n = len(buf)
    while i < n:
        key, i = _varint(buf, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
            yield fn, wt, v
        elif wt == 2:
            ln, i = _varint(buf, i)
            yield fn, wt, buf[i:i + ln]
            i += ln
        elif wt == 5:
            yield fn, wt, buf[i:i + 4]
            i += 4
        elif wt == 1:
            yield fn, wt, buf[i:i + 8]
            i += 8
        else:  # pragma: no cover - malformed tile
            raise ValueError("bad protobuf wire type %d" % wt)


def _packed(buf: bytes) -> List[int]:
    out: List[int] = []
    i = 0
    while i < len(buf):
        v, i = _varint(buf, i)
        out.append(v)
    return out


def _value(buf: bytes) -> object:
    for fn, _wt, v in _fields(buf):
        if fn == 1:
            return v.decode("utf-8", "replace")
        if fn == 4:
            return v
        if fn == 5:
            return v
        if fn == 6:
            return (v >> 1) ^ -(v & 1)
        if fn == 7:
            return bool(v)
        if fn == 2:
            return 0.0
        if fn == 3:
            return 0.0
    return ""


def _zigzag(v: int) -> int:
    return (v >> 1) ^ -(v & 1)


def _lines(geom: List[int]) -> List[List[Tuple[int, int]]]:
    lines: List[List[Tuple[int, int]]] = []
    cur: List[Tuple[int, int]] = []
    x = y = 0
    i = 0
    while i < len(geom):
        cmd = geom[i] & 7
        cnt = geom[i] >> 3
        i += 1
        if cmd == 1:  # MoveTo
            if len(cur) > 1:
                lines.append(cur)
            cur = []
            for _ in range(cnt):
                x += _zigzag(geom[i]); y += _zigzag(geom[i + 1]); i += 2
                cur = [(x, y)]
        elif cmd == 2:  # LineTo
            for _ in range(cnt):
                x += _zigzag(geom[i]); y += _zigzag(geom[i + 1]); i += 2
                cur.append((x, y))
        elif cmd == 7:  # ClosePath
            if cur and cur[0] != cur[-1]:
                cur.append(cur[0])
    if len(cur) > 1:
        lines.append(cur)
    return lines


def read_tile(data: bytes) -> Dict[str, List[dict]]:
    """Return {layer_name: [{tags, lines, extent}, ...]}."""
    layers: Dict[str, List[dict]] = {}
    for fn, _wt, layer_buf in _fields(data):
        if fn != 3:
            continue
        name = ""
        extent = 4096
        keys: List[str] = []
        vals: List[object] = []
        raw_features: List[bytes] = []
        for f2, _w2, v2 in _fields(layer_buf):
            if f2 == 1:
                name = v2.decode("utf-8", "replace")
            elif f2 == 2:
                raw_features.append(v2)
            elif f2 == 3:
                keys.append(v2.decode("utf-8", "replace"))
            elif f2 == 4:
                vals.append(_value(v2))
            elif f2 == 5:
                extent = v2
        feats = []
        for fb in raw_features:
            tags: Dict[str, object] = {}
            geom: List[int] = []
            for f3, _w3, v3 in _fields(fb):
                if f3 == 2:
                    p = _packed(v3)
                    for j in range(0, len(p) - 1, 2):
                        if p[j] < len(keys) and p[j + 1] < len(vals):
                            tags[keys[p[j]]] = vals[p[j + 1]]
                elif f3 == 4:
                    geom = _packed(v3)
            feats.append({"tags": tags, "lines": _lines(geom), "extent": extent})
        layers[name] = feats
    return layers


# ---- geographic helpers -------------------------------------------------

def lonlat_to_tile_f(lon: float, lat: float, z: int) -> Tuple[float, float]:
    n = float(1 << z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def lonlat_to_px(lon: float, lat: float, z: int, px_per_tile: int) -> Tuple[float, float]:
    x, y = lonlat_to_tile_f(lon, lat, z)
    return x * px_per_tile, y * px_per_tile


# OpenMapTiles transportation class -> AerialSigna class
# 1 motorway, 2 trunk/primary, 3 secondary, 4 tertiary, 5 minor, 6 service/path
_CLASS = {
    "motorway": 1, "motorway_link": 1,
    "trunk": 2, "trunk_link": 2, "primary": 3, "primary_link": 3,
    "secondary": 4, "secondary_link": 4, "tertiary": 5, "tertiary_link": 5,
    "minor": 6, "service": 7, "track": 7, "path": 8, "busway": 7,
    "rail": 9, "transit": 9,
}


def road_class(tags: dict) -> int:
    c = tags.get("class") or ""
    base = _CLASS.get(str(c), 0)
    if base == 0:
        return 0
    # bridges/tunnels keep their class; pedestrian paths are not roads
    if base >= 7 and tags.get("subclass") in ("footway", "cycleway", "path", "pedestrian", "platform"):
        return 0
    return base
