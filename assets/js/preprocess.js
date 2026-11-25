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
  const gray = new Uint8Array(side * side);
  const warm = new Uint8Array(side * side);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    // Street lighting is overwhelmingly sodium-orange. White facades, LED
    // signs and window reflections are neutral/blue and should not become
    // "roads" just because they are bright.
    warm[j] = Math.max(0, data[i] - data[i + 2]);
  }
  const r = Math.max(2, Math.round(side / 90));
  const opened = morphology(gray, side, side, r, true);
  const opened2 = morphology(opened, side, side, r, false);
  const hat = new Uint8Array(side * side);
  let sum = 0, sum2 = 0;
  for (let i = 0; i < hat.length; i++) {
    const v = Math.max(0, gray[i] - opened2[i]);
    const w = 0.28 + 0.72 * Math.min(1, warm[i] / 26);
    const vv = v * w;
    hat[i] = vv; sum += vv; sum2 += vv * vv;
  }
  const mean = sum / hat.length;
  const std = Math.sqrt(Math.max(0, sum2 / hat.length - mean * mean));
  // robust high percentile
  const sample = [];
  for (let i = 0; i < hat.length; i += 7) sample.push(hat[i]);
  sample.sort((a, b) => a - b);
  const p90 = sample[Math.floor(sample.length * 0.90)] || 0;
  // Night shots range from a bright CBD to a dim 10 km-away skyline. Keep the
  // floor low enough that a faint lattice still produces a usable skeleton.
  const thr = Math.min(85, Math.max(3, mean + 0.55 * std, p90 * 0.70));
  const bin = new Uint8Array(side * side);
  for (let i = 0; i < bin.length; i++) bin[i] = hat[i] >= thr ? 1 : 0;
  const skel = thin(bin, side, side);
  pruneComponents(skel, side, side, Math.max(18, Math.round(side * side / 24000)));
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
    mask: out, size: N, sourceSide: side, threshold: thr,
    roadPixels: out.reduce((a, b) => a + b, 0),
    skel, preview: c, cw, ch, ox, oy,
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
