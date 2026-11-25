// Chamfer-FFT matcher: OSM distance fields vs. query road skeleton.
import { FFT2, correlate } from "./fft.js";

const D2R = Math.PI / 180;

function downsample(mask, N, M) {
  const out = new Float32Array(M * M);
  const b = N / M;
  for (let y = 0; y < M; y++) {
    const y0 = Math.floor(y * b), y1 = Math.min(N, Math.ceil((y + 1) * b));
    for (let x = 0; x < M; x++) {
      const x0 = Math.floor(x * b), x1 = Math.min(N, Math.ceil((x + 1) * b));
      let v = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { v += mask[yy * N + xx]; n++; }
      out[y * M + x] = n && v / n > 0.14 ? 1 : 0;
    }
  }
  return out;
}

// 3x3 chamfer distance transform (1, sqrt2). Used for the reverse term:
// every OSM road should also be near a lit query pixel, otherwise a dense
// reference tile can win just by having a road everywhere.
function chamfer(mask, N) {
  const INF = 1e9;
  const d = new Float32Array(N * N);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 1; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    let v = d[i];
    if (v === 0) continue;
    v = Math.min(v, d[i - N] + a);
    if (x > 0) v = Math.min(v, d[i - N - 1] + b, d[i - 1] + a);
    if (x < N - 1) v = Math.min(v, d[i - N + 1] + b);
    d[i] = v;
  }
  for (let y = N - 2; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
    const i = y * N + x;
    let v = d[i];
    if (v === 0) continue;
    v = Math.min(v, d[i + N] + a);
    if (x > 0) v = Math.min(v, d[i + N - 1] + b, d[i - 1] + a);
    if (x < N - 1) v = Math.min(v, d[i + N + 1] + b);
    d[i] = v;
  }
  return d;
}

// Place a query mask at a given scale/rotation on an N x N canvas.
function placeMask(mask, N, scale, angleDeg) {
  const out = new Float32Array(N * N);
  const a = angleDeg * D2R, ca = Math.cos(a), sa = Math.sin(a);
  const c = N / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - c) / scale, dy = (y - c) / scale;
      const qx = ca * dx + sa * dy + c;
      const qy = -sa * dx + ca * dy + c;
      const ix = Math.round(qx), iy = Math.round(qy);
      if (ix >= 0 && ix < N && iy >= 0 && iy < N) out[y * N + x] = mask[iy * N + ix];
    }
  }
  return out;
}

function orientScore(a, b) {
  // a,b: 36-bin histograms (0..255). Best circular alignment.
  let na = 0, nb = 0;
  for (let i = 0; i < 36; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return { score: 0, shift: 0 };
  na = Math.sqrt(na); nb = Math.sqrt(nb);
  let best = -1, shift = 0;
  for (let s = 0; s < 36; s++) {
    let d = 0;
    for (let i = 0; i < 36; i++) d += a[i] * b[(i + s) % 36];
    const v = d / (na * nb);
    if (v > best) { best = v; shift = s; }
  }
  return { score: best, shift };
}

function radialScore(a, b) {
  let na = 0, nb = 0, d = 0;
  for (let i = 0; i < 12; i++) { na += a[36 + i] ** 2; nb += b[36 + i] ** 2; d += a[36 + i] * b[36 + i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

export class Matcher {
  constructor(index, opts = {}) {
    this.index = index;
    this.opts = opts;
    this.base = opts.base || "data/fp/cn/";
  }

  prefilter(desc, filter = {}, limit = 24) {
    const out = [];
    const prov = filter.province || "";
    const q = (filter.query || "").trim();
    for (const e of this.index) {
      if (prov && e.province !== prov) continue;
      if (q && !(e.name.includes(q) || e.province.includes(q))) continue;
      // For a ~10 km query, compare against the 10 km centre descriptor of the
      // 20 km county tile; the full-tile radial/density profile is not scale-free.
      const refDesc = (filter.fovKm && filter.fovKm <= 15 && e.desc10) ? e.desc10 : e.desc;
      let o = orientScore(desc, refDesc);
      if (filter.descs) {
        for (const qd of filter.descs) {
          const t = orientScore(qd, refDesc);
          if (t.score > o.score) o = t;
        }
      }
      if (typeof location !== "undefined" && location.search.includes("debug=1") && e.id === "110102")
        console.log("BJ_SHIFT", o.shift, o.shift * 5, o.score.toFixed(3));
      const r = radialScore(desc, refDesc);
      const dens = 1 - Math.min(1, Math.abs(desc[48] - refDesc[48]) / 64);
      // A 10 km crop changes the radial/density profile; orientation is the
      // only scale-free cue at this stage. Keep a small radial tie-breaker.
      const small = filter.fovKm && filter.fovKm <= 15;
      const score = small ? 0.92 * o.score + 0.08 * r : 0.66 * o.score + 0.22 * r + 0.12 * dens;
      if (typeof location !== "undefined" && location.search.includes("debug=1") && e.id === "110105")
        console.log("BJ_COMP", o.score.toFixed(3), r.toFixed(3), dens.toFixed(3), "desc48", desc[48], e.desc[48]);
      out.push({ entry: e, pre: score, o: o.score, shift: o.shift });
    }
    out.sort((a, b) => b.pre - a.pre);
    if (typeof location !== "undefined" && location.search.includes("debug=1")) {
      const byO = [...out].sort((a, b) => b.o - a.o);
      const bj = byO.find((x) => x.entry.id === "110105");
      if (bj) console.log("PREFILTER_BJ_O", bj.o.toFixed(3), "rank", byO.indexOf(bj), "of", byO.length);
      const bc = out.findIndex((x) => x.entry.id === "110105");
      if (bc >= 0) console.log("PREFILTER_BJ_C", bc, out[bc].pre.toFixed(3), "small", filter.fovKm);
    }
    return out.slice(0, limit);
  }

  tileUrl(e, kind) {
    return `${this.base}${e.province_adcode}/${e.id}_${kind}.png`;
  }

  async loadDistance(e, N) {
    const url = this.tileUrl(e, "d");
    if (!this._cache) this._cache = new Map();
    const key = url + "@" + N;
    if (this._cache.has(key)) return this._cache.get(key);
    const img = await loadBitmap(url);
    const c = document.createElement("canvas");
    c.width = N; c.height = N;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;
    const d = new Float32Array(N * N);
    const s = 4 * N / 384; // PNG value -> px at this resolution
    for (let i = 0, j = 0; i < px.length; i += 4, j++) d[j] = px[i] * s;
    const v = { dist: d, img };
    if (this._cache.size > 80) this._cache.clear();
    this._cache.set(key, v);
    return v;
  }

  async loadRoads(e, N) {
    const url = this.tileUrl(e, "r");
    if (!this._roads) this._roads = new Map();
    const key = url + "@" + N;
    if (this._roads.has(key)) return this._roads.get(key);
    const img = await loadBitmap(url);
    const c = document.createElement("canvas");
    c.width = N; c.height = N;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const px = ctx.getImageData(0, 0, N, N).data;
    const r = new Uint8Array(N * N);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) r[j] = px[i] > 127 ? 1 : 0;
    if (this._roads.size > 80) this._roads.clear();
    this._roads.set(key, r);
    return r;
  }

  async match(mask, desc, filter = {}, onProgress = () => {}) {
    // The pilot index is small enough to coarse-scan all counties. For the
    // national index this is capped at 96 and the orientation-only prefilter
    // is deliberately permissive; the fine stage is the expensive part.
    const coarse = this.prefilter(desc, filter, 32);
    if (!coarse.length) return [];
    const N0 = 128;
    const mask0 = downsample(mask, 256, N0);
    const fft0 = new FFT2(N0 * 2);
    const sum0 = mask0.reduce((a, b) => a + b, 0);
    // Original skeleton mass; placeMask crops the query when scale > 1, so
    // compare the placed mass against this to reject "zoom into 5 km" cheats.
    const total0 = sum0;
    if (sum0 < 12) return [];

    // Precompute the "ones" correlation kernel once.
    const onesRe = new Float64Array((2 * N0) ** 2), onesIm = new Float64Array((2 * N0) ** 2);
    for (let y = 0; y < N0; y++) for (let x = 0; x < N0; x++) onesRe[y * 2 * N0 + x] = 1;
    fft0.forward(onesRe, onesIm);

    const hint = Number(filter.fovKm) || 0;
    const scales0 = hint
      ? [hint / 20]
      : [0.40, 0.55, 0.75, 1.0, 1.4];
    const angles0 = Array.from({ length: 12 }, (_, i) => i * 30);
    const best = new Map();
    const bjScales = new Map();
    let done = 0, total = coarse.length * scales0.length * angles0.length;

    for (const cand of coarse) {
      let roads;
      try { roads = await this.loadRoads(cand.entry, N0); } catch { continue; }
      let refN = 0;
      const rRe = new Float64Array((2 * N0) ** 2), rIm = new Float64Array((2 * N0) ** 2);
      for (let y = 0; y < N0; y++) for (let x = 0; x < N0; x++) {
        const i = y * N0 + x;
        if (roads[i]) { refN++; rRe[y * 2 * N0 + x] = 1; }
      }
      fft0.forward(rRe, rIm);
      let b = null;
      for (const s of scales0) {
        for (const a of angles0) {
          const Q = placeMask(mask0, N0, s, a);
          const qRe = new Float64Array((2 * N0) ** 2), qIm = new Float64Array((2 * N0) ** 2);
          let sq = 0;
          for (let y = 0; y < N0; y++) for (let x = 0; x < N0; x++) {
            const v = Q[y * N0 + x]; qRe[y * 2 * N0 + x] = v; sq += v;
          }
          if (sq < 8) { done++; continue; }
          fft0.forward(qRe, qIm);
          // One correlation is enough for scale/rotation ranking: raw
          // road-vs-query overlap, normalized into NCC. The old chamfer
          // variants are kept only for the fine stage.
          const rr = new Float64Array((2 * N0) ** 2), ri = new Float64Array((2 * N0) ** 2);
          correlate(fft0, rRe, rIm, qRe, qIm, rr, ri);
          let bestCorr = -1, bt = null;
          const denom = Math.sqrt(sq * refN + 1e-6);
          for (let y = 0; y < 2 * N0; y++) {
            for (let x = 0; x < 2 * N0; x++) {
              const i = y * 2 * N0 + x;
              const corr = rr[i] / denom;
              if (corr > bestCorr) {
                bestCorr = corr;
                bt = [y > N0 ? y - 2 * N0 : y, x > N0 ? x - 2 * N0 : x];
              }
            }
          }
          if (bt) {
            const combined = -bestCorr;
            if (cand.entry.id.startsWith("1101") && (!bjScales.has(s) || combined < bjScales.get(s).combined))
              bjScales.set(s, { combined, q2r: 0, r2q: 0, ncc: bestCorr, scalePen: 0, densPen: 0, angle: a });
            if (!b || combined < b.mean) b = { mean: combined, corr: bestCorr, scale: s, angle: a, tx: bt[1], ty: bt[0], overlap: 1 };
          }
          done++;
          if ((done & 31) === 0) onProgress({ stage: "coarse", done, total });
        }
      }
      if (b) best.set(cand.entry.id, { entry: cand.entry, coarse: b, pre: cand.pre });
    }
    if (!best.size) return [];
    const rankedAll = [...best.values()].sort((a, b) => a.coarse.mean - b.coarse.mean);
    if (typeof location !== "undefined" && location.search.includes("debug=1")) {
      const bi = rankedAll.findIndex((x) => x.entry.id.startsWith("1101"));
      if (bi >= 0) console.log("BJ_COARSE_RANK", bi, rankedAll[bi].coarse.corr.toFixed(3), rankedAll[bi].coarse.angle);
    }
    if (typeof location !== "undefined" && location.search.includes("debug=1"))
      console.log("RANKED16", rankedAll.slice(0, 16).map((x) => `${x.entry.name}:${x.coarse.corr.toFixed(3)}@a${x.coarse.angle}`).join(" "));
    const ranked = rankedAll.slice(0, 8);
    if (typeof location !== "undefined" && location.search.includes("debug=1")) {
      console.log("COARSE", [...best.values()].sort((a, b) => a.coarse.mean - b.coarse.mean).slice(0, 10)
        .map((x) => `${x.entry.name}:${x.coarse.mean.toFixed(2)}@s${x.coarse.scale.toFixed(2)}a${x.coarse.angle}`).join(" "));
      const bj = best.get("110105") || best.get("110101");
      if (bj) console.log("COARSE_BJ", bj.coarse.mean.toFixed(2), bj.coarse.scale, bj.coarse.angle);
      console.log("BJ_SCALES", [...bjScales.entries()].map(([s, v]) => `${s}:${v.combined.toFixed(2)}(q${v.q2r.toFixed(2)} r${v.r2q.toFixed(2)} ncc${v.ncc.toFixed(3)} dp${v.densPen.toFixed(2)} sp${v.scalePen.toFixed(2)} a${v.angle})`).join(" "));
    }

    // Fine stage at 256.
    const N = 256;
    const fft = new FFT2(N * 2);
    const onesRe2 = new Float64Array((2 * N) ** 2), onesIm2 = new Float64Array((2 * N) ** 2);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) onesRe2[y * 2 * N + x] = 1;
    fft.forward(onesRe2, onesIm2);
    const sum = mask.reduce((a, b) => a + b, 0);
    const results = [];
    done = 0; total = ranked.length * (hint ? 1 : 3) * (hint ? 5 : 7);
    for (const cand of ranked) {
      let ref, roads;
      try { ref = await this.loadDistance(cand.entry, N); roads = await this.loadRoads(cand.entry, N); } catch { continue; }
      const rRe = new Float64Array((2 * N) ** 2), rIm = new Float64Array((2 * N) ** 2);
      let refN = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (roads[y * N + x]) { refN++; rRe[y * 2 * N + x] = 1; }
      }
      fft.forward(rRe, rIm);
      let b = null;
      const angleMixes = [];
      const s0 = cand.coarse.scale, a0 = cand.coarse.angle;
      for (const s of (hint ? [s0] : [s0 * 0.82, s0, s0 * 1.18])) {
        // With a known FOV, scan all 24 orientations: a 30-deg coarse grid can
        // land 45 deg away on a self-similar grid, and +-8 refinement then
        // never reaches the true orientation. Without a prior, refine the two
        // 180-deg-ambiguous coarse peaks over +-30.
        // Without a trustworthy orientation prior, scan all 24.  A square
        // grid is 90° self-similar, so the coarse peak is often one quadrant
        // off; restricting to it would lock that error in.
        const angles = hint
          ? Array.from({ length: 24 }, (_, i) => i * 15)
          : [a0 - 30, a0 - 25, a0 - 20, a0 - 15, a0 - 10, a0 - 5, a0,
             a0 + 5, a0 + 10, a0 + 15, a0 + 20, a0 + 25, a0 + 30,
             a0 + 150, a0 + 155, a0 + 160, a0 + 165, a0 + 170, a0 + 175,
             a0 + 180, a0 + 185, a0 + 190, a0 + 195, a0 + 200, a0 + 205,
             a0 + 210];
        for (const a of angles) {
          {
          const Q = placeMask(mask, N, s, a);
          let sq = 0;
          const qRe = new Float64Array((2 * N) ** 2), qIm = new Float64Array((2 * N) ** 2);
          for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const v = Q[y * N + x]; qRe[y * 2 * N + x] = v; sq += v;
          }
          if (sq < 40) { done++; continue; }
          fft.forward(qRe, qIm);
          const rr = new Float64Array((2 * N) ** 2), ri = new Float64Array((2 * N) ** 2);
          correlate(fft, rRe, rIm, qRe, qIm, rr, ri);
          let bestCorr = -1, bt = null;
          const denom = Math.sqrt(sq * refN + 1e-6);
          for (let y = 0; y < 2 * N; y++) {
            for (let x = 0; x < 2 * N; x++) {
              const i = y * 2 * N + x;
              const corr = rr[i] / denom;
              if (corr > bestCorr) {
                bestCorr = corr;
                bt = [y > N ? y - 2 * N : y, x > N ? x - 2 * N : x];
              }
            }
          }
          if (bt) {
            // A city grid is nearly 90° self-similar, so pure NCC can lock
            // onto a rotation that is 90°/180° off.  Mix in the exact road
            // overlap at this transform: the true orientation puts far more
            // query pixels on OSM roads than a rotated copy of the same grid.
            let onRoad = 0, qn = 0;
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
              if (!Q[y * N + x]) continue;
              const rx = x + bt[1], ry = y + bt[0];
              if (rx < 0 || rx >= N || ry < 0 || ry >= N) continue;
              qn++;
              if (roads[ry * N + rx]) onRoad++;
            }
            const exact = qn ? onRoad / qn : 0;
            const mix = bestCorr + 0.45 * exact;
            angleMixes.push({ a: ((a % 360) + 360) % 360, mix });
            if (!b || mix > b.mix) b = { corr: bestCorr, mix, scale: s, angle: ((a % 360) + 360) % 360, tx: bt[1], ty: bt[0] };
          }
          done++;
          if ((done & 7) === 0) onProgress({ stage: "fine", done, total });
          }
        }
      }
      if (!b) continue;
      // Direct metrics at the NCC-selected transform.
      const Q = placeMask(mask, N, b.scale, b.angle);
      let hit = 0, n = 0, inter = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (!Q[y * N + x]) continue;
        const rx = x + b.tx, ry = y + b.ty;
        if (rx < 0 || rx >= N || ry < 0 || ry >= N) continue;
        n++;
        if (roads[ry * N + rx]) inter++;
        if (ref.dist[ry * N + rx] < 3.2) hit++;
      }
      const overlap = n / Math.max(1, sum);
      const hitRate = n ? hit / n : 0;
      const ncc = inter / Math.sqrt(Math.max(1, n) * Math.max(1, refN) + 1e-6);
      const fit = Math.min(1, b.corr / 0.55);
      const reliability = Math.min(1, overlap / 0.22);
      // Reverse coverage: every OSM road inside the placed query footprint
      // should be near a lit query pixel. This is what separates a correct
      // 10 km crop from a dense grid that merely contains some matching roads.
      const qdist = chamfer(Q, N);
      let refIn = 0, refCovered = 0;
      const half = Math.ceil(N * b.scale / 2) + 1;
      for (let ry = Math.max(0, N/2 - half + b.ty); ry < Math.min(N, N/2 + half + b.ty); ry++) {
        for (let rx = Math.max(0, N/2 - half + b.tx); rx < Math.min(N, N/2 + half + b.tx); rx++) {
          if (!roads[ry * N + rx]) continue;
          refIn++;
          const x = rx - b.tx, y = ry - b.ty;
          if (x >= 0 && x < N && y >= 0 && y < N && qdist[y * N + x] < 3.0) refCovered++;
        }
      }
      const reverse = refIn ? refCovered / refIn : 0;
      // Symmetric overlap, not a one-sided "does the query sit on some road".
      // A wrong dense grid can give hitRate=1 while most of its roads are not
      // covered by the query; only F1 exposes that.  This is also what keeps
      // the displayed percentage honest: 30% overlap cannot read as 80%.
      const precision = n ? inter / n : 0;
      const f1 = precision + reverse > 1e-6 ? 2 * precision * reverse / (precision + reverse) : 0;
      // Coarse NCC is computed over all translations and is more stable than
      // the fine-stage peak on a self-similar grid; keep it as a prior.
      const hintScale = hint ? hint / 20 : 0;
      const fovPen = hintScale ? 18 * Math.abs(b.scale - hintScale) / hintScale : 0;
      // Rotation uniqueness: a square city grid is 90° self-similar, so a
      // wrong orientation can score as well as the right one.  If another
      // orientation at least 30° away is within 1.5% of the winner, the
      // direction is not actually determined; lower the confidence instead
      // of presenting a lucky rotation as certain.
      let alt = -1;
      for (const t of angleMixes) {
        const d = Math.abs(((t.a - b.angle + 540) % 360) - 180);
        if (d > 30 && t.mix > alt) alt = t.mix;
      }
      const rotMargin = alt < 0 ? 1 : b.mix - alt;
      const rotUncertain = alt >= 0 && rotMargin < 0.015;
      const sim0 = Math.max(0, Math.min(100, 100 * (0.82 * f1 + 0.10 * fit + 0.08 * Math.min(1, b.corr / 0.45)) - fovPen));
      const sim = rotUncertain ? sim0 * 0.82 : sim0;
      if (typeof location !== "undefined" && location.search.includes("debug=1") && cand.entry.id.startsWith("1101"))
        console.log("RESULT_BJ", cand.entry.name, sim.toFixed(2), "corr", b.corr.toFixed(3), "hit", hitRate.toFixed(2), "rev", reverse.toFixed(2), "s", b.scale.toFixed(3), "a", b.angle);
      if (typeof location !== "undefined" && location.search.includes("debug=1"))
        console.log("DBG", cand.entry.name, "sim", sim.toFixed(2), "fit", fit.toFixed(3),
          "hit", hitRate.toFixed(3), "rev", reverse.toFixed(3), "ov", overlap.toFixed(3),
          "P", precision.toFixed(3), "F1", f1.toFixed(3), "ncc", ncc.toFixed(3), "s", b.scale.toFixed(2), "a", b.angle);
      results.push({
        entry: cand.entry, sim, mean: 0, hit: hitRate, reverse, overlap, ncc, precision, f1,
        scale: b.scale, angle: b.angle, tx: b.tx, ty: b.ty, rotMargin, rotUncertain,
        fovKm: 20 * b.scale,
      });
    }
    results.sort((a, b) => b.sim - a.sim);
    onProgress({ stage: "done", done: total, total });
    return results.slice(0, 6);
  }
}

function loadBitmap(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("tile load failed: " + url));
    im.src = url;
  });
}

export { downsample, placeMask };
