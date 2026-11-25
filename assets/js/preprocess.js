// Query-image preprocessing: night lights -> thin bright-line mask.
// Pure Canvas 2D + typed arrays.

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

function morph1d(src, dst, w, h, r, horizontal, takeMin) {
  const win = r * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = takeMin ? 255 : 0;
        const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
        for (let k = a; k <= b; k++) {
          const t = src[row + k];
          if (takeMin ? t < v : t > v) v = t;
        }
        dst[row + x] = v;
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = takeMin ? 255 : 0;
        const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
        for (let k = a; k <= b; k++) {
          const t = src[k * w + x];
          if (takeMin ? t < v : t > v) v = t;
        }
        dst[y * w + x] = v;
      }
    }
  }
}

function morphology(gray, w, h, r, takeMin) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  morph1d(gray, tmp, w, h, r, true, takeMin);
  morph1d(tmp, out, w, h, r, false, takeMin);
  return out;
}

// Remove small connected components. Street lights form long chains; windows,
// signs and facade highlights form compact blobs that survive thinning.
function pruneComponents(skel, w, h, minSize) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let start = 0; start < skel.length; start++) {
    if (!skel[start] || seen[start]) continue;
    let top = 0, n = 0;
    stack[top++] = start; seen[start] = 1;
    const comp = [];
    while (top) {
      const i = stack[--top]; comp.push(i); n++;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (skel[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    let drop = n < minSize;
    if (!drop && n >= 40) {
      // Compact facade/window clusters are round; lit streets are elongated.
      let sx = 0, sy = 0;
      for (const i of comp) { sx += i % w; sy += (i / w) | 0; }
      const mx = sx / n, my = sy / n;
      let cxx = 0, cyy = 0, cxy = 0;
      for (const i of comp) {
        const dx = (i % w) - mx, dy = ((i / w) | 0) - my;
        cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
      }
      cxx /= n; cyy /= n; cxy /= n;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = Math.max(1e-3, tr / 2 - disc);
      if (l1 / l2 < 2.2 && Math.max(l1, l2) < 90) drop = true;
    }
    if (drop) for (const i of comp) skel[i] = 0;
  }
}


function pruneSpurs(skel, w, h, maxLen = 6) {
  const deg = (i) => {
    const x = i % w, y = (i / w) | 0;
    let d = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) d += skel[yy * w + xx];
    }
    return d;
  };
  for (let pass = 0; pass < 2; pass++) {
    const ends = [];
    for (let i = 0; i < skel.length; i++) if (skel[i] && deg(i) === 1) ends.push(i);
    for (const e of ends) {
      if (!skel[e]) continue;
      const path = [e];
      let cur = e, prev = -1, hitJunction = false;
      for (let k = 0; k < maxLen; k++) {
        const x = cur % w, y = (cur / w) | 0;
        let next = -1;
        for (let dy = -1; dy <= 1 && next < 0; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (j !== prev && skel[j]) { next = j; break; }
        }
        if (next < 0) break;
        if (deg(next) >= 3) { hitJunction = true; break; }
        path.push(next); prev = cur; cur = next;
      }
      if (hitJunction && path.length <= maxLen) for (const i of path) skel[i] = 0;
    }
  }
}


function keepCoherent(bin, hat, w, h) {
  const gx = new Int16Array(w * h), gy = new Int16Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    gx[i] = (hat[i - w + 1] + 2 * hat[i + 1] + hat[i + w + 1]) -
            (hat[i - w - 1] + 2 * hat[i - 1] + hat[i + w - 1]);
    gy[i] = (hat[i + w - 1] + 2 * hat[i + w] + hat[i + w + 1]) -
            (hat[i - w - 1] + 2 * hat[i - w] + hat[i - w + 1]);
  }
  const R = 3, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!bin[i]) continue;
    let xx = 0, yy = 0, xy = 0, n = 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy0 = y + dy; if (yy0 < 0 || yy0 >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx0 = x + dx; if (xx0 < 0 || xx0 >= w) continue;
        const j = yy0 * w + xx0, a = gx[j], b = gy[j];
        xx += a * a; yy += b * b; xy += a * b; n++;
      }
    }
    if (!n) { out[i] = 1; continue; }
    const tr = xx + yy, det = xx * yy - xy * xy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const coh = tr > 1e-6 ? disc / (tr / 2) : 0;
    out[i] = coh > 0.34 ? 1 : 0;
  }
  for (let i = 0; i < bin.length; i++) bin[i] &= out[i];
}


function blur1(src, dst, w, h, r, horizontal) {
  const k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * r * r / 4)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  if (horizontal) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let j = -r; j <= r; j++) { const xx = Math.min(w - 1, Math.max(0, x + j)); v += src[y * w + xx] * k[j + r]; }
      dst[y * w + x] = v;
    }
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let j = -r; j <= r; j++) { const yy = Math.min(h - 1, Math.max(0, y + j)); v += src[yy * w + x] * k[j + r]; }
      dst[y * w + x] = v;
    }
  }
}

// Frangi vesselness at one scale: bright ridges (roads) are strongly negative
// in the Hessian's largest eigenvalue, while blobs are isotropic.
function frangiScale(src, w, h, sigma) {
  const r = Math.max(1, Math.round(sigma));
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  blur1(src, a, w, h, r, true); blur1(a, b, w, h, r, false);
  const out = new Float32Array(w * h);
  const s2 = sigma * sigma;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const dxx = (b[i - w] + b[i + w] - 2 * b[i]) / s2;
    const dyy = (b[i - 1] + b[i + 1] - 2 * b[i]) / s2;
    const dxy = (b[i - w - 1] + b[i + w + 1] - b[i - w + 1] - b[i + w - 1]) / (4 * s2);
    const tr = dxx + dyy, det = dxx * dyy - dxy * dxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    // sort by absolute value
    const big = Math.abs(l1) > Math.abs(l2) ? l1 : l2;
    const small = Math.abs(l1) > Math.abs(l2) ? l2 : l1;
    if (big >= 0) continue;
    const rb = small / (big - 1e-9);
    const S = Math.hypot(big, small);
    const v = Math.exp(-(rb * rb) / (2 * 0.6 * 0.6)) * (1 - Math.exp(-(S * S) / (2 * 40 * 40)));
    if (v > out[i]) out[i] = v;
  }
  return out;
}

function frangi(src, w, h) {
  const a = frangiScale(src, w, h, 1.1);
  const b = frangiScale(src, w, h, 2.2);
  const c = frangiScale(src, w, h, 3.6);
  for (let i = 0; i < a.length; i++) { if (b[i] > a[i]) a[i] = b[i]; if (c[i] > a[i]) a[i] = c[i]; }
  return a;
}


function hysteresis(strong, weak, w, h) {
  const out = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < out.length; i++) if (strong[i]) { out[i] = 1; stack[sp++] = i; }
  while (sp) {
    const i = stack[--sp], x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!out[j] && weak[j]) { out[j] = 1; stack[sp++] = j; }
    }
  }
  return out;
}


// Trace the thinned skeleton into nodes (degree != 2) and edges.  This is the
// structural representation used by line fitting and, later, graph matching.
function traceGraph(skel, w, h) {
  const deg = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!skel[i]) continue;
    let d = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && skel[i + dy * w + dx]) d++;
    deg[i] = d;
  }
  const seen = new Uint8Array(w * h), segs = [], nodes = [];
  const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const s = y * w + x;
    if (!skel[s] || deg[s] === 2 || seen[s]) continue;
    nodes.push([x, y]);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
      let j = ny * w + nx;
      if (!skel[j] || seen[j]) continue;
      const path = [[x, y]];
      let px = x, py = y, cx = nx, cy = ny, guard = 0;
      while (guard++ < 4000) {
        path.push([cx, cy]); seen[cx + cy * w] = 1;
        if (deg[cx + cy * w] !== 2) break;
        let nxt = -1;
        for (const [ex, ey] of dirs) {
          const xx = cx + ex, yy = cy + ey;
          if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
          const k = yy * w + xx;
          if (k === px + py * w || !skel[k]) continue;
          nxt = k; px = cx; py = cy; cx = xx; cy = yy; break;
        }
        if (nxt < 0) break;
      }
      if (path.length >= 6) {
        const a = path[0], b = path[path.length - 1];
        // drop tiny hairline edges; keep coordinates for line fitting
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 5) segs.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], n: path.length });
      }
    }
  }
  return { nodes, segments: segs };
}

// Zhang-Suen thinning, returns a 0/1 Uint8Array
export function thin(bin, w, h) {
  let img = bin;
  const idx = (x, y) => y * w + x;
  for (let iter = 0; iter < 14; iter++) {
    let changed = 0;
    for (let step = 0; step < 2; step++) {
      const del = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = idx(x, y);
          if (!img[i]) continue;
          const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1];
          const p5 = img[i + w + 1], p6 = img[i + w], p7 = img[i + w - 1];
          const p8 = img[i - 1], p9 = img[i - w - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          let A = 0;
          if (!p2 && p3) A++; if (!p3 && p4) A++; if (!p4 && p5) A++;
          if (!p5 && p6) A++; if (!p6 && p7) A++; if (!p7 && p8) A++;
          if (!p8 && p9) A++; if (!p9 && p2) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 && p4 && p6) continue;
            if (p4 && p6 && p8) continue;
          } else {
            if (p2 && p4 && p8) continue;
            if (p2 && p6 && p8) continue;
          }
          del.push(i);
        }
      }
      for (const i of del) img[i] = 0;
      changed += del.length;
    }
    if (!changed) break;
  }
  // drop isolated pixels (0 or 1 neighbours)
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = idx(x, y);
      if (!img[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) n += img[i + dy * w + dx];
      }
      if (n >= 2) out[i] = 1;
    }
  }
  return out;
}

// Grayscale morphological opening (erosion then dilation).  A night road is
// a thin bright ridge on a darker ground; opening estimates that ground and
// the subtraction is the top-hat that removes clouds and broad facade glow.
function minMaxGray(src, w, h, r, takeMin) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) {
        const s = src[row + k];
        if (takeMin ? s < v : s > v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) {
        const s = tmp[k * w + x];
        if (takeMin ? s < v : s > v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function openGray(src, w, h, r) {
  return minMaxGray(minMaxGray(src, w, h, r, true), w, h, r, false);
}

function percentile(arr, p) {
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max <= 0) return 0;
  const bins = new Uint32Array(1024);
  const k = 1023 / max;
  for (let i = 0; i < arr.length; i++) bins[Math.min(1023, Math.max(0, (arr[i] * k) | 0))]++;
  const target = arr.length * p;
  let acc = 0;
  for (let i = 0; i < 1024; i++) {
    acc += bins[i];
    if (acc >= target) return (i + 0.5) * max / 1024;
  }
  return max;
}

// Local mean / standard deviation via integral images.  A global percentile
// makes bright CBD blocks merge into one blob while dim streets disappear;
// the threshold has to follow the local background.
function localMeanStd(src, w, h, r) {
  const W = w + 1;
  const I = new Float64Array(W * (h + 1));
  const I2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      rs += v; rs2 += v * v;
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rs;
      I2[(y + 1) * W + x + 1] = I2[y * W + x + 1] + rs2;
    }
  }
  const mean = new Float32Array(w * h), sd = new Float32Array(w * h);
  const box = (A, x0, y0, x1, y1) => A[y1 * W + x1] - A[y0 * W + x1] - A[y1 * W + x0] + A[y0 * W + x0];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = box(I, x0, y0, x1, y1) / n;
      const v = Math.max(0, box(I2, x0, y0, x1, y1) / n - m * m);
      mean[y * w + x] = m;
      sd[y * w + x] = Math.sqrt(v);
    }
  }
  return { mean, sd };
}

// A road is a long thin ridge; a building is a compact blob.  A plain local
// threshold cannot tell them apart, so score each pixel by the best response
// to a short oriented line kernel, then subtract the isotropic background.
// This is the structural part that thresholding alone was missing.
function boxBlur(src, w, h, r) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1]
        - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function lineResponse(src, side, L = 11) {
  const out = new Float32Array(side * side);
  const half = L >> 1;
  const angles = Array.from({length: 12}, (_, i) => i * 15);
  for (const deg of angles) {
    const th = deg * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        let sum = 0, n = 0;
        for (let k = -half; k <= half; k++) {
          const sx = Math.round(x + dx * k), sy = Math.round(y + dy * k);
          if (sx < 0 || sy < 0 || sx >= side || sy >= side) continue;
          sum += src[sy * side + sx]; n++;
        }
        const i = y * side + x;
        const v = n ? sum / n : 0;
        if (v > out[i]) out[i] = v;
      }
    }
  }
  return out;
}

// Keep long horizontal / vertical runs of a weak top-hat response.  The
// faint cross streets in the Linquan photo are continuous for tens of pixels
// but never clear a local threshold; run length is the evidence that they are
// streets rather than texture.
function runLengthMask(src, side, threshold, minRun, seed) {
  // Faint streets are dashed and often a few degrees off the image axes.
  // A single 0/90 run test only recovers the perfectly aligned ones, so scan
  // 12 directions and allow up to two missing pixels inside a run.
  const out = new Uint8Array(side * side);
  const maxGap = 3, minSupport = 0.75;
  const angles = Array.from({length: 12}, (_, i) => i * 15);
  for (const deg of angles) {
    const th = deg * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        if (src[y * side + x] <= threshold) continue;
        let last = -1, support = 0, gap = 0, anchors = 0;
        for (let k = 0; k < minRun * 2; k++) {
          const sx = Math.round(x + dx * k), sy = Math.round(y + dy * k);
          if (sx < 0 || sy < 0 || sx >= side || sy >= side) break;
          if (src[sy * side + sx] > threshold) {
            last = k; support++; gap = 0;
            if (seed && seed[sy * side + sx]) anchors++;
          } else if (++gap > maxGap) break;
        }
        if (last + 1 >= minRun && support >= (last + 1) * minSupport && (!seed || anchors >= 2)) {
          for (let k = 0; k <= last; k++) {
            const sx = Math.round(x + dx * k), sy = Math.round(y + dy * k);
            if (sx >= 0 && sy >= 0 && sx < side && sy < side) out[sy * side + sx] = 1;
          }
        }
      }
    }
  }
  return out;
}

// Link two collinear road fragments across a short gap, but only when both
// arms are real segments and the gap itself still has some candidate support.
// This is the step that lets a dashed, faint cross street reconnect to the
// bright grid without lowering the global threshold and without bridging
// arbitrary noise.
function bridgeGaps(bin, side, cand, maxGap = 10, minArm = 8, support = 0.5) {
  const out = bin.slice();
  const angles = Array.from({length: 12}, (_, i) => i * 15);
  for (const deg of angles) {
    const th = deg * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = y * side + x;
        if (!bin[i]) continue;
        // only start at the beginning of a segment
        const px = Math.round(x - dx), py = Math.round(y - dy);
        if (px >= 0 && py >= 0 && px < side && py < side && bin[py * side + px]) continue;
        let arm = 0;
        while (arm < minArm * 2) {
          const ax = Math.round(x + dx * arm), ay = Math.round(y + dy * arm);
          if (ax < 0 || ay < 0 || ax >= side || ay >= side || !bin[ay * side + ax]) break;
          arm++;
        }
        if (arm < minArm) continue;
        let gap = 0, hit = -1, sup = 0;
        for (let g = 1; g <= maxGap; g++) {
          const gx = Math.round(x + dx * (arm + g)), gy = Math.round(y + dy * (arm + g));
          if (gx < 0 || gy < 0 || gx >= side || gy >= side) break;
          if (bin[gy * side + gx]) { hit = g; break; }
          if (cand[gy * side + gx] > 8) sup++;
        }
        if (hit > 0 && sup >= hit * support) {
          for (let g = 1; g < hit; g++) {
            const gx = Math.round(x + dx * (arm + g)), gy = Math.round(y + dy * (arm + g));
            if (gx >= 0 && gy >= 0 && gx < side && gy < side) out[gy * side + gx] = 1;
          }
        }
      }
    }
  }
  return out;
}

// Distance to the nearest background pixel: road centre lines are thin
// (small distance), building-light blobs are wide (large distance).
function distanceTransform(bin, side) {
  const INF = 1e6, dist = new Float32Array(side * side);
  for (let i = 0; i < dist.length; i++) dist[i] = bin[i] ? INF : 0;
  const d1 = 1, d2 = Math.SQRT2;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const i = y * side + x;
    let v = dist[i];
    if (x > 0) v = Math.min(v, dist[i - 1] + d1);
    if (y > 0) v = Math.min(v, dist[i - side] + d1);
    if (x > 0 && y > 0) v = Math.min(v, dist[i - side - 1] + d2);
    if (x + 1 < side && y > 0) v = Math.min(v, dist[i - side + 1] + d2);
    dist[i] = v;
  }
  for (let y = side - 1; y >= 0; y--) for (let x = side - 1; x >= 0; x--) {
    const i = y * side + x;
    let v = dist[i];
    if (x + 1 < side) v = Math.min(v, dist[i + 1] + d1);
    if (y + 1 < side) v = Math.min(v, dist[i + side] + d1);
    if (x + 1 < side && y + 1 < side) v = Math.min(v, dist[i + side + 1] + d2);
    if (x > 0 && y + 1 < side) v = Math.min(v, dist[i + side - 1] + d2);
    dist[i] = v;
  }
  return dist;
}

// Fill tiny enclosed holes.  A small ring of building lights becomes a filled
// dot after thinning, which pruneSpurs then removes; large city blocks (big
// holes) are untouched.
function fillSmallHoles(bin, side, maxArea = 200, gray = null, brightThresh = 110, brightArea = 2500) {
  const seen = new Uint8Array(side * side), stack = new Int32Array(side * side);
  for (let start = 0; start < bin.length; start++) {
    if (bin[start] || seen[start]) continue;
    let sp = 0, area = 0, touches = false, lumSum = 0;
    stack[sp++] = start; seen[start] = 1;
    const cells = [];
    while (sp) {
      const i = stack[--sp]; cells.push(i); area++; if (gray) lumSum += gray[i];
      const x = i % side, y = (i / side) | 0;
      if (x === 0 || y === 0 || x === side - 1 || y === side - 1) touches = true;
      if (x > 0 && !bin[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x + 1 < side && !bin[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !bin[i - side] && !seen[i - side]) { seen[i - side] = 1; stack[sp++] = i - side; }
      if (y + 1 < side && !bin[i + side] && !seen[i + side]) { seen[i + side] = 1; stack[sp++] = i + side; }
    }
    const bright = gray && area <= brightArea && lumSum / area > brightThresh;
    if (!touches && (area <= maxArea || bright)) for (const i of cells) bin[i] = 1;
  }
  return bin;
}

// Remove very short edges between two junctions.  Building-light clusters
// show up as tiny closed cells made of 3-10 px edges; real streets are much
// longer.  Opening one side of each tiny cell breaks the false loop without
// touching the long road edges.
function pruneShortEdges(skel, w, h, minLen = 12) {
  const deg = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!skel[i]) continue;
    let d = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && skel[i + dy * w + dx]) d++;
    deg[i] = d;
  }
  const seen = new Uint8Array(w * h);
  const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const s = y * w + x;
    if (!skel[s] || deg[s] === 2 || seen[s]) continue;
    for (const [dx, dy] of dirs) {
      let px = x, py = y, cx = x + dx, cy = y + dy;
      if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) continue;
      if (!skel[cy * w + cx] || seen[cy * w + cx]) continue;
      const path = [];
      let guard = 0;
      while (guard++ < 2000) {
        const k = cy * w + cx;
        path.push(k); seen[k] = 1;
        if (deg[k] !== 2) break;
        let nxt = -1;
        for (const [ex, ey] of dirs) {
          const xx = cx + ex, yy = cy + ey;
          if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
          const j = yy * w + xx;
          if (j === px + py * w || !skel[j]) continue;
          nxt = j; px = cx; py = cy; cx = xx; cy = yy; break;
        }
        if (nxt < 0) break;
      }
      if (path.length < minLen) for (const k of path) skel[k] = 0;
    }
  }
}

// Keep the connected road network; floating strokes in sky, clouds or
// watermark are separate components and are not roads.
function keepLargestComponent(skel, side) {
  const seen = new Uint8Array(side * side), stack = new Int32Array(side * side);
  let best = null, bestSize = 0;
  for (let start = 0; start < skel.length; start++) {
    if (!skel[start] || seen[start]) continue;
    let sp = 0, size = 0, touchesBorder = false;
    stack[sp++] = start; seen[start] = 1;
    const cells = [];
    while (sp) {
      const i = stack[--sp]; cells.push(i); size++;
      const x = i % side, y = (i / side) | 0;
      if (x <= 1 || y <= 1 || x >= side - 2 || y >= side - 2) touchesBorder = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= side || yy >= side) continue;
        const j = yy * side + xx;
        if (skel[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
      }
    }
    if (size > bestSize) { bestSize = size; best = cells; }
  }
  if (best) {
    skel.fill(0);
    for (const i of best) skel[i] = 1;
  }
  return skel;
}

// Post-filter only.  It never creates a road: it removes small floating
// components and short endpoint hairs from an already extracted mask.  Kept
// separate from extractMask so threshold/recall decisions are not mixed with
// interference cleanup.
export function cleanMask(mask, N = 256, minComponent = 20, extra = null) {
  const out = mask.slice();
  if (extra) for (let i = 0; i < out.length; i++) if (extra[i]) out[i] = 1;
  const seen = new Uint8Array(N * N), stack = new Int32Array(N * N);
  for (let start = 0; start < out.length; start++) {
    if (!out[start] || seen[start]) continue;
    let sp = 0, cells = [];
    stack[sp++] = start; seen[start] = 1;
    while (sp) {
      const i = stack[--sp]; cells.push(i);
      const x = i % N, y = (i / N) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const j = yy * N + xx;
        if (out[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
      }
    }
    if (cells.length < minComponent) for (const i of cells) out[i] = 0;
  }
  pruneSpurs(out, N, N, 1);
  return out;
}

// Recover faint, dashed horizontal/vertical streets from a very low top-hat
// candidate.  Only axis-aligned runs are used here: diagonal runs were what
// produced synthetic roads in empty sky.  A run must be long, mostly
// supported, and touch at least two high-confidence anchors.
function recoverRuns(src, side, threshold, minRun, seed) {
  const out = new Uint8Array(side * side);
  const maxGap = 3, minSupport = 0.75;
  const angles = [0, 15, 75, 90, 105, 165];
  for (const deg of angles) {
    const th = deg * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        if (src[y * side + x] <= threshold) continue;
        let last = -1, support = 0, gap = 0, anchors = 0;
        for (let k = 0; k < minRun * 2; k++) {
          const sx = Math.round(x + dx * k), sy = Math.round(y + dy * k);
          if (sx < 0 || sy < 0 || sx >= side || sy >= side) break;
          if (src[sy * side + sx] > threshold) {
            last = k; support++; gap = 0;
            if (seed && seed[sy * side + sx]) anchors++;
          } else if (++gap > maxGap) break;
        }
        if (last + 1 >= minRun && support >= (last + 1) * minSupport && anchors >= 2) {
          for (let k = 0; k <= last; k++) {
            const sx = Math.round(x + dx * k), sy = Math.round(y + dy * k);
            if (sx >= 0 && sy >= 0 && sx < side && sy < side) out[sy * side + sx] = 1;
          }
        }
      }
    }
  }
  return out;
}

export function extractMask(img, opts = {}) {
  const maxSide = opts.maxSide || 640;
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const cw = Math.max(32, Math.round(img.width * scale));
  const ch = Math.max(32, Math.round(img.height * scale));
  // Pad the full frame to a square. Cropping would throw away the edges of
  // wide cockpit/window shots, and stretching would bend the road geometry.
  const side = Math.max(cw, ch);
  const ox = (side - cw) >> 1, oy = (side - ch) >> 1;
  const c = makeCanvas(side, side);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(img, ox, oy, cw, ch);
  const data = ctx.getImageData(0, 0, side, side).data;
  const gray = new Float32Array(side * side);
  const warm = new Float32Array(side * side);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    // Street lighting is overwhelmingly sodium-orange. White facades, LED
    // signs and window reflections are neutral/blue and should not become
    // "roads" just because they are bright.
    warm[j] = Math.max(0, data[i] - data[i + 2]);
  }

  // A night street is a thin warm ridge of lamp light, not a blob.  The
  // matched top-hat below keeps faint roads (they still stand above their
  // local ground) while the warm weight rejects clouds and white facades.
  const r = Math.max(2, Math.round(side / 120));
  const opened = openGray(gray, side, side, r);
  const closed = morphology(morphology(gray, side, side, r, true), side, side, r, false);
  const sig = new Float32Array(side * side);
  const whiteTop = new Float32Array(side * side);
  for (let i = 0; i < sig.length; i++) {
    const t = Math.max(0, gray[i] - opened[i]);
    whiteTop[i] = t;
    const b = Math.max(0, closed[i] - gray[i]);
    const w = Math.min(1, Math.max(0, (warm[i] - 1) / 20));
    // Three road evidences: warm lamp light, the low-contrast bright surface
    // of a road, and the dark trough of an unlit road between lit blocks.
    const warmSig = t * (0.15 + 0.85 * w);
    const graySig = t * 0.85;
    const darkSig = 0;
    sig[i] = Math.max(warmSig, graySig, darkSig);
  }
  // Local adaptive threshold.  A global percentile is exactly what made
  // bright blocks fuse and dim streets vanish: the same threshold cannot fit
  // both.  Compare each pixel with its own neighbourhood instead.
  const win = Math.max(15, Math.round(side / 24));
  const { mean, sd } = localMeanStd(sig, side, side, win >> 1);
  const strong = new Uint8Array(side * side), weak = new Uint8Array(side * side);
  let thrSum = 0;
  for (let i = 0; i < sig.length; i++) {
    const thr = Math.max(1.2, mean[i] + 1.25 * sd[i]);
    thrSum += thr;
    strong[i] = sig[i] >= thr ? 1 : 0;
    weak[i] = sig[i] >= thr * 0.62 ? 1 : 0;
  }
  const meanThr = thrSum / sig.length;
  let bin = hysteresis(strong, weak, side, side);
  const seed = morphology(strong, side, side, 2, true);
  const runs = recoverRuns(whiteTop, side, 8, 31, seed);
  for (let i = 0; i < bin.length; i++) if (runs[i]) bin[i] = 1;
  // Close one-pixel lamp gaps; the mask stays thick on purpose (thinning it
  // here would cut the horizontal roads that the old ridge detector lost).
  bin = morphology(bin, side, side, 1, false);
  bin = morphology(bin, side, side, 1, true);
  pruneComponents(bin, side, side, Math.max(48, Math.round(side * side / 10000)));
  const skel = thin(bin, side, side);
  pruneSpurs(skel, side, side, 10);
  const graph = traceGraph(skel, side, side);
  // Downsample by coverage, not max-pooling: max-pooling turns a 1 px
  // skeleton into 3 px bands at 256, which inflates the road-pixel count and
  // makes the chamfer score prefer oversized (zoomed-in) transforms.
  const N = opts.size || 256;
  const out = new Float32Array(N * N);
  const block = side / N;
  for (let y = 0; y < N; y++) {
    const y0 = Math.floor(y * block), y1 = Math.min(side, Math.ceil((y + 1) * block));
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor(x * block), x1 = Math.min(side, Math.ceil((x + 1) * block));
      let v = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { v += skel[yy * side + xx]; n++; }
      out[y * N + x] = n && v / n > 0.16 ? 1 : 0;
    }
  }
  return {
    mask: out, size: N, sourceSide: side, threshold: meanThr,
    roadPixels: out.reduce((a, b) => a + b, 0),
    skel, graph, preview: c, cw, ch, ox, oy,
  };
}

export function descriptor(mask, N = 256) {
  // blur/downsample to 128 for stable gradients
  const S = 128, small = new Float32Array(S * S);
  const b = N / S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0, n = 0;
    for (let yy = Math.floor(y * b); yy < Math.min(N, (y + 1) * b); yy++)
      for (let xx = Math.floor(x * b); xx < Math.min(N, (x + 1) * b); xx++) { v += mask[yy * N + xx]; n++; }
    small[y * S + x] = n ? v / n : 0;
  }
  const gx = new Float32Array(S * S), gy = new Float32Array(S * S);
  for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
    const i = y * S + x;
    gx[i] = (small[i - S + 1] + 2 * small[i + 1] + small[i + S + 1]) -
            (small[i - S - 1] + 2 * small[i - 1] + small[i + S - 1]);
    gy[i] = (small[i + S - 1] + 2 * small[i + S] + small[i + S + 1]) -
            (small[i - S - 1] + 2 * small[i - S] + small[i - S + 1]);
  }
  const orient = new Float32Array(36), radial = new Float32Array(12);
  let cx = 0, cy = 0, cnt = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (small[y * S + x] > 0.05) { cx += x; cy += y; cnt++; }
  cx = cnt ? cx / cnt : S / 2; cy = cnt ? cy / cnt : S / 2;
  let tot = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    const m = Math.hypot(gx[i], gy[i]);
    if (m < 1e-4) continue;
    let a = (Math.atan2(gy[i], gx[i]) * 180 / Math.PI + 180) % 180;
    orient[Math.min(35, Math.floor(a / 5))] += m;
    const r = Math.hypot(x - cx, y - cy) / (0.5 * S);
    radial[Math.min(11, Math.floor(r * 12))] += m;
    tot += m;
  }
  let dens = 0;
  for (let i = 0; i < mask.length; i++) dens += mask[i];
  dens /= mask.length;
  const out = new Array(50).fill(0);
  for (let i = 0; i < 36; i++) out[i] = tot ? Math.round(orient[i] / tot * 255) : 0;
  for (let i = 0; i < 12; i++) out[36 + i] = tot ? Math.round(radial[i] / tot * 255) : 0;
  out[48] = Math.round(dens * 255);
  out[49] = Math.round(Math.log2(Math.max(1, dens * mask.length)) * 16);
  return out;
}

// Auto content framing / weak perspective correction.
// A window shot usually has sky/cloud above the ground and a city that is
// vertically foreshortened.  Crop to the lit ground bbox, then stretch that
// crop to a square; this is the affine part of a plane-induced homography and
// is enough to make a several-km oblique city comparable to a nadir tile.
export function autoFrame(img, base, opts = {}) {
  const M = 256, m = base.mask, side = base.sourceSide;
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  const frac = n / (M * M);
  if (n < 40) {
    return { ext: base, canvas: base.preview, info: null };
  }
  // Clouds and window reflections are sparse streaks; the city is a dense
  // cluster. Work on a coarse occupancy grid and keep the largest blob, so
  // the crop does not get stretched to include the whole sky.
  const G = 16, cell = M / G, cnt = new Uint16Array(G * G);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) if (m[y * M + x]) cnt[((y / cell) | 0) * G + ((x / cell) | 0)]++;
  let maxC = 0;
  for (let i = 0; i < cnt.length; i++) maxC = Math.max(maxC, cnt[i]);
  const on = new Uint8Array(G * G);
  for (let i = 0; i < cnt.length; i++) on[i] = cnt[i] >= Math.max(2, maxC * 0.08) ? 1 : 0;
  const seen = new Uint8Array(G * G), q = new Int32Array(G * G);
  let bestCells = [], bestN = 0;
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    let h = 0, t = 0, bn = 0; const cells = [];
    q[t++] = s; seen[s] = 1;
    while (h < t) {
      const v = q[h++]; cells.push(v); bn++;
      const gx = v % G, gy = (v / G) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const xx = gx + dx, yy = gy + dy;
        if (xx < 0 || yy < 0 || xx >= G || yy >= G) continue;
        const j = yy * G + xx;
        if (on[j] && !seen[j]) { seen[j] = 1; q[t++] = j; }
      }
    }
    if (bn > bestN) { bestN = bn; bestCells = cells; }
  }
  if (!bestCells.length) return { ext: base, canvas: base.preview, info: null };
  let x0 = M, y0 = M, x1 = 0, y1 = 0;
  for (const v of bestCells) {
    const gx = v % G, gy = (v / G) | 0;
    x0 = Math.min(x0, gx * cell); x1 = Math.max(x1, (gx + 1) * cell);
    y0 = Math.min(y0, gy * cell); y1 = Math.max(y1, (gy + 1) * cell);
  }
  if (x1 - x0 < 20 || y1 - y0 < 20) return { ext: base, canvas: base.preview, info: null };
  // Mask bbox -> preview canvas coordinates.
  // Generous margin: the lit bbox is the city core, but the road lattice
  // continues into the dark suburbs. Cropping to the bbox cuts those roads.
  const padPx = Math.max(120, Math.round(Math.max(x1 - x0, y1 - y0) / M * side * 0.9));
  const sx = Math.max(base.ox, base.ox + x0 / M * side - padPx);
  const sy = Math.max(base.oy, base.oy + y0 / M * side - padPx);
  const sw = Math.min(base.ox + side, base.ox + x1 / M * side + padPx) - sx;
  const sh = Math.min(base.oy + side, base.oy + y1 / M * side + padPx) - sy;
  if (sw < 40 || sh < 40) return { ext: base, canvas: base.preview, info: null };
  // Restore only the vertical foreshortening; a city bbox is not a square.
  // Over-stretching to bbox aspect would turn a 6x4 km town into a 6x6 km one.
  const stretch = Math.max(1, Math.min(1.6, sw / Math.max(1, sh)));
  const dw = sw, dh = sh * stretch;
  const S = Math.max(160, Math.round(Math.max(dw, dh) * 1.15));
  const c = makeCanvas(S, S);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, S, S);
  ctx.imageSmoothingQuality = "high";
  const dx = (S - dw) / 2, dy = (S - dh) / 2;
  ctx.drawImage(base.preview, sx, sy, sw, sh, dx, dy, dw, dh);
  const ext = extractMask(c, { maxSide: Math.min(720, S), size: 256 });
  return { ext, canvas: c, info: { sx, sy, sw, sh, S, aspect: sw / sh } };
}

export function rotateMask(mask, N, angleDeg) {
  const out = new Float32Array(N * N);
  const a = angleDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const c = N / 2;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - c, dy = y - c;
    const qx = ca * dx + sa * dy + c, qy = -sa * dx + ca * dy + c;
    const ix = Math.round(qx), iy = Math.round(qy);
    if (ix >= 0 && ix < N && iy >= 0 && iy < N) out[y * N + x] = mask[iy * N + ix];
  }
  return out;
}
