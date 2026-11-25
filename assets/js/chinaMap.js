// Interactive prefecture constellation — pure Canvas 2D.
const LON0 = 73, LON1 = 136, LAT0 = 17, LAT1 = 54;

export async function initChinaMap(canvas, tip) {
  let pts = [];
  try {
    const r = await fetch("data/prefectures.json", { cache: "no-store" });
    pts = await r.json();
  } catch { return; }
  const ctx = canvas.getContext("2d");
  const links = buildLinks(pts);
  let W = 0, H = 0, dpr = 1, hover = -1, t0 = performance.now();
  const projected = [];

  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    W = Math.max(260, box.width); H = Math.max(260, box.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 30;
    const sx = (W - pad * 2) / (LON1 - LON0);
    const sy = (H - pad * 2) / (LAT1 - LAT0);
    const s = Math.min(sx, sy * 1.06);
    const ox = (W - (LON1 - LON0) * s) / 2;
    const oy = (H - (LAT1 - LAT0) * s) / 2;
    projected.length = 0;
    for (const p of pts) projected.push({
      x: ox + (p.lon - LON0) * s,
      y: oy + (LAT1 - p.lat) * s,
    });
  }

  function draw(now) {
    const time = (now - t0) / 1000;
    ctx.clearRect(0, 0, W, H);
    // soft field
    const g = ctx.createRadialGradient(W * .52, H * .48, 10, W * .52, H * .48, Math.max(W, H) * .62);
    g.addColorStop(0, "rgba(20,184,166,.10)");
    g.addColorStop(.55, "rgba(20,184,166,.03)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = 1;
    for (const [a, b] of links) {
      const p = projected[a], q = projected[b];
      ctx.strokeStyle = "rgba(94,234,212,.10)";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    // pulsing packets along a subset of links
    for (let k = 0; k < links.length; k += 3) {
      const [a, b] = links[k], p = projected[a], q = projected[b];
      const u = (time * .18 + k * .137) % 1;
      const x = p.x + (q.x - p.x) * u, y = p.y + (q.y - p.y) * u;
      ctx.fillStyle = "rgba(245,184,75,.55)";
      ctx.beginPath(); ctx.arc(x, y, 1.2, 0, 7); ctx.fill();
    }
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i], on = i === hover;
      const pulse = .55 + .45 * Math.sin(time * 1.6 + i * .7);
      ctx.fillStyle = on ? "#f5b84b" : `rgba(94,234,212,${.34 + .28 * pulse})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, on ? 3.4 : 1.5 + .6 * pulse, 0, 7); ctx.fill();
      if (on) {
        ctx.strokeStyle = "rgba(245,184,75,.8)"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.stroke();
      }
    }
    requestAnimationFrame(draw);
  }

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bd = 14;
    for (let i = 0; i < projected.length; i++) {
      const d = Math.hypot(projected[i].x - x, projected[i].y - y);
      if (d < bd) { bd = d; best = i; }
    }
    hover = best;
    if (best >= 0) {
      const p = pts[best];
      tip.hidden = false;
      tip.textContent = `${p.name} · ${p.province}`;
      tip.style.left = Math.min(W - 150, projected[best].x + 10) + "px";
      tip.style.top = Math.max(4, projected[best].y - 26) + "px";
    } else tip.hidden = true;
  });
  canvas.addEventListener("mouseleave", () => { hover = -1; tip.hidden = true; });

  resize();
  new ResizeObserver(resize).observe(canvas.parentElement);
  requestAnimationFrame(draw);
}

function buildLinks(pts) {
  const byProv = new Map(), out = [];
  for (let i = 0; i < pts.length; i++) {
    const k = pts[i].province;
    if (!byProv.has(k)) byProv.set(k, []);
    byProv.get(k).push(i);
  }
  for (const arr of byProv.values()) {
    for (let j = 1; j < arr.length; j++) out.push([arr[0], arr[j]]);
  }
  // nearest-neighbour bridges between provincial clusters
  for (let i = 0; i < pts.length; i++) {
    let bi = -1, bd = 1e9;
    for (let j = 0; j < pts.length; j++) {
      if (pts[i].province === pts[j].province) continue;
      const d = (pts[i].lon - pts[j].lon) ** 2 + (pts[i].lat - pts[j].lat) ** 2;
      if (d < bd) { bd = d; bi = j; }
    }
    if (bi >= 0 && bi > i && out.length < 900) out.push([i, bi]);
  }
  return out;
}
