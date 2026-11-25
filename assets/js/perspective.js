// Line-based affine rectification: fit the lit road lattice, estimate the two
// vanishing points, then move the horizon to infinity.  No cloud/sky pixels
// are involved because every line comes from the skeleton mask.
import { makeCanvas } from "./preprocess.js";

function houghLines(mask, N) {
  const pts = [];
  for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) {
    if (mask[y * N + x]) pts.push([x, y]);
  }
  if (pts.length < 80) return { lines: [] };
  const step = Math.max(1, Math.floor(pts.length / 6000));
  const TH = 180, D = Math.ceil(N * 1.42);
  const acc = new Uint16Array(TH * (2 * D + 1));
  const cs = new Float32Array(TH), sn = new Float32Array(TH);
  for (let t = 0; t < TH; t++) { cs[t] = Math.cos(t * Math.PI / 180); sn[t] = Math.sin(t * Math.PI / 180); }
  for (let i = 0; i < pts.length; i += step) {
    const [x, y] = pts[i];
    for (let t = 0; t < TH; t++) acc[t * (2 * D + 1) + Math.round(x * cs[t] + y * sn[t]) + D]++;
  }
  const peaks = [];
  const copy = acc.slice();
  for (let k = 0; k < 36; k++) {
    let bi = 0, bv = 0;
    for (let i = 0; i < copy.length; i++) if (copy[i] > bv) { bv = copy[i]; bi = i; }
    if (bv < 10) break;
    const t = Math.floor(bi / (2 * D + 1)), r = bi % (2 * D + 1) - D;
    peaks.push({ t, r, v: bv });
    for (let dt = -3; dt <= 3; dt++) {
      const tt = (t + dt + TH) % TH;
      for (let dr = -5; dr <= 5; dr++) {
        const rr = r + dr + D;
        if (rr >= 0 && rr < 2 * D + 1) copy[tt * (2 * D + 1) + rr] = 0;
      }
    }
  }
  return { lines: peaks };
}

function fitVP(lines) {
  // solve [a b] (x,y) = r  in least squares
  let aa = 0, ab = 0, bb = 0, ar = 0, br = 0;
  for (const l of lines) {
    const a = Math.cos(l.t * Math.PI / 180), b = Math.sin(l.t * Math.PI / 180);
    const w = Math.min(4, l.v / 40);
    aa += a * a * w; ab += a * b * w; bb += b * b * w;
    ar += a * l.r * w; br += b * l.r * w;
  }
  const det = aa * bb - ab * ab;
  if (Math.abs(det) < 1e-6) return null;
  return [(ar * bb - br * ab) / det, (br * aa - ar * ab) / det];
}

function angleDist(a, b) {
  let d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

export function autoRectify(ext, outSize = 640) {
  const N = ext.size, mask = ext.mask;
  let lines = [];
  if (ext.graph && ext.graph.segments && ext.graph.segments.length > 12) {
    // Fit lines to graph edges, not raw pixels: each segment votes with its length.
    const sc = N / ext.sourceSide;
    for (const g of ext.graph.segments) {
      let x1 = g.x1 * sc, y1 = g.y1 * sc, x2 = g.x2 * sc, y2 = g.y2 * sc;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      if (len < 5) continue;
      const dir = Math.atan2(dy, dx) * 180 / Math.PI;
      const t = ((dir + 90) % 180 + 180) % 180;
      const r = (x1 + x2) / 2 * Math.cos(t * Math.PI / 180) + (y1 + y2) / 2 * Math.sin(t * Math.PI / 180);
      lines.push({ t: Math.round(t), r, v: len });
    }
  }
  if (lines.length < 6) lines = houghLines(mask, N).lines;
  if (lines.length < 6) return null;
  // weighted orientation histogram
  const bins = new Float32Array(36);
  for (const l of lines) bins[Math.floor(l.t / 5) % 36] += l.v;
  let a0 = 0;
  for (let i = 0; i < 36; i++) if (bins[i] > bins[a0]) a0 = i;
  a0 = a0 * 5 + 2;
  let a1 = -1, best = 0;
  for (let i = 0; i < 36; i++) {
    const a = i * 5 + 2;
    if (angleDist(a, a0) < 30) continue;
    if (bins[i] > best) { best = bins[i]; a1 = a; }
  }
  if (a1 < 0) return null;
  const L0 = lines.filter((l) => angleDist(l.t, a0) < 14);
  const L1 = lines.filter((l) => angleDist(l.t, a1) < 14);
  if (L0.length < 3 || L1.length < 3) return null;
  const v0 = fitVP(L0), v1 = fitVP(L1);
  if (!v0 || !v1) return null;
  const V0 = [v0[0], v0[1], 1], V1 = [v1[0], v1[1], 1];
  let l = [
    V0[1] * V1[2] - V0[2] * V1[1],
    V0[2] * V1[0] - V0[0] * V1[2],
    V0[0] * V1[1] - V0[1] * V1[0],
  ];
  if (Math.abs(l[2]) < 1e-9) return null;
  l = l.map((v) => v / l[2]);
  // discard near-degenerate or absurd horizons
  if (Math.hypot(l[0], l[1]) < 1e-5) return null;
  const H = [1, 0, 0, 0, 1, 0, l[0], l[1], 1];

  // project mask points, take robust bbox in rectified space
  const rs = [];
  for (let y = 0; y < N; y += 2) for (let x = 0; x < N; x += 2) {
    if (!mask[y * N + x]) continue;
    const w = l[0] * x + l[1] * y + 1;
    if (w <= 1e-4) continue;
    rs.push([x / w, y / w]);
  }
  if (rs.length < 50) return null;
  // Near-identity horizon means the fit found no usable perspective.
  if (Math.hypot(l[0], l[1]) < 1.5e-4) return null;
  rs.sort((a, b) => a[0] - b[0]); const x0 = rs[Math.floor(rs.length * .02)][0], x1 = rs[Math.floor(rs.length * .98)][0];
  rs.sort((a, b) => a[1] - b[1]); const y0 = rs[Math.floor(rs.length * .02)][1], y1 = rs[Math.floor(rs.length * .98)][1];
  if (!(x1 > x0 && y1 > y0)) return null;
  // Reject degenerate solutions: a horizon through the city, or a projected
  // span far outside the working mask, produces smeared garbage.
  const cx = N / 2, cy = N / 2;
  const horizonDist = Math.abs(l[0] * cx + l[1] * cy + 1) / Math.hypot(l[0], l[1]);
  if (horizonDist < N * 0.12) return null;
  if ((x1 - x0) > N * 2.5 || (y1 - y0) > N * 2.5 || (x1 - x0) < N * 0.12 || (y1 - y0) < N * 0.12) return null;
  const aspect = (x1 - x0) / Math.max(1e-6, y1 - y0);
  if (aspect > 5 || aspect < 0.2) return null;

  const side = ext.sourceSide;
  const src = ext.preview;
  const out = makeCanvas(outSize, outSize);
  const octx = out.getContext("2d");
  const sctx = src.getContext("2d", { willReadFrequently: true });
  const sd = sctx.getImageData(0, 0, side, side);
  const od = octx.createImageData(outSize, outSize);
  const sy = (side / N);
  for (let Y = 0; Y < outSize; Y++) for (let X = 0; X < outSize; X++) {
    const rx = x0 + (X / outSize) * (x1 - x0);
    const ry = y0 + (Y / outSize) * (y1 - y0);
    const w = 1 - l[0] * rx - l[1] * ry;
    if (w <= 1e-5) continue;
    const px = Math.round(rx / w * sy), py = Math.round(ry / w * sy);
    if (px < 0 || py < 0 || px >= side || py >= side) continue;
    const si = (py * side + px) * 4, di = (Y * outSize + X) * 4;
    od.data[di] = sd.data[si]; od.data[di + 1] = sd.data[si + 1]; od.data[di + 2] = sd.data[si + 2]; od.data[di + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return { canvas: out, v0, v1, horizon: l, lines: lines.length };
}
