"""Python reference implementation of the chamfer-FFT matcher (validation only)."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def load_gray(p: Path, n: int = 256) -> np.ndarray:
    im = Image.open(p).convert("L")
    im = im.resize((n, n), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def corr_fft(Q: np.ndarray, D: np.ndarray) -> np.ndarray:
    n = Q.shape[0]
    Fq = np.fft.rfft2(Q)
    Fd = np.fft.rfft2(D)
    C = np.fft.irfft2(Fd * np.conj(Fq), s=(n, n))
    return C


def place(q: np.ndarray, n: int, scale: float, angle: float) -> np.ndarray:
    """Scale/rotate a query mask and centre it on an n x n canvas."""
    h, w = q.shape
    side = int(round(n * scale))
    content = Image.fromarray((q * 255).astype(np.uint8))
    if scale != 1.0:
        content = content.resize((max(2, side), max(2, side)), Image.LANCZOS)
    if angle:
        content = content.rotate(angle, resample=Image.BILINEAR, expand=True)
    a = np.asarray(content, dtype=np.float32) / 255.0
    out = np.zeros((n, n), dtype=np.float32)
    ch, cw = a.shape
    # crop if larger than canvas
    if ch > n or cw > n:
        y0 = max(0, (ch - n) // 2); x0 = max(0, (cw - n) // 2)
        a = a[y0:y0 + n, x0:x0 + n]; ch, cw = a.shape
    y = (n - ch) // 2; x = (n - cw) // 2
    out[y:y + ch, x:x + cw] = a
    return out


def match_one(q: np.ndarray, dist: np.ndarray, scales, angles, topk=5):
    n = dist.shape[0]
    D = np.zeros((2 * n, 2 * n), dtype=np.float32)
    D[:n, :n] = dist
    Fd = np.fft.rfft2(D)
    ones = np.zeros_like(D); ones[:n, :n] = 1.0
    Fo = np.fft.rfft2(ones)
    results = []
    for s in scales:
        for ang in angles:
            Q = np.zeros_like(D)
            qq = place(q, n, s, ang)
            Q[:n, :n] = qq
            tot = qq.sum()
            if tot < 20:
                continue
            Fq = np.fft.rfft2(Q)
            C = np.fft.irfft2(Fd * np.conj(Fq), s=D.shape)
            V = np.fft.irfft2(Fo * np.conj(Fq), s=D.shape)
            # C[t] = sum Q[x] D[x+t]; valid overlap fraction
            score = np.where(V > 0.6 * tot, C / np.maximum(V, 1e-6), 1e9)
            # search only translations that keep a reasonable overlap
            flat = np.argpartition(score.ravel(), min(topk, score.size - 1))[:topk]
            for f in flat:
                y, x = np.unravel_index(f, score.shape)
                ty = y if y <= n else y - 2 * n
                tx = x if x <= n else x - 2 * n
                results.append((float(score[y, x]), s, ang, ty, tx, float(V[y, x] / tot)))
    results.sort(key=lambda r: r[0])
    return results


def main():
    ref = ROOT / "data" / "fp" / "beijing_20"
    roads = load_gray(ROOT / "data" / "fp" / "beijing_20_roads.png", 1024)
    dist_small = np.asarray(Image.open(ROOT / "data" / "fp" / "beijing_20_dist.png").convert("L").resize((256, 256), Image.LANCZOS), dtype=np.float32) / 4.0
    # synthetic 10 km crop at (300,400), rotated 20 deg
    crop = Image.open(ROOT / "data" / "fp" / "beijing_20_roads.png").convert("L").crop((300, 400, 812, 912))
    crop = crop.rotate(20, resample=Image.BILINEAR, expand=False)
    qimg = np.asarray(crop.resize((128, 128), Image.LANCZOS), dtype=np.float32) / 255.0
    res = match_one(qimg, dist_small, [0.5], [0, 10, 20, 30, 340, 350], topk=3)
    for r in res[:10]:
        print("score %.2f scale %.2f angle %d t=(%d,%d) valid %.2f" % r)
    print("expected t about (11,36) angle 20 scale 0.5")


if __name__ == "__main__":
    main()
