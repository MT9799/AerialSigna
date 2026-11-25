// AerialSigna — static, no-build demo controller.
import { loadImage, extractMask, cleanMask, descriptor, makeCanvas, autoFrame, rotateMask } from "./preprocess.js";
import { Matcher } from "./matcher.js";
import { initChinaMap } from "./chinaMap.js";
import { autoRectify } from "./perspective.js";

const $ = (s) => document.querySelector(s);
const state = {
  index: [], matcher: null, samples: [],
  img: null, src: "", meta: null, ext: null, mask: null, desc: null,
  results: [], selected: -1, view: "overlay", rectify: true,
  quad: [{ x: .07, y: .07 }, { x: .93, y: .07 }, { x: .93, y: .93 }, { x: .07, y: .93 }],
  drag: null, busy: false, tileCache: new Map(), token: 0, rectifiedCanvas: null,
  // Keep the untouched extraction around so switching 自动透视 off restores
  // exactly what was loaded, not a half-rectified derivative.
  baseExt: null, baseMask: null, baseDesc: null, baseDescs: null,
  rectDirty: true, rectifying: false,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setStatus(text, cls = "") {
  const el = $("#runStatus");
  el.textContent = text;
  el.className = "run-status " + cls;
}

function setIndexStatus(text, cls = "") {
  const el = $("#indexStatus");
  el.className = "status-pill " + cls;
  el.querySelector("span:last-child").textContent = text;
}

async function init() {
  await loadIndex();
  await loadSamples();
  buildProvinceOptions();
  bindUI();
  const q0 = new URLSearchParams(location.search);
  if (q0.get("province")) $("#province").value = q0.get("province");
  if (q0.get("county")) $("#countyQuery").value = q0.get("county");
  window.AERIAL_SIGNA = { state };
  initChinaMap($("#chinaMap"), $("#mapTip"));
  if (new URLSearchParams(location.search).has("dumpmask")) {
    setTimeout(() => {
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const g = c.getContext("2d"); const im = g.createImageData(256, 256);
      for (let i = 0; i < state.mask.length; i++) { const v = state.mask[i] ? 255 : 0; im.data[i*4] = v; im.data[i*4+1] = v; im.data[i*4+2] = v; im.data[i*4+3] = 255; }
      g.putImageData(im, 0, 0);
      const pre = document.createElement("pre"); pre.id = "maskdump"; pre.textContent = c.toDataURL("image/png");
      document.body.appendChild(pre);
    }, 1500);
  }
  // No image is loaded or matched on first paint: the national index is
  // large and an automatic run makes the page feel frozen. The user picks a
  // sample or uploads a photo explicitly.
  const qp = new URLSearchParams(location.search);
  const wanted = qp.get("sample");
  if (wanted) {
    const s = state.samples.find((x) => x.id === wanted);
    if (s) {
      await selectSample(s);
      if (qp.has("autorect")) setTimeout(() => $("#autoRect")?.click(), 300);
    if (qp.get("view") === "mask") {
        state.view = "mask";
        document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === "mask"));
        draw();
      } else if (!qp.has("norun")) {
        setTimeout(() => { if (state.img && !state.results.length) runMatch(); }, 300);
      }
    }
  }
}

async function loadIndex() {
  try {
    const r = await fetch("data/fp/index.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    state.index = (data.counties || []).filter((e) => e && e.id && e.desc);
    state.matcher = new Matcher(state.index);
    $("#countyCount").textContent = state.index.length.toLocaleString("en-US");
    const full = state.index.length >= 2800;
    setIndexStatus(full ? `全国 ${state.index.length} 县` : `试点 ${state.index.length} 县`, "ok");
    if (!state.index.length) setStatus("索引为空，请先运行 pipeline/build_national.py", "busy");
  } catch (e) {
    console.error(e);
    setIndexStatus("索引未载入", "bad");
    setStatus("找不到 data/fp/index.json；请先生成路网指纹。", "busy");
  }
}

async function loadSamples() {
  try {
    const r = await fetch("samples/manifest.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    state.samples = await r.json();
  } catch (e) {
    state.samples = [];
  }
  const wrap = $("#sampleChips");
  wrap.innerHTML = "";
  for (const s of state.samples) {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = s.name;
    b.title = s.note || s.city || "";
    b.addEventListener("click", () => selectSample(s));
    b.dataset.id = s.id;
    wrap.appendChild(b);
  }
}

function buildProvinceOptions() {
  const sel = $("#province");
  const provinces = [...new Set(state.index.map((e) => e.province))].sort((a, b) => a.localeCompare(b, "zh"));
  sel.innerHTML = '<option value="">全国（当前试点）</option>' +
    provinces.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
}

async function selectSample(s) {
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c.dataset.id === s.id));
  // Curated samples carry the province in their metadata; use it as an EXIF-
  // style hint so the demo does not spend 40 s scanning all 2,896 counties.
  // An uploaded photo has no such hint and still searches nationally.
  if (s.province) $("#province").value = s.province;
  setStatus("载入样例：" + s.name);
  try {
    const img = await loadImage(s.file);
    await setImage(img, s, s.file);
  } catch (e) {
    setStatus("样例加载失败：" + e.message, "busy");
  }
}

async function setImage(img, meta, src) {
  state.token++;
  state.img = img;
  state.meta = meta || {};
  state.src = src || "";
  state.rectifiedCanvas = null;
  state.rectDirty = true;
  state.results = [];
  state.selected = -1;
  // Start from the full frame.  A bad automatic quad is worse than no quad:
  // it silently rotates or shears the ground and every later match inherits
  // the error.  The four corners are seeded to the frame edges; the user (or
  // the explicit 自动拟合 button) can tighten them.
  state.quad = Array.isArray(meta?.quad) && meta.quad.length === 4
    ? meta.quad.map(([x, y]) => ({ x, y }))
    : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const t0 = performance.now();
  const base = extractMask(img, { maxSide: 1080, size: 256 });
  state.baseExt = base;
  state.baseMask = base.mask;
  state.baseDesc = descriptor(base.mask);
  state.baseDescs = [];
  for (let a = 0; a < 360; a += 15) state.baseDescs.push(descriptor(rotateMask(base.mask, 256, a)));
  // Fit the city once, at load time, and remember that quad.  The button
  // restores this fit instead of re-running a fresh fit on every click:
  // repeated fits used to jump to a different (often random) rectangle.
  if (!Array.isArray(meta?.quad)) estimateQuad();
  state.initialQuad = state.quad.map((p) => ({ x: p.x, y: p.y }));
  state.ext = base;
  state.mask = base.mask;
  state.desc = state.baseDesc;
  state.descs = state.baseDescs;
  if (state.rectify) applyRectify();
  const shown = state.ext || base;
  const th = shown.threshold.toFixed(1);
  setStatus(`已提取 ${shown.roadPixels.toLocaleString("en-US")} 个道路像素 · 阈值 ${th} · ${(performance.now() - t0).toFixed(0)} ms`, "ok");
  $("#runBtn").disabled = !state.matcher;
  $("#fitBtn").disabled = false;
  $("#downloadOverlay").disabled = true;
  $("#emptyState").hidden = true;
  // Start on 原图 so the four draggable corners are visible; 叠加/提取路网
  // then show the rectified frame once 开始识别 (or 自动拟合) applies it.
  const qview = new URLSearchParams(location.search).get("view");
  state.view = qview === "mask" || qview === "overlay" ? qview : "source";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  renderResults();
  $("#stageMeta").textContent = "已载入，等待匹配";
  draw();
}

// Bake the current four corners into the frame used by 叠加 / 提取路网.
// Nothing here changes the quad or re-runs the auto fit: that was the source
// of the "开始识别时又自动拉正一次" bug.
function applyRectify() {
  if (!state.img || !state.baseExt) return false;
  if (!state.rectify) {
    state.ext = state.baseExt;
    state.mask = state.baseMask;
    state.desc = state.baseDesc;
    state.descs = state.baseDescs;
    state.rectifiedCanvas = null;
    state.rectDirty = false;
    return false;
  }
  if (!state.rectDirty && state.rectifiedCanvas) return true;
  if (state.rectifying) return !!state.rectifiedCanvas;
  state.rectifying = true;
  try {
    const rc = rectifyCanvas();
    const rex = extractMask(rc, { maxSide: 720, size: 256 });
    state.rectifiedCanvas = rc;
    state.ext = rex;
    state.mask = rex.mask;
    state.desc = descriptor(rex.mask);
    state.descs = [];
    for (let a = 0; a < 360; a += 15) state.descs.push(descriptor(rotateMask(rex.mask, 256, a)));
    state.rectDirty = false;
    return true;
  } finally {
    state.rectifying = false;
  }
}


async function runMatch() {
  if (!state.img || !state.matcher || state.busy) return;
  state.busy = true;
  $("#runBtn").disabled = true;
  setStatus("正在提取 / 比对…", "busy");
  try {
    setStatus("正在提取 / 比对…", "busy");
    // Re-bake only when the corners changed.  This never touches state.quad:
    // 开始识别 used to run its own auto-fit here, which rotated the ground a
    // second time after the user had already approved the preview.
    applyRectify();
    const ext = state.ext;
    state.mask = ext.mask;
    state.desc = descriptor(state.mask);
    state.descs = [];
    for (let a = 0; a < 360; a += 15) state.descs.push(descriptor(rotateMask(state.mask, 256, a)));
    if (state.ext) state.ext.effective = ext;
    const fovSel = $("#fov").value;
    const filter = {
      province: $("#province").value,
      query: $("#countyQuery").value.trim(),
      // On "auto", use the sample/EXIF hint when present; the matcher then
      // searches a narrow scale band around it instead of 0.25–2.0.
      fovKm: fovSel === "auto" ? (Number(state.meta?.fov) || 0) : Number(fovSel),
      descs: state.descs,
    };
    const t0 = performance.now();
    const results = await state.matcher.match(state.mask, state.desc, filter, (p) => {
      if (p.stage === "coarse") {
        setStatus(`粗筛 ${p.done}/${p.total} · 64 px`, "busy");
      } else if (p.stage === "fine") {
        const pct = Math.min(100, Math.round(100 * p.done / Math.max(1, p.total)));
        setStatus(`精排 ${pct}% · 256 px`, "busy");
      }
    });
    state.results = results;
    state.selected = results.length ? 0 : -1;
    const ms = Math.round(performance.now() - t0);
    if (results.length) {
      setStatus(`完成：${results.length} 个候选 · ${ms} ms · 首选 ${results[0].entry.name} ${results[0].sim.toFixed(1)}%`, "ok");
    } else {
      setStatus(`没有候选（${ms} ms）。请检查索引与范围。`, "busy");
    }
    renderResults();
    updateDiagnostics();
    $("#downloadOverlay").disabled = !results.length;
    draw();
  } catch (e) {
    console.error(e);
    setStatus("匹配失败：" + e.message, "busy");
  } finally {
    state.busy = false;
    $("#runBtn").disabled = !state.img;
  }
}

function renderResults() {
  const list = $("#resultList");
  if (!state.results.length) {
    list.innerHTML = '<div class="result-placeholder"><span>—</span><p>识别后，这里会按相似度列出最可能的县区，并标出估计视场与旋转角。</p></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  state.results.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "result-card" + (i === state.selected ? " selected" : "");
    d.innerHTML = `
      <div class="rank">${String(i + 1).padStart(2, "0")}<small>RANK</small></div>
      <div>
        <div class="rc-name">${esc(r.entry.name)}<span>${esc(r.entry.province)} · ${esc(r.entry.city || "")}</span></div>
        <div class="rc-sub">视场 ${r.fovKm.toFixed(1)} km · 旋转 ${r.angle.toFixed(0)}° · 命中 ${(r.hit * 100).toFixed(0)}% · 均距 ${r.mean.toFixed(1)} px</div>
        <div class="rc-bar"><i style="width:${Math.max(2, r.sim).toFixed(1)}%"></i></div>
      </div>
      <div class="rc-score"><b>${r.sim.toFixed(1)}<small>%</small></b><span>相似度</span></div>
      ${i === 0 ? '<span class="tag-best">TOP MATCH</span>' : ""}
      ${r.rotUncertain ? '<span style="position:absolute;right:10px;bottom:8px;font:10px/1.4 ui-monospace,monospace;color:#e6b45a">方向不唯一</span>' : ""}
    `;
    d.addEventListener("click", () => {
      state.selected = i;
      state.view = "overlay";
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === "overlay"));
      renderResults();
      draw();
      $("#stageMeta").textContent = `${r.entry.name} · ${r.sim.toFixed(1)}% · ${r.fovKm.toFixed(1)} km`;
    });
    frag.appendChild(d);
  });
  list.innerHTML = "";
  list.appendChild(frag);
}

function updateDiagnostics() {
  const r = state.results[state.selected];
  if (!r) { $("#diagnostics").hidden = true; return; }
  $("#diagnostics").hidden = false;
  const ext = state.ext;
  const stats = brightnessStats(ext.preview);
  const blobs = countBlobs(state.mask, 256, 14);
  $("#dRoads").textContent = state.mask.reduce((a, b) => a + b, 0).toLocaleString("en-US");
  $("#dFov").textContent = `≈ ${r.fovKm.toFixed(1)} km`;
  $("#dAngle").textContent = `${r.angle.toFixed(0)}°`;
  $("#dBright").textContent = `${stats.p95.toFixed(0)} / ${stats.mean.toFixed(0)}`;
  $("#dWater").textContent = `${(stats.dark * 100).toFixed(0)}% 低亮`;
  $("#dBlob").textContent = `${blobs} 处`;
}

function brightnessStats(canvas) {
  const c = canvas.getContext("2d", { willReadFrequently: true });
  const d = c.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0, dark = 0, n = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 16) {
    const g = (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0;
    hist[g]++; sum += g; n++; if (g < 16) dark++;
  }
  let acc = 0, p95 = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * .95) { p95 = v; break; } }
  return { mean: sum / Math.max(1, n), p95, dark: dark / Math.max(1, n) };
}

function countBlobs(mask, N, minPx) {
  const seen = new Uint8Array(N * N);
  const q = new Int32Array(N * N);
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let head = 0, tail = 0, size = 0;
    q[tail++] = i; seen[i] = 1;
    while (head < tail) {
      const v = q[head++]; size++;
      const x = v % N, y = (v / N) | 0;
      if (x > 0 && mask[v - 1] && !seen[v - 1]) { seen[v - 1] = 1; q[tail++] = v - 1; }
      if (x + 1 < N && mask[v + 1] && !seen[v + 1]) { seen[v + 1] = 1; q[tail++] = v + 1; }
      if (y > 0 && mask[v - N] && !seen[v - N]) { seen[v - N] = 1; q[tail++] = v - N; }
      if (y + 1 < N && mask[v + N] && !seen[v + N]) { seen[v + N] = 1; q[tail++] = v + N; }
    }
    if (size >= minPx) count++;
  }
  return count;
}

// ---------- canvas drawing ----------
function canvasSize() {
  const c = $("#view");
  return { w: c.width, h: c.height, c };
}

function imageRect(img, w, h, pad = 18) {
  const s = Math.min((w - pad * 2) / img.width, (h - pad * 2) / img.height);
  const iw = img.width * s, ih = img.height * s;
  return { x: (w - iw) / 2, y: (h - ih) / 2, w: iw, h: ih, s };
}

function draw() {
  const qh = $("#quadHint");
  if (qh) qh.hidden = !(state.view === "source" && state.rectify && state.img);
  if (state.view === "source") drawSource();
  else if (state.view === "mask") drawMask();
  else drawOverlay();
}

function drawSource() {
  const { w, h, c } = canvasSize();
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#05090d"; ctx.fillRect(0, 0, w, h);
  if (!state.img) return;
  // 原图 tab is the editing surface: always the uncorrected frame plus the
  // four corners.  The rectified canvas is used by 叠加/提取路网 only.
  const src = state.img;
  const r = imageRect(src, w, h, 0);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, r.x, r.y, r.w, r.h);
  if (state.rectify) drawQuad(ctx, r);
  ctx.strokeStyle = "rgba(148,173,196,.15)";
  ctx.strokeRect(r.x - .5, r.y - .5, r.w + 1, r.h + 1);
}

function drawQuad(ctx, r) {
  const pts = state.quad.map((p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = "rgba(94,234,212,.07)";
  ctx.fill();
  ctx.strokeStyle = "rgba(94,234,212,.9)";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(6,17,15,.88)";
    ctx.fill();
    ctx.strokeStyle = "#5eead4";
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = "#5eead4";
    ctx.fill();
  }
  // Mid-edge handles: these make the moveable edges discoverable.
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    ctx.beginPath();
    ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(94,234,212,.55)";
    ctx.fill();
  }
  ctx.restore();
}

function drawMask() {
  const { w, h, c } = canvasSize();
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#05090d"; ctx.fillRect(0, 0, w, h);
  if (!state.mask) return;
  // 提取路网 is a diagnostic view: no source photo, only the extracted graph.
  const S = Math.min(w, h) - 36;
  const ox = (w - S) / 2, oy = (h - S) / 2;
  // faint reference grid
  ctx.strokeStyle = "rgba(94,234,212,.06)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath(); ctx.moveTo(ox + S * i / 8, oy); ctx.lineTo(ox + S * i / 8, oy + S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ox, oy + S * i / 8); ctx.lineTo(ox + S, oy + S * i / 8); ctx.stroke();
  }
  const im = ctx.createImageData(256, 256);
  for (let i = 0; i < state.mask.length; i++) {
    if (!state.mask[i]) continue;
    im.data[i * 4] = 101; im.data[i * 4 + 1] = 230; im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = 255;
  }
  const tmp = makeCanvas(256, 256);
  tmp.getContext("2d").putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, ox, oy, S, S);
  ctx.imageSmoothingEnabled = true;
  ctx.strokeStyle = "rgba(94,234,212,.28)";
  ctx.strokeRect(ox - .5, oy - .5, S + 1, S + 1);
}

async function drawOverlay() {
  const { w, h, c } = canvasSize();
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#05090d"; ctx.fillRect(0, 0, w, h);
  if (!state.img) return;

  if (!state.results.length || state.selected < 0) {
    // Preview: source frame + extracted skeleton, so upload has immediate feedback.
    const base = state.rectifiedCanvas || state.ext.preview;
    // Same square footprint as 提取路网, with a small margin on all sides.
    const S = Math.min(w, h) - 36;
    const ox = (w - S) / 2, oy = (h - S) / 2;
    ctx.drawImage(base, ox, oy, S, S);
    const im = ctx.createImageData(256, 256);
    for (let i = 0; i < state.mask.length; i++) {
      if (!state.mask[i]) continue;
      im.data[i * 4] = 101; im.data[i * 4 + 1] = 230; im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = 190;
    }
    const tmp = makeCanvas(256, 256);
    tmp.getContext("2d").putImageData(im, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, ox, oy, S, S);
    ctx.imageSmoothingEnabled = true;
    label(ctx, state.meta?.name || "输入图像", "已提取路网骨架 · 点击「开始识别」");
    return;
  }

  const res = state.results[state.selected];
  const tok = ++state.token;
  let road, dist;
  try {
    road = await getTile(state.matcher.tileUrl(res.entry, "r"));
    dist = await getTile(state.matcher.tileUrl(res.entry, "d"));
  } catch (e) {
    ctx.fillStyle = "#ff7a8a"; ctx.font = "13px sans-serif";
    ctx.fillText("路网瓦片加载失败：" + e.message, 30, 40);
    return;
  }
  if (tok !== state.token) return;

  const S = Math.min(w, h) - 36;
  const ox = (w - S) / 2, oy = (h - S) / 2;
  ctx.fillStyle = "#071119";
  ctx.fillRect(ox, oy, S, S);
  drawGrid(ctx, ox, oy, S);

  const tint = makeCanvas(road.width, road.height);
  const tc = tint.getContext("2d");
  tc.drawImage(road, 0, 0);
  // The OSM tile is white-on-black (opaque). Multiply keeps the road pixels
  // amber and turns the background black; drawing with "lighter" then makes
  // that black transparent against the grid.
  tc.globalCompositeOperation = "multiply";
  tc.fillStyle = "#f0b35a";
  tc.fillRect(0, 0, tint.width, tint.height);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = .92;
  ctx.drawImage(tint, ox, oy, S, S);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // Query skeleton, transformed into the reference frame.
  const qc = makeCanvas(256, 256);
  const qi = qc.getContext("2d").createImageData(256, 256);
  for (let i = 0; i < state.mask.length; i++) {
    if (!state.mask[i]) continue;
    qi.data[i * 4] = 101; qi.data[i * 4 + 1] = 230; qi.data[i * 4 + 2] = 255; qi.data[i * 4 + 3] = 235;
  }
  qc.getContext("2d").putImageData(qi, 0, 0);

  ctx.save();
  ctx.translate(ox + S / 2 + (res.tx * S) / 256, oy + S / 2 + (res.ty * S) / 256);
  ctx.rotate((res.angle * Math.PI) / 180);
  ctx.scale(res.scale, res.scale);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = .92;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qc, -S / 2, -S / 2, S, S);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;

  // frame + crosshair
  ctx.strokeStyle = "rgba(94,234,212,.45)";
  ctx.lineWidth = 1;
  ctx.strokeRect(ox - .5, oy - .5, S + 1, S + 1);
  ctx.strokeStyle = "rgba(94,234,212,.55)";
  ctx.beginPath();
  ctx.moveTo(ox + S / 2 - 7, oy + S / 2); ctx.lineTo(ox + S / 2 + 7, oy + S / 2);
  ctx.moveTo(ox + S / 2, oy + S / 2 - 7); ctx.lineTo(ox + S / 2, oy + S / 2 + 7);
  ctx.stroke();

  label(ctx, `${res.entry.name} · ${res.entry.province}`, `相似度 ${res.sim.toFixed(1)}% · 视场≈${res.fovKm.toFixed(1)} km · 旋转 ${res.angle.toFixed(0)}°`);
  // distance legend
  ctx.fillStyle = "rgba(240,179,90,.85)";
  ctx.font = "10px monospace";
  ctx.fillText("OSM", ox + 10, oy + 18);
  ctx.fillStyle = "rgba(101,230,255,.9)";
  ctx.fillText("PHOTO", ox + 10, oy + 32);
}

function drawGrid(ctx, x, y, S) {
  ctx.strokeStyle = "rgba(148,173,196,.07)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath(); ctx.moveTo(x + S * i / 10, y); ctx.lineTo(x + S * i / 10, y + S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + S * i / 10); ctx.lineTo(x + S, y + S * i / 10); ctx.stroke();
  }
}

function label(ctx, title, sub) {
  const { w } = canvasSize();
  ctx.save();
  ctx.font = "12px -apple-system, 'Segoe UI', sans-serif";
  const tw = ctx.measureText(title).width;
  ctx.fillStyle = "rgba(5,10,15,.78)";
  ctx.fillRect(18, 14, Math.min(w - 36, tw + 20), 40);
  ctx.fillStyle = "#e8eef4";
  ctx.fillText(title, 28, 31);
  ctx.font = "10px monospace";
  ctx.fillStyle = "#8fa2b4";
  ctx.fillText(sub, 28, 46);
  ctx.restore();
}

function getTile(url) {
  if (state.tileCache.has(url)) return state.tileCache.get(url);
  const p = loadImage(url).then((im) => { state.tileCache.set(url, im); return im; });
  state.tileCache.set(url, p);
  return p;
}

// ---------- rectification ----------
function solve8(A, b) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    if (Math.abs(A[i][i]) < 1e-10) return null;
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}


// A seed for the 4-corner tool: the extreme points of the lit lattice give a
// quad that already follows the ground trapezoid, so the user only has to
// nudge it instead of starting from a full-frame rectangle.
function estimateQuad() {
  const ext = state.baseExt || state.ext;
  if (!ext || !ext.mask) return false;
  const N = ext.size, m = ext.mask, side = ext.sourceSide;
  const pts = [];
  for (let y = 0; y < N; y += 2) for (let x = 0; x < N; x += 2) {
    if (!m[y * N + x]) continue;
    const px = (x * side / N - ext.ox) / ext.cw;
    const py = (y * side / N - ext.oy) / ext.ch;
    if (px < 0 || px > 1 || py < 0 || py > 1) continue;
    pts.push([px, py]);
  }
  if (pts.length < 60) return false;
  // Keep only the dense built-up cluster. A long approach road or a cloud
  // streak can otherwise dominate the PCA and make a huge diagonal box.
  const G = 16, cell = N / G, cnt = new Uint16Array(G * G);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m[y * N + x]) cnt[((y / cell) | 0) * G + ((x / cell) | 0)]++;
  let maxC = 0; for (let i = 0; i < cnt.length; i++) maxC = Math.max(maxC, cnt[i]);
  const on = new Uint8Array(G * G);
  const th = Math.max(8, Math.round(maxC * 0.30));
  for (let i = 0; i < cnt.length; i++) on[i] = cnt[i] >= th ? 1 : 0;
  // The city is the largest *connected* block of dense cells.  Cloud bands
  // are diffuse and break into small islands; picking the largest component
  // is therefore stable as long as the cell threshold is high enough.
  const seen = new Uint8Array(G * G), queue = new Int32Array(G * G);
  let best = null, bestN = 0;
  for (let s0 = 0; s0 < G * G; s0++) {
    if (!on[s0] || seen[s0]) continue;
    let head = 0, tail = 0, n = 0, x0 = G, y0 = G, x1 = -1, y1 = -1;
    const cells = [];
    queue[tail++] = s0; seen[s0] = 1;
    while (head < tail) {
      const v = queue[head++]; n++; cells.push(v);
      const x = v % G, y = (v / G) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0) { const j = v - 1; if (on[j] && !seen[j]) { seen[j] = 1; queue[tail++] = j; } }
      if (x < G - 1) { const j = v + 1; if (on[j] && !seen[j]) { seen[j] = 1; queue[tail++] = j; } }
      if (y > 0) { const j = v - G; if (on[j] && !seen[j]) { seen[j] = 1; queue[tail++] = j; } }
      if (y < G - 1) { const j = v + G; if (on[j] && !seen[j]) { seen[j] = 1; queue[tail++] = j; } }
    }
    if (n > bestN) { bestN = n; best = { x0, y0, x1, y1, cells }; }
  }
  if (!best) return false;
  let x0 = best.x0 / G, y0 = best.y0 / G, x1 = (best.x1 + 1) / G, y1 = (best.y1 + 1) / G;
  // A full-frame answer is legitimate for a clean map crop, but it is not a
  // useful "auto fit" for a photo.  Keep it and let the UI say so.
  const area = (x1 - x0) * (y1 - y0);
  if (area > 0.82) {
    state.quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    state.rectDirty = true;
    return false;
  }
  const ex = (x1 - x0) * 0.08, ey = (y1 - y0) * 0.08;
  x0 = Math.max(0, x0 - ex); x1 = Math.min(1, x1 + ex);
  y0 = Math.max(0, y0 - ey); y1 = Math.min(1, y1 + ey);
  state.quad = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  state.rectDirty = true;
  return true;
}

function homography(src, dst) {
  // dst -> src (we need inverse sampling for a forward warp)
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i], { x: X, y: Y } = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solve8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function rectifyCanvas() {
  const S = 720;
  const src = state.quad.map((p) => ({ x: p.x * state.img.width, y: p.y * state.img.height }));
  // Preserve the quad's aspect ratio.  Mapping a 4:3 city straight onto a
  // 720x720 square was the "长方形被压成正方形" bug: every road spacing in y
  // was silently scaled, so a later match could never agree with the square
  // 20 km reference.
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wTop = dist(src[0], src[1]), wBot = dist(src[3], src[2]);
  const hL = dist(src[0], src[3]), hR = dist(src[1], src[2]);
  const qw = Math.max(1, (wTop + wBot) * .5), qh = Math.max(1, (hL + hR) * .5);
  // A calibrated sample can state the ground aspect (a city block is not
  // square just because the photo's bounding box is).  Otherwise keep the
  // quad's photo aspect instead of forcing 1:1.
  const aspect = Number(state.meta?.quadAspect) || (qw / qh);
  let cw, ch;
  if (aspect >= 1) { cw = S; ch = Math.max(Math.round(S * .42), Math.round(S / aspect)); }
  else { ch = S; cw = Math.max(Math.round(S * .42), Math.round(S * aspect)); }
  cw = Math.min(S, cw); ch = Math.min(S, ch);
  const mx = Math.round((S - cw) * .5), my = Math.round((S - ch) * .5);
  const dst = [
    { x: mx, y: my }, { x: mx + cw, y: my },
    { x: mx + cw, y: my + ch }, { x: mx, y: my + ch },
  ];
  const H = homography(src, dst);
  const out = makeCanvas(S, S);
  const octx = out.getContext("2d");
  octx.fillStyle = "#000"; octx.fillRect(0, 0, S, S);
  if (!H) return out;

  const base = makeCanvas(state.img.width, state.img.height);
  base.getContext("2d").drawImage(state.img, 0, 0);
  const bctx = base.getContext("2d", { willReadFrequently: true });
  const srcData = bctx.getImageData(0, 0, base.width, base.height);
  const outData = octx.createImageData(S, S);
  const sw = base.width, sh = base.height;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      if (d === 0) continue;
      const sx = (H[0] * x + H[1] * y + H[2]) / d;
      const sy = (H[3] * x + H[4] * y + H[5]) / d;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= sw - 1 || iy >= sh - 1) continue;
      const fx = sx - ix, fy = sy - iy;
      const o = (y * S + x) * 4;
      for (let k = 0; k < 3; k++) {
        const p00 = srcData.data[(iy * sw + ix) * 4 + k];
        const p10 = srcData.data[(iy * sw + ix + 1) * 4 + k];
        const p01 = srcData.data[((iy + 1) * sw + ix) * 4 + k];
        const p11 = srcData.data[((iy + 1) * sw + ix + 1) * 4 + k];
        outData.data[o + k] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
      outData.data[o + 3] = 255;
    }
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

// ---------- UI ----------
function bindUI() {
  $("#fileInput").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      const img = await loadImage(url);
      await setImage(img, { name: f.name.replace(/\.[^.]+$/, ""), note: "本地图片" }, url);
    } catch (err) {
      setStatus("图片读取失败：" + err.message, "busy");
    }
  });

  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((n) => dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", async (e) => {
    const f = e.dataTransfer.files?.[0];
    if (!f || !f.type.startsWith("image/")) return;
    const url = URL.createObjectURL(f);
    const img = await loadImage(url);
    await setImage(img, { name: f.name.replace(/\.[^.]+$/, ""), note: "本地图片" }, url);
  });

  $("#runBtn").addEventListener("click", runMatch);
  $("#fitBtn").addEventListener("click", draw);
  $("#downloadOverlay").addEventListener("click", () => {
    const a = document.createElement("a");
    a.download = "aerialsigna-overlay.png";
    a.href = $("#view").toDataURL("image/png");
    a.click();
  });

  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
      if (state.view !== "source") applyRectify();
      draw();
    });
  });

  $("#rectify").addEventListener("change", (e) => {
    state.rectify = e.target.checked;
    state.rectDirty = true;
    applyRectify();
    draw();
  });
  $("#autoRect")?.addEventListener("click", () => {
    if (!state.img) return;
    if (state.initialQuad) {
      state.quad = state.initialQuad.map((p) => ({ x: p.x, y: p.y }));
    } else if (!estimateQuad()) {
      setStatus("未检测到明确城区，已保留全图；请手动拖动四角", "busy");
      return;
    }
    state.rectDirty = true;
    applyRectify();
    draw();
    setStatus("已恢复载入时的自动四角；可继续拖动微调", "ok");
  });

  const cv = $("#view");
  const hitRadius = () => Math.max(34, Math.min(cv.width, cv.height) * 0.055);
  const edgeRadius = () => Math.max(12, Math.min(cv.width, cv.height) * 0.018);
  const quadOnCanvas = () => {
    const r = imageRect(state.img, cv.width, cv.height, 0);
    return state.quad.map((q) => ({ x: r.x + q.x * r.w, y: r.y + q.y * r.h }));
  };
  const cornerAt = (p, pts = quadOnCanvas()) => {
    let best = -1, bd = hitRadius();
    pts.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const distanceToSegment = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  };
  const edgeAt = (p, pts = quadOnCanvas()) => {
    let best = -1, bd = edgeRadius();
    for (let i = 0; i < 4; i++) {
      const d = distanceToSegment(p, pts[i], pts[(i + 1) % 4]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const insideQuad = (p, pts = quadOnCanvas()) => {
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > p.y) !== (yj > p.y)) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const shiftQuad = (base, dx, dy) => {
    const minx = Math.min(...base.map((q) => q.x)), maxx = Math.max(...base.map((q) => q.x));
    const miny = Math.min(...base.map((q) => q.y)), maxy = Math.max(...base.map((q) => q.y));
    const sx = Math.max(-minx, Math.min(1 - maxx, dx));
    const sy = Math.max(-miny, Math.min(1 - maxy, dy));
    return base.map((q) => ({ x: q.x + sx, y: q.y + sy }));
  };
  const shiftEdge = (base, i, dx, dy) => {
    const j = (i + 1) % 4;
    const minx = Math.min(base[i].x, base[j].x), maxx = Math.max(base[i].x, base[j].x);
    const miny = Math.min(base[i].y, base[j].y), maxy = Math.max(base[i].y, base[j].y);
    const sx = Math.max(-minx, Math.min(1 - maxx, dx));
    const sy = Math.max(-miny, Math.min(1 - maxy, dy));
    return base.map((q, k) => k === i || k === j ? { x: q.x + sx, y: q.y + sy } : { x: q.x, y: q.y });
  };

  cv.addEventListener("pointerdown", (e) => {
    if (!state.rectify || state.view === "overlay" || !state.img) return;
    const p = canvasPoint(e);
    const pts = quadOnCanvas();
    const ci = cornerAt(p, pts);
    let drag = null;
    if (ci >= 0) {
      drag = { kind: "corner", index: ci };
    } else {
      const ei = edgeAt(p, pts);
      if (ei >= 0) {
        drag = {
          kind: "edge", index: ei, start: p,
          base: state.quad.map((q) => ({ ...q })),
        };
      } else if (insideQuad(p, pts)) {
        drag = {
          kind: "move", start: p,
          base: state.quad.map((q) => ({ ...q })),
        };
      }
    }
    if (!drag) return;
    state.drag = drag;
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = "grabbing";
    e.preventDefault();
  });

  cv.addEventListener("pointermove", (e) => {
    const p = canvasPoint(e);
    if (!state.drag) {
      let cursor = "default";
      if (state.rectify && state.view !== "overlay" && state.img) {
        const pts = quadOnCanvas();
        if (cornerAt(p, pts) >= 0 || edgeAt(p, pts) >= 0) cursor = "grab";
        else if (insideQuad(p, pts)) cursor = "move";
      }
      cv.style.cursor = cursor;
      return;
    }
    const r = imageRect(state.img, cv.width, cv.height, 0);
    const drag = state.drag;
    if (drag.kind === "corner") {
      state.quad[drag.index] = {
        x: Math.max(0, Math.min(1, (p.x - r.x) / r.w)),
        y: Math.max(0, Math.min(1, (p.y - r.y) / r.h)),
      };
    } else if (drag.kind === "edge") {
      state.quad = shiftEdge(drag.base, drag.index, (p.x - drag.start.x) / r.w, (p.y - drag.start.y) / r.h);
    } else if (drag.kind === "move") {
      state.quad = shiftQuad(drag.base, (p.x - drag.start.x) / r.w, (p.y - drag.start.y) / r.h);
    }
    state.rectDirty = true;
    drawSource();
  });

  const endDrag = (e) => {
    if (!state.drag) return;
    state.drag = null;
    cv.style.cursor = "grab";
    if (e && cv.hasPointerCapture?.(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    // Refresh 叠加 immediately: the old code left the overlay stale until
    // the next tab switch or a full match.
    if (state.rectify) applyRectify();
    draw();
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  $("#province").addEventListener("change", () => { if (state.results.length) state.results = []; renderResults(); });
}

function canvasPoint(e) {
  const cv = $("#view");
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
}

init();
