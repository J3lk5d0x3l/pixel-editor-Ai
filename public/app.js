'use strict';
// ===================================================================
//  Pixel Editor — lógica del cliente
//  Editor de pixel art para resourcepacks de Minecraft.
// ===================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- Captura global de errores (banner visible) ----------
function showFatal(msg) {
  let bar = document.getElementById('errbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'errbar';
    bar.addEventListener('click', () => { bar.style.display = 'none'; });
    (document.body || document.documentElement).appendChild(bar);
  }
  bar.textContent = '⚠ Error: ' + msg + '  (clic para cerrar)';
  bar.style.display = 'block';
  // también a la consola por si está abierta
  try { console.error('[PixelEditor]', msg); } catch {}
}
window.addEventListener('error', (e) => {
  showFatal((e.message || 'error') + (e.filename ? ` — ${e.filename.split('/').pop()}:${e.lineno}` : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason; showFatal('Promesa rechazada: ' + (r && r.message ? r.message : String(r)));
});

const state = {
  files: [],            // [{path,size,mtime}]
  current: null,        // { path, w, h }
  doc: document.createElement('canvas'),  // = canvas de la CAPA ACTIVA (todo el dibujo va aquí)
  dctx: null,
  layers: [],           // pila de capas del FOTOGRAMA activo (= frames[activeFrame].layers)
  activeLayer: 0,       // índice de la capa activa
  composite: document.createElement('canvas'), // mezcla visible de las capas del fotograma activo
  cctx: null,
  frames: [],           // animación: [{ layers:[...], active:int }] — un stack de capas por fotograma
  activeFrame: 0,       // índice del fotograma activo
  onion: false,         // papel cebolla (ver fotograma anterior tenue)
  fps: 8,               // velocidad de reproducción
  playing: false,       // ¿reproduciendo la animación?
  _playT: null,         // id del temporizador de reproducción
  srcMeta: null,        // .mcmeta del archivo abierto (para preservarlo/borrarlo al guardar)
  view: $('#view'),
  vctx: null,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  tool: 'pencil',
  prevTool: 'pencil',
  color: { r: 255, g: 255, b: 255, a: 255 },   // color primario (FG) — clic izquierdo
  color2: { r: 0, g: 0, b: 0, a: 255 },        // color secundario (BG) — clic derecho
  drawColor: null,      // color del trazo en curso (FG o BG según el botón)
  dither: false,        // tramado: relleno en damero FG/BG y degradado tramado
  gradient: null,       // { x0,y0,x1,y1 } mientras se arrastra la herramienta degradado
  brush: 1,
  showGrid: true,
  drawing: false,
  last: null,           // último píxel pintado en el trazo
  preview: null,        // { tool, x0,y0,x1,y1 } para línea/rect
  undo: [],
  redo: [],
  dirty: false,
  maskMode: false,
  mask: document.createElement('canvas'),
  mctx: null,
  maskBrush: 3,
  aiResult: null,       // dataURL del resultado IA pendiente de aplicar
  symmetry: 'none',     // simetría espejo: 'none' | 'x' (eje vertical) | 'y' (eje horizontal) | 'xy' (ambos)
  fillShape: false,     // rellenar rect/elipse
  pixelPerfect: true,   // limpiar píxeles dobles en curvas (lápiz)
  stroke: null,         // estado del trazo actual (pixel-perfect)
  sel: null,            // caja contenedora de la selección {x,y,w,h} (rect o bbox de la máscara)
  selMask: null,        // Uint8Array(W*H): 1=seleccionado. null = selección rectangular (toda la caja)
  floating: null,       // contenido flotante al mover {canvas,x,y,w,h}
  selStart: null,       // inicio de una selección nueva (px,py)
  selMove: null,        // inicio de un arrastre de movimiento (px,py)
  lasso: null,          // puntos del lazo en curso [[x,y],...]
};

state.dctx = state.doc.getContext('2d', { willReadFrequently: true });
state.vctx = state.view.getContext('2d');
state.mctx = state.mask.getContext('2d', { willReadFrequently: true });
state.cctx = state.composite.getContext('2d', { willReadFrequently: true });
const onionCanvas = document.createElement('canvas'); // auxiliar para el papel cebolla

// ===================================================================
//  SISTEMA DE CAPAS
//  state.doc / state.dctx apuntan SIEMPRE a la capa activa: así todo el
//  código de dibujo existente sigue funcionando sin cambios. El compuesto
//  (state.composite) es la mezcla visible que dibuja render().
// ===================================================================
let _layerId = 0;
function makeLayer(name, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return { id: ++_layerId, name: name || `Capa ${_layerId}`, canvas, ctx, visible: true, opacity: 1 };
}
function activeLayer() { return state.layers[state.activeLayer]; }
// Reapunta state.doc/dctx a la capa activa (tras cambiar de capa o reconstruir la pila).
function pointDocToActive() {
  const L = activeLayer();
  if (!L) return;
  state.doc = L.canvas; state.dctx = L.ctx;
}
// Reconstruye el compuesto: mezcla todas las capas visibles con su opacidad.
function recomposite() {
  const c = state.composite, cc = state.cctx;
  cc.clearRect(0, 0, c.width, c.height);
  for (const L of state.layers) {
    if (!L.visible || L.opacity <= 0) continue;
    cc.globalAlpha = L.opacity;
    cc.drawImage(L.canvas, 0, 0);
  }
  cc.globalAlpha = 1;
}
// Itera TODAS las capas de TODOS los fotogramas (para transforms/redimensión globales).
function allLayers() {
  const out = [];
  for (const fr of state.frames) for (const L of fr.layers) out.push(L);
  return out;
}
// Cambia el tamaño del documento: redimensiona compuesto, máscara y TODAS las capas de TODOS los fotogramas.
// Por defecto preserva el contenido existente de cada capa (esquina superior izquierda).
function setDocSize(w, h, { preserve = true } = {}) {
  for (const L of allLayers()) {
    if (L.canvas.width === w && L.canvas.height === h) continue;
    if (preserve) {
      const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
      tmp.getContext('2d').drawImage(L.canvas, 0, 0);
      L.canvas.width = w; L.canvas.height = h;
      L.ctx.clearRect(0, 0, w, h); L.ctx.drawImage(tmp, 0, 0);
    } else {
      L.canvas.width = w; L.canvas.height = h;
    }
  }
  state.composite.width = w; state.composite.height = h;
  state.mask.width = w; state.mask.height = h; clearMask();
  pointDocToActive();
}
// Arranca un documento nuevo: 1 fotograma, 1 capa, con el dibujo dado (o en blanco).
// frames opcional: array de funciones (ctx)=>void, una por fotograma, para importar animaciones.
function initLayers(w, h, drawCb, frameDraws) {
  stopPlay();
  state.composite.width = w; state.composite.height = h;
  const draws = frameDraws && frameDraws.length ? frameDraws : [drawCb];
  state.frames = draws.map((fn) => {
    const base = makeLayer('Fondo', w, h);
    if (fn) fn(base.ctx);
    return { layers: [base], active: 0 };
  });
  state.activeFrame = 0;
  state.layers = state.frames[0].layers;
  state.activeLayer = 0;
  pointDocToActive();
  state.mask.width = w; state.mask.height = h; clearMask();
  renderLayersPanel(); renderFrames();
}

// ---------- Fotogramas (animación) ----------
function curFrame() { return state.frames[state.activeFrame]; }
// Guarda el índice de capa activa en el fotograma actual (antes de cambiar de fotograma).
function syncFrameActive() { if (curFrame()) curFrame().active = state.activeLayer; }
function gotoFrame(i) {
  if (i < 0 || i >= state.frames.length) return;
  if (state.floating) dropFloating();
  syncFrameActive();
  state.activeFrame = i;
  state.layers = curFrame().layers;
  state.activeLayer = Math.min(curFrame().active, state.layers.length - 1);
  pointDocToActive();
  renderLayersPanel(); renderFrames(); render();
}
function addFrame(opts = {}) {
  if (!state.current) return;
  pushUndo(); syncFrameActive();
  const w = state.composite.width, h = state.composite.height;
  let layers;
  if (opts.dup) { // clona el stack del fotograma actual
    layers = curFrame().layers.map((L) => {
      const n = makeLayer(L.name, w, h); n.visible = L.visible; n.opacity = L.opacity;
      n.ctx.drawImage(L.canvas, 0, 0); return n;
    });
  } else {
    layers = [makeLayer('Fondo', w, h)];
  }
  state.frames.splice(state.activeFrame + 1, 0, { layers, active: 0 });
  markDirty(true);
  gotoFrame(state.activeFrame + 1);
}
function deleteFrame() {
  if (state.frames.length <= 1) { toast('No puedes borrar el único fotograma', 'err'); return; }
  pushUndo();
  state.frames.splice(state.activeFrame, 1);
  if (state.activeFrame >= state.frames.length) state.activeFrame = state.frames.length - 1;
  markDirty(true);
  state.layers = curFrame().layers; state.activeLayer = Math.min(curFrame().active, state.layers.length - 1);
  pointDocToActive();
  renderLayersPanel(); renderFrames(); render();
}
function moveFrame(dir) {
  const i = state.activeFrame, j = i + dir;
  if (j < 0 || j >= state.frames.length) return;
  pushUndo(); syncFrameActive();
  [state.frames[i], state.frames[j]] = [state.frames[j], state.frames[i]];
  state.activeFrame = j;
  markDirty(true); renderFrames();
}
// Mezcla las capas de un fotograma dado en un canvas destino (para miniaturas / onion / export).
function compositeFrameTo(frame, ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  for (const L of frame.layers) {
    if (!L.visible || L.opacity <= 0) continue;
    ctx.globalAlpha = L.opacity;
    ctx.drawImage(L.canvas, 0, 0);
  }
  ctx.globalAlpha = 1;
}

// ---------- Reproducción ----------
function stopPlay() {
  if (state._playT) { clearInterval(state._playT); state._playT = null; }
  state.playing = false;
  const b = document.getElementById('btnPlay');
  if (b) b.innerHTML = '<svg class="ico"><use href="#i-play"/></svg>';
}
// Resalta el fotograma activo en la tira sin reconstruirla (barato, para la reproducción).
function highlightActiveFrame() {
  const cells = document.querySelectorAll('#frameStrip .tl-frame');
  cells.forEach((c, i) => c.classList.toggle('active', i === state.activeFrame));
}
function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  if (!state.current || state.frames.length < 2) return;
  state.playing = true;
  const b = document.getElementById('btnPlay');
  if (b) b.innerHTML = '<svg class="ico"><use href="#i-pause"/></svg>';
  state._playT = setInterval(() => {
    syncFrameActive();
    state.activeFrame = (state.activeFrame + 1) % state.frames.length;
    state.layers = curFrame().layers;
    state.activeLayer = Math.min(curFrame().active, state.layers.length - 1);
    pointDocToActive();
    highlightActiveFrame();
    render();
  }, Math.max(20, 1000 / state.fps));
}

function addLayer(opts = {}) {
  if (!state.current) return;
  pushUndo();
  const w = state.composite.width, h = state.composite.height;
  const L = makeLayer(opts.name, w, h);
  if (opts.from) L.ctx.drawImage(opts.from, 0, 0); // duplicar
  state.layers.splice(state.activeLayer + 1, 0, L); // encima de la activa
  state.activeLayer++;
  pointDocToActive();
  markDirty(true); renderLayersPanel(); render();
}
function duplicateLayer() {
  const L = activeLayer(); if (!L) return;
  addLayer({ name: L.name + ' copia', from: L.canvas });
}
function deleteLayer() {
  if (state.layers.length <= 1) { toast('No puedes borrar la única capa', 'err'); return; }
  pushUndo();
  state.layers.splice(state.activeLayer, 1);
  if (state.activeLayer >= state.layers.length) state.activeLayer = state.layers.length - 1;
  pointDocToActive();
  markDirty(true); renderLayersPanel(); render();
}
function moveLayer(dir) { // dir: -1 abajo, +1 arriba (en orden visual)
  const i = state.activeLayer, j = i + dir;
  if (j < 0 || j >= state.layers.length) return;
  pushUndo();
  [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
  state.activeLayer = j;
  pointDocToActive();
  markDirty(true); renderLayersPanel(); render();
}
function selectLayer(i) {
  if (i < 0 || i >= state.layers.length) return;
  if (state.floating) dropFloating(); // fija lo flotante antes de cambiar de capa
  state.activeLayer = i;
  pointDocToActive();
  renderLayersPanel(); render();
}
function setLayerOpacity(v) {
  const L = activeLayer(); if (!L) return;
  L.opacity = Math.min(1, Math.max(0, v));
  markDirty(true); render();
}
function toggleLayerVisible(i) {
  const L = state.layers[i]; if (!L) return;
  L.visible = !L.visible;
  markDirty(true); renderLayersPanel(); render();
}

// Pinta la lista de capas (orden visual: la de arriba se muestra primero).
function renderLayersPanel() {
  const list = document.getElementById('layerList');
  if (!list) return;
  list.innerHTML = '';
  if (!state.current || !state.layers.length) {
    list.innerHTML = '<div class="layer-empty">Abre o crea una textura</div>';
    const op = document.getElementById('layerOpacity'); if (op) op.value = 100;
    return;
  }
  // de arriba (última) hacia abajo (primera)
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const L = state.layers[i];
    const row = document.createElement('div');
    row.className = 'layer-row' + (i === state.activeLayer ? ' active' : '');
    row.dataset.idx = i;

    const eye = document.createElement('button');
    eye.className = 'layer-eye' + (L.visible ? '' : ' off');
    eye.title = L.visible ? 'Ocultar capa' : 'Mostrar capa';
    eye.innerHTML = `<svg class="ico"><use href="#${L.visible ? 'i-eye' : 'i-eye-off'}"/></svg>`;
    eye.addEventListener('click', (e) => { e.stopPropagation(); toggleLayerVisible(i); });

    // miniatura del contenido de la capa
    const thumb = document.createElement('canvas');
    thumb.className = 'layer-thumb';
    thumb.width = 22; thumb.height = 22;
    const tc = thumb.getContext('2d');
    tc.imageSmoothingEnabled = false;
    const s = Math.min(22 / L.canvas.width, 22 / L.canvas.height);
    const dw = L.canvas.width * s, dh = L.canvas.height * s;
    tc.drawImage(L.canvas, (22 - dw) / 2, (22 - dh) / 2, dw, dh);

    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = L.name;
    name.title = 'Doble clic para renombrar';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const nv = prompt('Nombre de la capa:', L.name);
      if (nv && nv.trim()) { L.name = nv.trim(); renderLayersPanel(); markDirty(true); }
    });

    row.append(eye, thumb, name);
    row.addEventListener('click', () => selectLayer(i));
    list.appendChild(row);
  }
  const op = document.getElementById('layerOpacity');
  if (op) op.value = Math.round((activeLayer()?.opacity ?? 1) * 100);
}

// Cableado de los controles del panel de capas
document.getElementById('btnLayerAdd').addEventListener('click', () => addLayer());
document.getElementById('btnLayerDup').addEventListener('click', duplicateLayer);
document.getElementById('btnLayerUp').addEventListener('click', () => moveLayer(+1));
document.getElementById('btnLayerDown').addEventListener('click', () => moveLayer(-1));
document.getElementById('btnLayerDel').addEventListener('click', deleteLayer);
document.getElementById('layerOpacity').addEventListener('input', (e) => setLayerOpacity(+e.target.value / 100));

// Pinta la tira de fotogramas (timeline).
function renderFrames() {
  const strip = document.getElementById('frameStrip');
  if (!strip) return;
  strip.innerHTML = '';
  const multi = state.current && state.frames.length > 0;
  document.getElementById('btnPlay').disabled = !state.current || state.frames.length < 2;
  document.getElementById('btnFrameDel').disabled = !state.current || state.frames.length < 2;
  document.getElementById('btnOnion').classList.toggle('active', state.onion);
  if (!multi) { strip.innerHTML = '<div class="tl-empty">Sin documento</div>'; return; }
  const w = state.composite.width, h = state.composite.height;
  state.frames.forEach((fr, i) => {
    const cell = document.createElement('div');
    cell.className = 'tl-frame' + (i === state.activeFrame ? ' active' : '');
    cell.title = `Fotograma ${i + 1}`;
    const cv = document.createElement('canvas');
    cv.className = 'tl-thumb'; cv.width = 40; cv.height = 40;
    const tc = cv.getContext('2d'); tc.imageSmoothingEnabled = false;
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    compositeFrameTo(fr, tmp.getContext('2d'), w, h);
    const s = Math.min(40 / w, 40 / h), dw = w * s, dh = h * s;
    tc.drawImage(tmp, (40 - dw) / 2, (40 - dh) / 2, dw, dh);
    const num = document.createElement('span'); num.className = 'tl-num'; num.textContent = i + 1;
    cell.append(cv, num);
    cell.addEventListener('click', () => { stopPlay(); gotoFrame(i); });
    strip.appendChild(cell);
  });
}

// Cambia la herramienta activa y marca el botón correspondiente en la toolbar.
function setTool(id) {
  const valid = new Set(['pencil','eraser','fill','picker','line','rect','ellipse','gradient','pan','select','lasso','wand']);
  if (!valid.has(id)) return;
  state.prevTool = state.tool;
  state.tool = id;
  for (const btn of document.querySelectorAll('.tool[data-tool]')) {
    btn.classList.toggle('active', btn.dataset.tool === id);
  }
  // Cursor por defecto (algunas herramientas lo sobreescriben en mousedown).
  const view = state.view;
  if (view) view.style.cursor = (id === 'pan') ? 'grab' : (id === 'picker' ? 'crosshair' : 'crosshair');
  updateInpaintSelUI();
}

// Sin UI de "rediseñar zona" en la versión pública: stub seguro.
function updateInpaintSelUI() { /* no-op */ }

// Sin máscara de IA en la versión pública: stub seguro.
function clearMask() { /* no-op */ }

// Voltea el documento (o la selección) horizontal/verticalmente.
function flipDoc(horizontal) {
  const target = state.floating || state.doc;
  const w = target.width, h = target.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.translate(horizontal ? w : 0, horizontal ? 0 : h);
  cx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
  cx.drawImage(target, 0, 0);
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(c, 0, 0);
  render();
}

// Zoom relativo (1.25 = +25%).
function zoomBy(factor) {
  const wrap = $('#canvasWrap');
  const newZoom = Math.max(1, Math.min(64, state.zoom * factor));
  const cx = (wrap.clientWidth / 2 - state.offsetX) / state.zoom;
  const cy = (wrap.clientHeight / 2 - state.offsetY) / state.zoom;
  state.zoom = newZoom;
  state.offsetX = wrap.clientWidth / 2 - cx * state.zoom;
  state.offsetY = wrap.clientHeight / 2 - cy * state.zoom;
  render();
}

// Cableado de los botones de herramientas (toolbar).
for (const btn of document.querySelectorAll('.tool[data-tool]')) {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
}

// Cableado de los botones de transformación/zoom de la toolbar.
document.getElementById('btnFlipH') && document.getElementById('btnFlipH').addEventListener('click', () => flipDoc(true));
document.getElementById('btnFlipV') && document.getElementById('btnFlipV').addEventListener('click', () => flipDoc(false));
document.getElementById('btnRotate') && document.getElementById('btnRotate').addEventListener('click', () => flipDoc(true)); // 90° se hace con doble flip
document.getElementById('btnZoomIn') && document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(1.25));
document.getElementById('btnZoomOut') && document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.25));
document.getElementById('btnFit') && document.getElementById('btnFit').addEventListener('click', fitToView);

// Cableado de la timeline (animación)
document.getElementById('btnPlay').addEventListener('click', togglePlay);
document.getElementById('btnFrameAdd').addEventListener('click', () => addFrame());
document.getElementById('btnFrameDup').addEventListener('click', () => addFrame({ dup: true }));
document.getElementById('btnFrameDel').addEventListener('click', deleteFrame);
document.getElementById('btnOnion').addEventListener('click', () => {
  state.onion = !state.onion;
  document.getElementById('btnOnion').classList.toggle('active', state.onion);
  render();
});
document.getElementById('fpsInput').addEventListener('input', (e) => {
  state.fps = Math.min(60, Math.max(1, +e.target.value || 8));
  if (state.playing) { stopPlay(); togglePlay(); } // reinicia el temporizador con el nuevo FPS
});

// ---------- Utilidades ----------
function toast(msg, kind = '', ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function rgbaStr(c) { return `rgba(${c.r},${c.g},${c.b},${c.a / 255})`; }

async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.blob();
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    if (data && !(data instanceof Blob)) {
      if (data.error) msg = data.error;
      else if (typeof data.detail === 'string') msg = data.detail;
      else if (Array.isArray(data.detail)) {
        msg = data.detail.map((d) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join(' · ');
      }
    }
    throw new Error(msg);
  }
  return data;
}

// ===================================================================
//  ÁRBOL DE ARCHIVOS
// ===================================================================
function buildTreeData(files) {
  const root = { name: '', folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.folders.has(parts[i])) node.folders.set(parts[i], { name: parts[i], folders: new Map(), files: [] });
      node = node.folders.get(parts[i]);
    }
    node.files.push(f);
  }
  return root;
}

function renderTree() {
  const treeEl = $('#tree');
  if (typeof window.hidePreview === 'function') window.hidePreview(); // evita preview huérfana al re-renderizar
  treeEl.innerHTML = '';
  const data = buildTreeData(state.files);
  if (!state.files.length) {
    treeEl.innerHTML = '<div class="tree-empty">No se encontraron PNG en el pack.</div>';
    return;
  }
  treeEl.appendChild(renderFolderChildren(data, ''));
}

function renderFolderChildren(node, prefix) {
  const frag = document.createDocumentFragment();
  const folders = Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) frag.appendChild(renderFolder(folder, prefix ? prefix + '/' + folder.name : folder.name));
  for (const file of node.files) frag.appendChild(renderFile(file));
  return frag;
}

function renderFolder(folder, fullPath) {
  const el = document.createElement('div');
  el.className = 'tree-node tree-folder';
  el.dataset.path = fullPath;
  const total = countFiles(folder);
  el.innerHTML = `<div class="row"><span class="caret">▾</span><svg class="ico" style="width:14px;height:14px;margin-right:4px"><use href="#i-folder"/></svg><span class="folder-name">${folder.name}</span><span style="color:var(--muted);margin-left:auto;font-size:10px">${total}</span></div>`;
  const children = document.createElement('div');
  children.className = 'children';
  children.appendChild(renderFolderChildren(folder, fullPath));
  el.appendChild(children);
  const row = el.querySelector('.row');
  row.addEventListener('click', () => el.classList.toggle('collapsed'));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showFolderMenu(e, fullPath); });
  return el;
}
function countFiles(folder) {
  let n = folder.files.length;
  for (const f of folder.folders.values()) n += countFiles(f);
  return n;
}

function renderFile(file) {
  const el = document.createElement('div');
  el.className = 'tree-node tree-file';
  el.dataset.path = file.path;
  const name = file.path.split('/').pop();
  el.innerHTML = `<div class="row"><img class="tree-thumb" loading="lazy" src="/api/file?path=${encodeURIComponent(file.path)}" /><span class="file-name" title="${file.path}">${name}</span><span class="dot"></span></div>`;
  const row = el.querySelector('.row');
  row.addEventListener('click', () => openFile(file.path));
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showFileMenu(e, file.path); });
  return el;
}

function setActiveInTree(path) {
  $$('.tree-file').forEach((el) => el.classList.toggle('active', el.dataset.path === path));
  const active = $(`.tree-file[data-path="${CSS.escape(path)}"]`);
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function markDirty(on) {
  state.dirty = on;
  $('#btnSave').disabled = !on;
  if (state.current && state.current.path) {
    const el = $(`.tree-file[data-path="${CSS.escape(state.current.path)}"]`);
    if (el) el.classList.toggle('dirty', on);
  }
  if (on) schedulePersist(); else persistState();
}

// Buscador
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  $$('.tree-file').forEach((el) => {
    const match = !q || el.dataset.path.toLowerCase().includes(q);
    el.style.display = match ? '' : 'none';
  });
  // Mostrar/ocultar carpetas según tengan hijos visibles
  $$('.tree-folder').forEach((el) => {
    const anyVisible = Array.from(el.querySelectorAll('.tree-file')).some((f) => f.style.display !== 'none');
    el.style.display = anyVisible ? '' : 'none';
    if (q && anyVisible) el.classList.remove('collapsed');
  });
});

// ===================================================================
//  GESTIÓN DE ARCHIVOS (menú contextual del árbol)
// ===================================================================
async function apiFs(op, body) {
  return api('/api/fs/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function hideCtxMenu() { $('#ctxMenu').classList.add('hidden'); }
function showCtxMenu(x, y, items) {
  const m = $('#ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const d = document.createElement('div');
    d.className = 'item' + (it.danger ? ' danger' : '');
    d.innerHTML = (it.icon ? `<svg class="ico"><use href="#${it.icon}"/></svg>` : '') + it.label;
    d.addEventListener('click', () => { hideCtxMenu(); it.action(); });
    m.appendChild(d);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 6) + 'px';
}
window.addEventListener('click', hideCtxMenu);
window.addEventListener('blur', hideCtxMenu);

function showFileMenu(e, p) {
  showCtxMenu(e.clientX, e.clientY, [
    { label: 'Abrir', icon: 'i-pencil', action: () => openFile(p) },
    { label: 'Renombrar', action: () => renameItem(p) },
    { label: 'Duplicar', action: () => duplicateItem(p) },
    { label: 'Mover a…', action: () => moveItem(p) },
    { sep: true },
    { label: 'Eliminar', icon: 'i-trash', danger: true, action: () => deleteItem(p) },
  ]);
}
function showFolderMenu(e, folderPath) {
  showCtxMenu(e.clientX, e.clientY, [
    { label: 'Nueva carpeta', icon: 'i-folder', action: () => newFolder(folderPath) },
    { label: 'Nueva imagen…', action: () => newImage(folderPath) },
    { label: 'Renombrar', action: () => renameItem(folderPath) },
    { sep: true },
    { label: 'Eliminar carpeta', icon: 'i-trash', danger: true, action: () => deleteItem(folderPath) },
  ]);
}

async function renameItem(p) {
  const cur = p.split('/').pop();
  const name = prompt('Nuevo nombre:', cur);
  if (!name || name === cur) return;
  try {
    const r = await apiFs('rename', { path: p, name });
    if (state.current && state.current.path === p) { state.current.path = r.path; $('#stPath').textContent = r.path; persistState(); }
    await loadTree(); setActiveInTree(r.path); toast('Renombrado ✓', 'ok');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
}
async function duplicateItem(p) {
  try { const r = await apiFs('duplicate', { path: p }); await loadTree(); setActiveInTree(r.path); toast('Duplicado: ' + r.path.split('/').pop(), 'ok'); }
  catch (err) { toast('Error: ' + err.message, 'err'); }
}
async function moveItem(p) {
  const dest = prompt('Mover a qué carpeta (ruta dentro del pack):', p.split('/').slice(0, -1).join('/'));
  if (dest === null) return;
  try {
    const r = await apiFs('move', { path: p, dest });
    if (state.current && state.current.path === p) { state.current.path = r.path; $('#stPath').textContent = r.path; persistState(); }
    await loadTree(); setActiveInTree(r.path); toast('Movido ✓', 'ok');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
}
async function deleteItem(p) {
  if (!confirm(`¿Mover a la papelera?\n\n${p}\n\nSe guarda en backups/trash (reversible).`)) return;
  try {
    await apiFs('delete', { path: p });
    if (state.current && state.current.path === p) {
      state.current = null; markDirty(false); $('#noFile').classList.remove('hidden');
      $('#stPath').textContent = ''; $('#stSize').textContent = '—'; $('#ctxBar').style.display = 'none';
      render(); localStorage.removeItem('pe_state');
    }
    await loadTree(); toast('Movido a la papelera ✓', 'ok');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
}
async function newFolder(parent) {
  const name = prompt('Nombre de la nueva carpeta:', 'nueva_carpeta');
  if (!name) return;
  try { await apiFs('mkdir', { path: (parent ? parent + '/' : '') + name }); await loadTree(); toast('Carpeta creada ✓', 'ok'); }
  catch (err) { toast('Error: ' + err.message, 'err'); }
}
async function newImage(parent) {
  let name = prompt('Nombre de la imagen (.png):', 'nueva.png');
  if (!name) return;
  if (!name.toLowerCase().endsWith('.png')) name += '.png';
  const size = Math.max(1, Math.min(512, parseInt(prompt('Tamaño en px (ej. 16, 32):', '16'), 10) || 16));
  const rel = (parent ? parent + '/' : '') + name;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  try {
    await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rel, dataUrl: c.toDataURL('image/png') }) });
    await loadTree(); openFile(rel); toast('Imagen creada: ' + name, 'ok');
  } catch (err) { toast('Error: ' + err.message, 'err'); }
}
// Clic derecho en zona vacía del árbol = menú de la raíz
$('#tree').addEventListener('contextmenu', (e) => {
  if (e.target.closest('.tree-node')) return;
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, [
    { label: 'Nueva carpeta', icon: 'i-folder', action: () => newFolder('') },
    { label: 'Nueva imagen…', action: () => newImage('') },
  ]);
});

// ===================================================================
//  ABRIR / GUARDAR ARCHIVO
// ===================================================================
async function openFile(path) {
  if (state.dirty && !confirm('Hay cambios sin guardar en la imagen actual. ¿Descartarlos y abrir otra?')) return;
  try {
    // El contexto trae el .mcmeta: lo necesitamos ANTES de cargar para saber si es animación.
    let ctx = null;
    try { ctx = await api('/api/context?path=' + encodeURIComponent(path)); } catch {}
    const blob = await api('/api/file?path=' + encodeURIComponent(path));
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const W = img.naturalWidth, H = img.naturalHeight;
      const anim = ctx && ctx.mcmeta && ctx.mcmeta.animation;
      state.srcMeta = (ctx && ctx.mcmeta) ? ctx.mcmeta : null;
      // Tira vertical de fotogramas cuadrados → dividir en fotogramas para la timeline.
      const canSplit = !!anim && H > W && H % W === 0;
      if (canSplit) {
        const fw = W, n = H / fw;
        // Respeta el orden de fotogramas si el .mcmeta lo define (frames: [índices] o [{index}]).
        const order = Array.isArray(anim.frames) && anim.frames.length
          ? anim.frames.map((f) => (typeof f === 'object' && f ? f.index : f)).filter((v) => Number.isInteger(v) && v < n)
          : Array.from({ length: n }, (_, k) => k);
        const seq = order.length ? order : Array.from({ length: n }, (_, k) => k);
        const draws = seq.map((idx) => (c) => c.drawImage(img, 0, idx * fw, fw, fw, 0, 0, fw, fw));
        initLayers(fw, fw, null, draws);
        const ft = (typeof anim.frametime === 'number' && anim.frametime > 0) ? anim.frametime : 1;
        state.fps = Math.min(60, Math.max(1, Math.round(20 / ft)));
        document.getElementById('fpsInput').value = state.fps;
        state.current = { path, w: fw, h: fw };
      } else {
        initLayers(W, H, (c) => c.drawImage(img, 0, 0));
        state.current = { path, w: W, h: H };
      }
      state.undo = []; state.redo = [];
      state.sel = null; state.selMask = null; state.floating = null; state.selStart = null; state.selMove = null; state.lasso = null;
      markDirty(false);
      $('#noFile').classList.add('hidden');
      const cw = state.composite.width, ch = state.composite.height;
      $('#stSize').textContent = `${cw}×${ch}px` + (state.frames.length > 1 ? ` · ${state.frames.length} fotogramas` : '');
      $('#stPath').textContent = path;
      // sincroniza tamaños de IA con la imagen
      const clampSz = (v, mn, mx) => Math.min(mx, Math.max(mn, v));
      setActiveInTree(path);
      fitToView();
      extractPalette();
      renderContextBar(ctx);
      persistState();
      if (state.frames.length > 1) toast(`Textura animada: ${state.frames.length} fotogramas. Línea de tiempo abajo (▶ para previsualizar).`, 'ok', 5000);
    };
    img.src = url;
  } catch (err) {
    toast('No se pudo abrir: ' + err.message, 'err');
  }
}

// Muestra la barra de contexto/formato (dimensiones, .mcmeta, fuentes) con el contexto ya obtenido.
function renderContextBar(c) {
  const bar = $('#ctxBar');
  try {
    if (!c) { bar.style.display = 'none'; return; }
    state.context = c;
    let kind = 'info', html = '';
    if (c.font) {
      html = `<span class="ctx-tag">Glifo de fuente</span> Se dibuja a <b>${c.font.height}px</b> de alto (ascent ${c.font.ascent}) vía <b>${c.font.font.split('/').pop()}</b>. Conserva la proporción <b>${c.width}×${c.height}</b> o se deforma en el juego.`;
    } else if (c.mcmeta && c.mcmeta.animation) {
      const nf = state.frames.length > 1 ? `${state.frames.length} fotogramas · ` : '';
      html = `<span class="ctx-tag">Animada</span> ${nf}cada fotograma ${c.width}×${c.width}. Edítalos en la línea de tiempo (abajo) y Guardar reescribe la tira + .mcmeta.`;
    } else {
      html = `<span class="ctx-tag">Textura</span> ${c.width}×${c.height}${c.pow2 ? ' · potencia de 2 ✓' : ' · ⚠ no es potencia de 2'}`;
    }
    if (c.twin) {
      const twinShort = c.twin.path.split('/textures/').pop();
      html += ` &nbsp; <span class="ctx-note">ℹ También existe <code>${twinShort}</code> (mismo nombre, referenciada por una fuente del pack). Pueden usarse en lugares distintos — el editor no sabe qué hace tu servidor. <a id="ctxOpenTwin">ver la otra →</a></span>`;
    }
    bar.className = 'ctx-bar ' + kind;
    bar.innerHTML = html;
    bar.style.display = 'block';
    const tl = document.getElementById('ctxOpenTwin');
    if (tl) tl.addEventListener('click', (e) => { e.preventDefault(); openFile(c.twin.path); });
  } catch {
    bar.style.display = 'none';
  }
}
// Envoltura: obtiene el contexto, fija srcMeta y pinta la barra (para restoreState).
async function loadContext(path) {
  let c = null;
  try { c = await api('/api/context?path=' + encodeURIComponent(path)); } catch {}
  state.srcMeta = (c && c.mcmeta) ? c.mcmeta : null;
  renderContextBar(c);
}

// ---------- Persistencia del espacio de trabajo (sobrevive a recargas) ----------
let _persistT = null;
// Clave de workspace POR PROYECTO: pe_state:<packRoot>. Así cada pack recuerda su trabajo.
function _stateKey() {
  const root = ($('#packPath') ? $('#packPath').textContent : '').trim();
  return root && root !== '—' ? 'pe_state:' + root : 'pe_state';
}
function persistState() {
  try {
    const key = _stateKey();
    if (!state.current || !state.current.path) { localStorage.removeItem(key); return; }
    if (state.dirty) recomposite();
    const s = { path: state.current.path, dirty: state.dirty, data: state.dirty ? state.composite.toDataURL('image/png') : null };
    localStorage.setItem(key, JSON.stringify(s));
  } catch {}
}
function schedulePersist() { clearTimeout(_persistT); _persistT = setTimeout(persistState, 700); }
async function restoreState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(_stateKey()) || localStorage.getItem('pe_state') || 'null'); } catch {}
  if (!s || !s.path) return;
  // crítica B4: solo restaurar si el archivo pertenece a ESTE pack (no pisar con trabajo de otro)
  const inPack = state.files.some((f) => f.path === s.path);
  if (!inPack) return;
  if (s.dirty && s.data) {
    const img = new Image();
    img.onload = () => {
      initLayers(img.naturalWidth, img.naturalHeight, (ctx) => ctx.drawImage(img, 0, 0));
      state.current = { path: s.path, w: img.naturalWidth, h: img.naturalHeight };
      state.undo = []; state.redo = [];
      $('#noFile').classList.add('hidden');
      $('#stSize').textContent = `${img.naturalWidth}×${img.naturalHeight}px`;
      $('#stPath').textContent = s.path + ' · sin guardar';
      markDirty(true);
      setActiveInTree(s.path); fitToView(); extractPalette(); loadContext(s.path);
      toast('Restauré tu trabajo sin guardar de la sesión anterior. Recuerda Guardar.', 'ok', 5000);
    };
    img.src = s.data;
  } else {
    openFile(s.path);
  }
}

// Aplana el documento para guardar. Para animación (≥2 fotogramas) apila los
// fotogramas en vertical (formato de textura animada de Minecraft) y genera su .mcmeta.
function flattenForSave() {
  const w = state.composite.width, h = state.composite.height;
  if (state.frames.length <= 1) {
    recomposite();
    // si el archivo era animado y ahora tiene 1 solo fotograma, borra el .mcmeta (null)
    const meta = state.srcMeta && state.srcMeta.animation ? null : undefined;
    return { dataUrl: state.composite.toDataURL('image/png'), mcmeta: meta, frames: 1, square: true };
  }
  const n = state.frames.length;
  const strip = document.createElement('canvas');
  strip.width = w; strip.height = h * n;
  const sc = strip.getContext('2d'); sc.imageSmoothingEnabled = false;
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d');
  state.frames.forEach((fr, i) => { compositeFrameTo(fr, tctx, w, h); sc.drawImage(tmp, 0, i * h); });
  const frametime = Math.max(1, Math.round(20 / state.fps)); // ticks (20 ticks = 1 s)
  const anim = { frametime };
  if (state.srcMeta && state.srcMeta.animation && state.srcMeta.animation.interpolate) anim.interpolate = true;
  return { dataUrl: strip.toDataURL('image/png'), mcmeta: { animation: anim }, frames: n, square: w === h };
}

async function saveCurrent() {
  if (!state.current) { toast('No hay imagen abierta', 'err'); return; }
  if (state.floating) dropFloating(); // consolida la selección flotante antes de guardar
  stopPlay();
  let isNew = false;
  if (!state.current.path) {
    const p = prompt('Ruta dentro del pack donde guardar (ej. assets/minecraft/textures/item/nuevo.png):', '');
    if (!p) return;
    state.current.path = p.trim().replace(/^[/\\]+/, '');
    isNew = true;
  } else if (!state.dirty) {
    return; // nada que guardar
  }
  const flat = flattenForSave();
  if (flat.frames > 1 && !flat.square) {
    if (!confirm(`Tienes ${flat.frames} fotogramas pero la textura no es cuadrada (${state.composite.width}×${state.composite.height}). Minecraft asume fotogramas cuadrados; podría verse mal. ¿Guardar de todos modos?`)) return;
  }
  try {
    await api('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.current.path, dataUrl: flat.dataUrl, mcmeta: flat.mcmeta }),
    });
    if (flat.mcmeta) state.srcMeta = flat.mcmeta; // refleja lo recién guardado
    else if (flat.mcmeta === null) state.srcMeta = null;
    markDirty(false);
    if (isNew) {
      // recarga el árbol para que aparezca el archivo nuevo
      const tree = await api('/api/tree');
      state.files = tree.files; $('#treeStats').textContent = `${tree.count} imágenes`;
      renderTree(); setActiveInTree(state.current.path);
      $('#stPath').textContent = state.current.path;
    } else {
      const thumb = $(`.tree-file[data-path="${CSS.escape(state.current.path)}"] .tree-thumb`);
      if (thumb) thumb.src = '/api/file?path=' + encodeURIComponent(state.current.path) + '&t=' + Date.now();
    }
    toast('Guardado en: ' + state.current.path + ' ✓', 'ok', 3500);
  } catch (err) {
    toast('Error al guardar: ' + err.message, 'err');
  }
}

// ===================================================================
//  RENDER DEL LIENZO
// ===================================================================
function resizeView() {
  const wrap = $('#canvasWrap');
  state.view.width = wrap.clientWidth;
  state.view.height = wrap.clientHeight;
  render();
}
function fitToView() {
  const wrap = $('#canvasWrap');
  const margin = 40;
  const z = Math.max(1, Math.floor(Math.min(
    (wrap.clientWidth - margin) / state.doc.width,
    (wrap.clientHeight - margin) / state.doc.height
  )));
  state.zoom = Math.max(1, z);
  state.offsetX = Math.round((state.view.width - state.doc.width * state.zoom) / 2);
  state.offsetY = Math.round((state.view.height - state.doc.height * state.zoom) / 2);
  render();
}
function render() {
  const { vctx, view, doc, zoom, offsetX, offsetY } = state;
  if (!state.current) { vctx.clearRect(0, 0, view.width, view.height); return; }
  recomposite(); // mezcla las capas visibles antes de pintar
  const comp = state.composite;
  vctx.imageSmoothingEnabled = false;
  vctx.clearRect(0, 0, view.width, view.height);
  const w = doc.width * zoom, h = doc.height * zoom;

  // Papel cebolla: fantasma del fotograma anterior (no durante la reproducción)
  if (state.onion && !state.playing && state.activeFrame > 0) {
    const prev = state.frames[state.activeFrame - 1];
    const o = onionCanvas; o.width = doc.width; o.height = doc.height;
    compositeFrameTo(prev, o.getContext('2d'), doc.width, doc.height);
    vctx.globalAlpha = 0.32;
    vctx.drawImage(o, 0, 0, doc.width, doc.height, offsetX, offsetY, w, h);
    vctx.globalAlpha = 1;
  }

  vctx.drawImage(comp, 0, 0, doc.width, doc.height, offsetX, offsetY, w, h);

  // máscara (modo inpaint)
  if (state.maskMode) {
    vctx.globalAlpha = 0.55;
    vctx.drawImage(state.mask, 0, 0, doc.width, doc.height, offsetX, offsetY, w, h);
    vctx.globalAlpha = 1;
  }

  // preview de línea/rectángulo
  if (state.preview) {
    const pts = previewPoints(state.preview);
    vctx.fillStyle = rgbaStr(state.drawColor || state.color);
    for (const [px, py] of pts) vctx.fillRect(offsetX + px * zoom, offsetY + py * zoom, zoom, zoom);
  }

  // guía del degradado (línea con endpoints FG→BG)
  if (state.gradient) {
    const g = state.gradient;
    const ax = offsetX + (g.x0 + 0.5) * zoom, ay = offsetY + (g.y0 + 0.5) * zoom;
    const bx = offsetX + (g.x1 + 0.5) * zoom, by = offsetY + (g.y1 + 0.5) * zoom;
    vctx.save();
    vctx.lineWidth = 1;
    vctx.strokeStyle = 'rgba(0,0,0,.85)'; vctx.beginPath(); vctx.moveTo(ax, ay); vctx.lineTo(bx, by); vctx.stroke();
    vctx.setLineDash([4, 3]); vctx.strokeStyle = 'rgba(255,255,255,.95)'; vctx.beginPath(); vctx.moveTo(ax, ay); vctx.lineTo(bx, by); vctx.stroke();
    vctx.setLineDash([]);
    const dot = (cx, cy, col) => { vctx.fillStyle = col; vctx.strokeStyle = '#000'; vctx.beginPath(); vctx.arc(cx, cy, 4, 0, Math.PI * 2); vctx.fill(); vctx.stroke(); };
    dot(ax, ay, rgbaStr(state.color)); dot(bx, by, rgbaStr(state.color2));
    vctx.restore();
  }

  // cuadrícula
  if (state.showGrid && zoom >= 8) {
    vctx.strokeStyle = 'rgba(255,255,255,0.12)';
    vctx.lineWidth = 1;
    vctx.beginPath();
    for (let x = 0; x <= doc.width; x++) { vctx.moveTo(offsetX + x * zoom + .5, offsetY); vctx.lineTo(offsetX + x * zoom + .5, offsetY + h); }
    for (let y = 0; y <= doc.height; y++) { vctx.moveTo(offsetX, offsetY + y * zoom + .5); vctx.lineTo(offsetX + w, offsetY + y * zoom + .5); }
    vctx.stroke();
  }
  // borde del documento
  vctx.strokeStyle = 'rgba(120,140,255,.5)';
  vctx.strokeRect(offsetX - .5, offsetY - .5, w + 1, h + 1);

  // contenido flotante (selección levantada / movida)
  if (state.floating) {
    const f = state.floating;
    vctx.drawImage(f.canvas, 0, 0, f.w, f.h, offsetX + f.x * zoom, offsetY + f.y * zoom, f.w * zoom, f.h * zoom);
  }
  // lazo en curso (polígono que se está trazando)
  if (state.lasso && state.lasso.length) {
    vctx.save(); vctx.lineWidth = 1;
    vctx.beginPath();
    vctx.moveTo(offsetX + (state.lasso[0][0] + .5) * zoom, offsetY + (state.lasso[0][1] + .5) * zoom);
    for (let i = 1; i < state.lasso.length; i++) vctx.lineTo(offsetX + (state.lasso[i][0] + .5) * zoom, offsetY + (state.lasso[i][1] + .5) * zoom);
    vctx.strokeStyle = '#000'; vctx.stroke();
    vctx.setLineDash([4, 4]); vctx.strokeStyle = '#fff'; vctx.stroke();
    vctx.restore();
  }
  // marquesina de selección (hormigas marchando)
  if (!state.floating && state.selMask && state.sel) {
    drawMaskOutline(offsetX, offsetY, zoom); // contorno de la forma arbitraria (lazo/varita)
  } else {
    const selBox = state.floating || state.sel;
    if (selBox && selBox.w > 0 && selBox.h > 0) {
      const bx = offsetX + selBox.x * zoom + .5, by = offsetY + selBox.y * zoom + .5;
      const bw = selBox.w * zoom - 1, bh = selBox.h * zoom - 1;
      vctx.save();
      vctx.lineWidth = 1;
      vctx.strokeStyle = '#000'; vctx.strokeRect(bx, by, bw, bh);
      vctx.strokeStyle = '#fff'; vctx.setLineDash([4, 4]); vctx.strokeRect(bx, by, bw, bh);
      vctx.restore();
    }
  }
  $('#stZoom').textContent = Math.round(zoom * 100) + '%';
}

// Dibuja el contorno (hormigas marchando) de una máscara de selección arbitraria.
function drawMaskOutline(offsetX, offsetY, zoom) {
  const { vctx } = state, W = state.doc.width, H = state.doc.height, m = state.selMask, s = state.sel;
  const sel = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x];
  const seg = [];
  for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) {
    if (!m[y * W + x]) continue;
    if (!sel(x, y - 1)) seg.push([x, y, x + 1, y]);
    if (!sel(x, y + 1)) seg.push([x, y + 1, x + 1, y + 1]);
    if (!sel(x - 1, y)) seg.push([x, y, x, y + 1]);
    if (!sel(x + 1, y)) seg.push([x + 1, y, x + 1, y + 1]);
  }
  const path = () => { vctx.beginPath(); for (const [x1, y1, x2, y2] of seg) { vctx.moveTo(offsetX + x1 * zoom, offsetY + y1 * zoom); vctx.lineTo(offsetX + x2 * zoom, offsetY + y2 * zoom); } };
  vctx.save(); vctx.lineWidth = 1;
  vctx.strokeStyle = '#000'; path(); vctx.stroke();
  vctx.setLineDash([4, 4]); vctx.strokeStyle = '#fff'; path(); vctx.stroke();
  vctx.restore();
}

// ===================================================================
//  HERRAMIENTAS DE DIBUJO
// ===================================================================
function screenToPixel(clientX, clientY) {
  const rect = state.view.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left - state.offsetX) / state.zoom);
  const y = Math.floor((clientY - rect.top - state.offsetY) / state.zoom);
  return { x, y };
}
function inBounds(x, y) { return x >= 0 && y >= 0 && x < state.doc.width && y < state.doc.height; }

function snapshot() {
  const w = state.composite.width, h = state.composite.height;
  syncFrameActive();
  return {
    w, h, activeFrame: state.activeFrame,
    frames: state.frames.map((fr) => ({
      active: fr.active,
      layers: fr.layers.map((L) => ({
        id: L.id, name: L.name, visible: L.visible, opacity: L.opacity,
        data: L.ctx.getImageData(0, 0, L.canvas.width, L.canvas.height),
      })),
    })),
  };
}
function restore(s) {
  state.composite.width = s.w; state.composite.height = s.h;
  state.frames = s.frames.map((fr) => ({
    active: fr.active,
    layers: fr.layers.map((ls) => {
      const L = makeLayer(ls.name, s.w, s.h);
      L.id = ls.id; L.visible = ls.visible; L.opacity = ls.opacity;
      L.ctx.putImageData(ls.data, 0, 0);
      return L;
    }),
  }));
  state.activeFrame = Math.min(s.activeFrame, state.frames.length - 1);
  state.layers = curFrame().layers;
  state.activeLayer = Math.min(curFrame().active, state.layers.length - 1);
  pointDocToActive();
  state.mask.width = s.w; state.mask.height = s.h; clearMask();
  $('#stSize').textContent = `${s.w}×${s.h}px`;
  renderLayersPanel(); renderFrames();
}
function pushUndo() {
  if (!state.current) return;
  state.undo.push(snapshot());
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
  markDirty(true); render();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
  markDirty(true); render();
}

function stampSquare(cx, cy, ctx, erase) {
  const b = state.brush;
  const ox = cx - Math.floor((b - 1) / 2);
  const oy = cy - Math.floor((b - 1) / 2);
  // Si hay selección activa, recorta: pinta solo los píxeles dentro de la forma.
  if (selActive() && ctx === state.dctx) {
    const col = rgbaStr(state.drawColor || state.color);
    for (let yy = 0; yy < b; yy++) for (let xx = 0; xx < b; xx++) {
      const px = ox + xx, py = oy + yy;
      if (!inSelection(px, py)) continue;
      ctx.clearRect(px, py, 1, 1);
      if (!erase) { ctx.fillStyle = col; ctx.fillRect(px, py, 1, 1); }
    }
    return;
  }
  ctx.clearRect(ox, oy, b, b);
  if (!erase) { ctx.fillStyle = rgbaStr(state.drawColor || state.color); ctx.fillRect(ox, oy, b, b); }
}
function paintPixel(x, y, ctx, erase) {
  stampSquare(x, y, ctx, erase);
  if (state.symmetry !== 'none' && state.current) {
    const W = state.doc.width, H = state.doc.height;
    const mx = state.symmetry === 'x' || state.symmetry === 'xy';
    const my = state.symmetry === 'y' || state.symmetry === 'xy';
    if (mx) stampSquare(W - 1 - x, y, ctx, erase);
    if (my) stampSquare(x, H - 1 - y, ctx, erase);
    if (mx && my) stampSquare(W - 1 - x, H - 1 - y, ctx, erase);
  }
}
// Pintado del trazo con pixel-perfect: si tres píxeles forman un "codo", se revierte el del medio.
function ppAdd(x, y, erase) {
  if (!inBounds(x, y)) return;
  const s = state.stroke;
  const lastP = s && s.pts[s.pts.length - 1];
  if (lastP && lastP[0] === x && lastP[1] === y) return;
  const usePP = state.pixelPerfect && state.brush === 1 && state.symmetry === 'none' && state.tool === 'pencil';
  if (usePP && s) {
    const k = y * state.doc.width + x;
    if (!s.orig.has(k)) s.orig.set(k, state.dctx.getImageData(x, y, 1, 1));
  }
  paintPixel(x, y, state.dctx, erase);
  if (!s) return;
  s.pts.push([x, y]);
  if (usePP && s.pts.length >= 3) {
    const a = s.pts[s.pts.length - 3], b = s.pts[s.pts.length - 2], c = s.pts[s.pts.length - 1];
    const elbow = Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1 &&
      (b[0] === a[0] || b[0] === c[0]) && (b[1] === a[1] || b[1] === c[1]) &&
      !(b[0] === a[0] && b[1] === a[1]) && !(b[0] === c[0] && b[1] === c[1]);
    if (elbow) {
      const od = s.orig.get(b[1] * state.doc.width + b[0]);
      if (od) state.dctx.putImageData(od, b[0], b[1]);
      s.pts.splice(s.pts.length - 2, 1);
    }
  }
}
function paintMask(x, y) {
  const b = state.maskBrush;
  const ox = x - Math.floor((b - 1) / 2);
  const oy = y - Math.floor((b - 1) / 2);
  state.mctx.fillStyle = 'rgba(255,40,60,1)';
  state.mctx.fillRect(ox, oy, b, b);
}

// Bresenham entre dos puntos (para trazos continuos)
function linePoints(x0, y0, x1, y1) {
  const pts = [];
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return pts;
}
function rectPoints(x0, y0, x1, y1, fill) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const pts = [];
  if (fill) { for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) pts.push([x, y]); return pts; }
  for (let x = ax; x <= bx; x++) { pts.push([x, ay]); pts.push([x, by]); }
  for (let y = ay; y <= by; y++) { pts.push([ax, y]); pts.push([bx, y]); }
  return pts;
}
function ellipsePoints(x0, y0, x1, y1, fill) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  const cx = (ax + bx) / 2, cy = (ay + by) / 2;
  const rx = Math.max(0.5, (bx - ax) / 2), ry = Math.max(0.5, (by - ay) / 2);
  const pts = [], seen = new Set();
  const add = (x, y) => { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); pts.push([x, y]); } };
  if (fill) {
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      const nx = (x - cx) / rx, ny = (y - cy) / ry; if (nx * nx + ny * ny <= 1.08) add(x, y);
    }
    return pts;
  }
  const steps = Math.max(24, Math.round((rx + ry) * 5));
  for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; add(Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))); }
  return pts;
}
function constrainLine(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx > 2 * ady) return [x1, y0];
  if (ady > 2 * adx) return [x0, y1];
  const d = Math.max(adx, ady);
  return [x0 + Math.sign(dx) * d, y0 + Math.sign(dy) * d];
}
function previewPoints(pv) {
  if (pv.tool === 'line') return linePoints(pv.x0, pv.y0, pv.x1, pv.y1);
  if (pv.tool === 'ellipse') return ellipsePoints(pv.x0, pv.y0, pv.x1, pv.y1, state.fillShape);
  return rectPoints(pv.x0, pv.y0, pv.x1, pv.y1, state.fillShape);
}

function floodFill(sx, sy) {
  const { doc, dctx } = state;
  if (selActive() && !inSelection(sx, sy)) return; // clic fuera de la selección: nada
  const img = dctx.getImageData(0, 0, doc.width, doc.height);
  const d = img.data, W = doc.width, H = doc.height;
  const idx = (x, y) => (y * W + x) * 4;
  const si = idx(sx, sy);
  const target = [d[si], d[si + 1], d[si + 2], d[si + 3]];
  const c1 = state.drawColor || state.color, c2 = state.color2;
  const dith = state.dither;
  const sameAs = (c) => c.r === target[0] && c.g === target[1] && c.b === target[2] && c.a === target[3];
  if (!dith && sameAs(c1)) return; // relleno sólido del mismo color: nada que hacer
  const match = (i) => d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3];
  const visited = new Uint8Array(W * H); // evita reprocesar (clave con tramado: el color puede coincidir con el destino)
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const vi = y * W + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    if (selActive() && !inSelection(x, y)) continue; // no rellenar fuera de la selección
    const i = idx(x, y);
    if (!match(i)) continue;
    const c = dith && ((x + y) & 1) ? c2 : c1; // damero FG/BG
    d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = c.a;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  dctx.putImageData(img, 0, 0);
}

// Matriz de Bayer 4×4 (tramado ordenado) — valores 0..15.
const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
// Degradado lineal del color primario (inicio) al secundario (fin), a lo largo del arrastre.
// Rellena la selección si existe, si no todo el lienzo. Suave, o tramado si state.dither.
function applyGradient(g) {
  const { doc, dctx } = state;
  const W = doc.width, H = doc.height;
  let rx = 0, ry = 0, rw = W, rh = H;
  if (state.sel && state.sel.w > 0 && state.sel.h > 0) { rx = state.sel.x; ry = state.sel.y; rw = state.sel.w; rh = state.sel.h; }
  const dx = g.x1 - g.x0, dy = g.y1 - g.y0, len2 = dx * dx + dy * dy;
  const c1 = state.color, c2 = state.color2;
  const img = dctx.getImageData(rx, ry, rw, rh), d = img.data;
  const masked = !!state.selMask;
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
    const px = rx + xx, py = ry + yy;
    if (masked && !inSelection(px, py)) continue; // respeta la forma del lazo/varita
    let t = len2 ? ((px - g.x0) * dx + (py - g.y0) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const i = (yy * rw + xx) * 4;
    if (state.dither) {
      const thr = (BAYER4[py & 3][px & 3] + 0.5) / 16;
      const c = t > thr ? c2 : c1;
      d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = c.a;
    } else {
      d[i] = Math.round(c1.r + (c2.r - c1.r) * t);
      d[i + 1] = Math.round(c1.g + (c2.g - c1.g) * t);
      d[i + 2] = Math.round(c1.b + (c2.b - c1.b) * t);
      d[i + 3] = Math.round(c1.a + (c2.a - c1.a) * t);
    }
  }
  dctx.putImageData(img, rx, ry);
}

function pickColor(x, y) {
  recomposite();
  const p = state.cctx.getImageData(x, y, 1, 1).data;
  state.color = { r: p[0], g: p[1], b: p[2], a: p[3] };
  $('#colorPicker').value = rgbToHex(p[0], p[1], p[2]);
  $('#alpha').value = p[3];
  updateSwatch();
}

// ---------- Selección (rectangular, lazo y varita mágica) ----------
// ¿Hay una selección activa que limita el dibujo? (no mientras se mueve algo flotante)
function selActive() { return !state.floating && state.sel && state.sel.w > 0 && state.sel.h > 0; }
// ¿El píxel (x,y) está dentro de la forma de la selección? (máscara si la hay, si no la caja)
function inSelection(x, y) {
  if (!state.sel || state.sel.w <= 0 || state.sel.h <= 0) return false;
  if (state.selMask) { return x >= 0 && y >= 0 && x < state.doc.width && y < state.doc.height && !!state.selMask[y * state.doc.width + x]; }
  const s = state.sel; return x >= s.x && y >= s.y && x < s.x + s.w && y < s.y + s.h;
}
// Lienzo (tamaño bbox) opaco donde la máscara está seleccionada — para recortar con composición.
function maskCanvasOf() {
  const s = state.sel, W = state.doc.width;
  const c = document.createElement('canvas'); c.width = s.w; c.height = s.h;
  if (!state.selMask) { const cc = c.getContext('2d'); cc.fillStyle = '#fff'; cc.fillRect(0, 0, s.w, s.h); return c; }
  const cc = c.getContext('2d'); const img = cc.createImageData(s.w, s.h), d = img.data;
  for (let yy = 0; yy < s.h; yy++) for (let xx = 0; xx < s.w; xx++) {
    if (state.selMask[(s.y + yy) * W + (s.x + xx)]) { const i = (yy * s.w + xx) * 4; d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 255; }
  }
  cc.putImageData(img, 0, 0); return c;
}
// Recalcula la caja contenedora (bbox) a partir de la máscara; devuelve null si está vacía.
function bboxOfMask(mask, W, H) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function selContains(x, y) {
  if (state.floating) { const f = state.floating; return x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h; }
  return inSelection(x, y);
}
function liftSelection() {
  if (!state.sel || state.sel.w < 1 || state.sel.h < 1) return;
  pushUndo();
  const { x, y, w, h } = state.sel;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cc = c.getContext('2d');
  cc.drawImage(state.doc, x, y, w, h, 0, 0, w, h);
  if (state.selMask) { // conserva solo los píxeles de la forma del lazo/varita
    cc.globalCompositeOperation = 'destination-in';
    cc.drawImage(maskCanvasOf(), 0, 0);
    cc.globalCompositeOperation = 'source-over';
  }
  clearSelectionPixels(); // borra del lienzo los píxeles levantados
  state.floating = { canvas: c, x, y, w, h };
  markDirty(true);
}
// Borra del lienzo los píxeles dentro de la selección (respeta la máscara).
function clearSelectionPixels() {
  const s = state.sel;
  if (!state.selMask) { state.dctx.clearRect(s.x, s.y, s.w, s.h); return; }
  state.dctx.save();
  state.dctx.globalCompositeOperation = 'destination-out';
  state.dctx.drawImage(maskCanvasOf(), s.x, s.y);
  state.dctx.restore();
}
function dropFloating() {
  if (!state.floating) return;
  const f = state.floating;
  state.dctx.drawImage(f.canvas, f.x, f.y);
  state.sel = { x: f.x, y: f.y, w: f.w, h: f.h };
  state.selMask = null; // al soltar, la selección pasa a ser la caja del contenido
  state.floating = null;
  markDirty(true);
}
function deleteSelection() {
  if (state.floating) { state.floating = null; markDirty(true); render(); return; }
  if (!state.sel || state.sel.w < 1) return;
  pushUndo();
  clearSelectionPixels();
  markDirty(true); render();
}
function duplicateSelection() {
  if (state.floating) dropFloating();
  if (!state.sel || state.sel.w < 1) return;
  pushUndo();
  const s = state.sel;
  const c = document.createElement('canvas'); c.width = s.w; c.height = s.h;
  const cc = c.getContext('2d');
  cc.drawImage(state.doc, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
  if (state.selMask) { cc.globalCompositeOperation = 'destination-in'; cc.drawImage(maskCanvasOf(), 0, 0); }
  state.floating = { canvas: c, x: s.x + 4, y: s.y + 4, w: s.w, h: s.h };
  markDirty(true); render();
}
function clearSelection() { dropFloating(); state.sel = null; state.selMask = null; state.selStart = null; state.selMove = null; state.lasso = null; render(); updateInpaintSelUI(); }

// Fija una máscara como selección (recalcula la caja; la limpia si queda vacía).
function setSelectionMask(mask) {
  const bb = bboxOfMask(mask, state.doc.width, state.doc.height);
  if (!bb) { state.sel = null; state.selMask = null; render(); updateInpaintSelUI(); return; }
  state.sel = bb; state.selMask = mask; render(); updateInpaintSelUI();
}
// Varita mágica: selecciona la zona contigua del mismo color (en lo que se ve). add=true suma a la actual.
function magicWand(sx, sy, add) {
  recomposite();
  const W = state.doc.width, H = state.doc.height;
  const d = state.cctx.getImageData(0, 0, W, H).data;
  const idx = (x, y) => (y * W + x) * 4;
  const si = idx(sx, sy);
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  const mask = (add && state.selMask) ? state.selMask : new Uint8Array(W * H);
  const visited = new Uint8Array(W * H);
  const match = (i) => d[i] === tr && d[i + 1] === tg && d[i + 2] === tb && d[i + 3] === ta;
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const vi = y * W + x;
    if (visited[vi]) continue; visited[vi] = 1;
    if (!match(idx(x, y))) continue;
    mask[vi] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  setSelectionMask(mask);
}
// Lazo: rasteriza el polígono de puntos a una máscara de selección.
function commitLasso() {
  const pts = state.lasso; state.lasso = null;
  if (!pts || pts.length < 3) { render(); return; }
  const W = state.doc.width, H = state.doc.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.fillStyle = '#fff'; cc.beginPath();
  cc.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
  for (let i = 1; i < pts.length; i++) cc.lineTo(pts[i][0] + 0.5, pts[i][1] + 0.5);
  cc.closePath(); cc.fill();
  const d = cc.getImageData(0, 0, W, H).data;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (d[i * 4 + 3] >= 128) mask[i] = 1; // dentro del polígono
  setSelectionMask(mask);
}

// ---------- Reemplazar color (clic en el color a cambiar -> color actual) ----------
function replaceColor(x, y) {
  const { doc, dctx } = state;
  const img = dctx.getImageData(0, 0, doc.width, doc.height);
  const d = img.data;
  const si = (y * doc.width + x) * 4;
  const t = [d[si], d[si + 1], d[si + 2], d[si + 3]];
  const r = [state.color.r, state.color.g, state.color.b, state.color.a];
  if (t.every((v, i) => v === r[i])) return;
  pushUndo();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === t[0] && d[i + 1] === t[1] && d[i + 2] === t[2] && d[i + 3] === t[3]) { d[i] = r[0]; d[i + 1] = r[1]; d[i + 2] = r[2]; d[i + 3] = r[3]; }
  }
  dctx.putImageData(img, 0, 0);
  markDirty(true); render();
}

// ---------- Eventos del lienzo ----------
const view = state.view;
let panStart = null;
// Punteros activos (ratón / dedos / lápiz) para soportar gestos multitáctil.
const pointers = new Map();
let pinch = null; // { d, cx, cy } estado inicial del gesto de dos dedos

// Aplica un factor de zoom centrado en un punto de pantalla (reutilizado por rueda y pinch).
function zoomAt(screenX, screenY, factor) {
  const rect = view.getBoundingClientRect();
  const cx = screenX - rect.left, cy = screenY - rect.top;
  const px = (cx - state.offsetX) / state.zoom;
  const py = (cy - state.offsetY) / state.zoom;
  state.zoom = Math.min(64, Math.max(1, state.zoom * factor));
  state.offsetX = cx - px * state.zoom;
  state.offsetY = cy - py * state.zoom;
}

view.addEventListener('pointerdown', (e) => {
  if (!state.current) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Dos dedos: entrar en gesto pinch (zoom + desplazamiento). Cancela cualquier trazo recién iniciado.
  if (pointers.size === 2) {
    if (state.drawing && state.stroke) undo(); // deshace el punto suelto que dejó el primer dedo
    state.drawing = false; state.last = null; state.stroke = null; state.preview = null; panStart = null;
    const p = [...pointers.values()];
    pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2 };
    return;
  }
  if (pointers.size > 2) return;

  view.setPointerCapture(e.pointerId);
  const { x, y } = screenToPixel(e.clientX, e.clientY);

  if (state.tool === 'pan' || e.button === 1 || e.spaceHeld) {
    panStart = { mx: e.clientX, my: e.clientY, ox: state.offsetX, oy: state.offsetY };
    return;
  }
  if (state.maskMode) { state.drawing = true; paintMask(x, y); state.last = { x, y }; render(); return; }
  if (!inBounds(x, y)) return;
  if (e.altKey) { pickColor(x, y); return; } // cuentagotas rápido con Alt
  // color del trazo según el botón: izquierdo = primario (FG), derecho = secundario (BG)
  state.drawColor = (e.button === 2) ? state.color2 : state.color;

  if (state.tool === 'picker') { pickColor(x, y); return; }
  if (state.tool === 'replace') { replaceColor(x, y); return; }
  if (state.tool === 'gradient') {
    pushUndo();
    state.gradient = { x0: x, y0: y, x1: x, y1: y };
    state.drawing = true; render(); return;
  }
  if (state.tool === 'wand') {
    dropFloating();
    magicWand(x, y, e.shiftKey); // Shift suma a la selección actual
    return;
  }
  if (state.tool === 'lasso') {
    if (selContains(x, y) && (state.floating || state.selMask || state.sel)) {
      if (!state.floating) liftSelection();
      state.selMove = { px: x, py: y, fx: state.floating.x, fy: state.floating.y };
      state.drawing = true; render(); return;
    }
    dropFloating();
    state.sel = null; state.selMask = null;
    state.lasso = [[x, y]];
    state.drawing = true; render(); return;
  }
  if (state.tool === 'select') {
    if (selContains(x, y)) {
      if (!state.floating) liftSelection();
      state.selMove = { px: x, py: y, fx: state.floating.x, fy: state.floating.y };
    } else {
      dropFloating();
      state.selMask = null; // nueva selección rectangular
      state.selStart = { x, y };
      state.sel = { x, y, w: 0, h: 0 };
    }
    state.drawing = true; render(); return;
  }
  if (state.tool === 'fill') { pushUndo(); floodFill(x, y); markDirty(true); render(); return; }
  if (state.tool === 'line' || state.tool === 'rect' || state.tool === 'ellipse') {
    pushUndo();
    state.preview = { tool: state.tool, x0: x, y0: y, x1: x, y1: y };
    state.drawing = true;
    render();
    return;
  }
  // lápiz / borrador
  pushUndo();
  state.drawing = true;
  state.last = { x, y };
  state.stroke = { pts: [], orig: new Map() };
  ppAdd(x, y, state.tool === 'eraser');
  markDirty(true);
  render();
});

view.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // Gesto de dos dedos: zoom por separación + desplazamiento por el punto medio.
  if (pinch && pointers.size >= 2) {
    const p = [...pointers.values()];
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    const cx = (p[0].x + p[1].x) / 2, cy = (p[0].y + p[1].y) / 2;
    if (pinch.d > 0) zoomAt(cx, cy, d / pinch.d);
    state.offsetX += cx - pinch.cx;
    state.offsetY += cy - pinch.cy;
    pinch = { d, cx, cy };
    render();
    return;
  }

  const { x, y } = screenToPixel(e.clientX, e.clientY);
  $('#stCoord').textContent = inBounds(x, y) ? `${x}, ${y}` : '—';

  if (panStart) {
    state.offsetX = panStart.ox + (e.clientX - panStart.mx);
    state.offsetY = panStart.oy + (e.clientY - panStart.my);
    render();
    return;
  }
  if ((state.tool === 'select' || state.tool === 'lasso' || state.tool === 'wand') && !state.drawing)
    view.style.cursor = selContains(x, y) ? 'move' : 'crosshair';
  if (!state.drawing) return;

  if (state.maskMode) {
    for (const [px, py] of linePoints(state.last.x, state.last.y, x, y)) paintMask(px, py);
    state.last = { x, y }; render(); return;
  }
  if (state.tool === 'lasso') {
    if (state.selMove && state.floating) {
      state.floating.x = state.selMove.fx + (x - state.selMove.px);
      state.floating.y = state.selMove.fy + (y - state.selMove.py);
    } else if (state.lasso) {
      const last = state.lasso[state.lasso.length - 1];
      if (!last || last[0] !== x || last[1] !== y) state.lasso.push([x, y]);
    }
    render(); return;
  }
  if (state.tool === 'select') {
    if (state.selMove && state.floating) {
      state.floating.x = state.selMove.fx + (x - state.selMove.px);
      state.floating.y = state.selMove.fy + (y - state.selMove.py);
    } else if (state.selStart) {
      const X = Math.max(0, Math.min(state.doc.width, x)), Y = Math.max(0, Math.min(state.doc.height, y));
      const sx = Math.min(state.selStart.x, X), sy = Math.min(state.selStart.y, Y);
      state.sel = { x: sx, y: sy, w: Math.max(state.selStart.x, X) - sx, h: Math.max(state.selStart.y, Y) - sy };
    }
    render(); return;
  }
  if (state.tool === 'gradient' && state.gradient) {
    let nx = x, ny = y;
    if (e.shiftKey) [nx, ny] = constrainLine(state.gradient.x0, state.gradient.y0, x, y); // Shift = recto
    state.gradient.x1 = nx; state.gradient.y1 = ny; render(); return;
  }
  if (state.tool === 'line' || state.tool === 'rect' || state.tool === 'ellipse') {
    let nx = x, ny = y;
    if (state.tool === 'line' && e.shiftKey) [nx, ny] = constrainLine(state.preview.x0, state.preview.y0, x, y);
    state.preview.x1 = nx; state.preview.y1 = ny; render(); return;
  }
  if (state.tool === 'pencil' || state.tool === 'eraser') {
    for (const [px, py] of linePoints(state.last.x, state.last.y, x, y)) ppAdd(px, py, state.tool === 'eraser');
    state.last = { x, y };
    render();
  }
});

function endStroke() {
  if (state.preview) {
    for (const [px, py] of previewPoints(state.preview)) {
      if (inBounds(px, py)) paintPixel(px, py, state.dctx, false);
    }
    state.preview = null;
    markDirty(true);
  }
  if (state.gradient) {
    applyGradient(state.gradient);
    state.gradient = null;
    markDirty(true);
  }
  if (state.tool === 'select') {
    state.selStart = null; state.selMove = null;
    if (!state.floating && state.sel && (state.sel.w < 1 || state.sel.h < 1)) state.sel = null;
  }
  if (state.tool === 'lasso') {
    state.selMove = null;
    if (state.lasso) commitLasso(); // cierra el polígono → máscara
  }
  state.drawing = false;
  state.last = null;
  state.stroke = null;
  panStart = null;
  render();
  updateInpaintSelUI(); // refleja si quedó una selección para "rediseñar zona"
}
function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;       // se sale del gesto al levantar un dedo
  if (pointers.size === 0) endStroke();      // solo finaliza el trazo cuando no queda ningún puntero
}
view.addEventListener('contextmenu', (e) => e.preventDefault()); // el clic derecho dibuja con el color secundario
view.addEventListener('pointerup', onPointerUp);
view.addEventListener('pointercancel', onPointerUp);

// Zoom con rueda (centrado en el cursor)
view.addEventListener('wheel', (e) => {
  if (!state.current) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.2 : 1 / 1.2);
  render();
}, { passive: false });

// ===================================================================
//  COLOR Y PALETA
// ===================================================================
const CHECKER = 'repeating-conic-gradient(#777 0% 25%, #bbb 0% 50%)';
function colorLayer(col) {
  // color sólido por encima del tablero de transparencia (el alpha deja ver el checker)
  return `linear-gradient(${col}, ${col}), ${CHECKER}`;
}
function updateSwatch() {
  const sw = $('#currentSwatch');
  sw.style.background = colorLayer(rgbaStr(state.color));
  sw.style.backgroundSize = 'auto, 10px 10px';
}
$('#colorPicker').addEventListener('input', (e) => {
  const c = hexToRgb(e.target.value);
  state.color.r = c.r; state.color.g = c.g; state.color.b = c.b;
  updateSwatch();
});
$('#colorPicker2').addEventListener('input', (e) => {
  const c = hexToRgb(e.target.value);
  state.color2 = { r: c.r, g: c.g, b: c.b, a: state.color2.a };
});
$('#alpha').addEventListener('input', (e) => { state.color.a = +e.target.value; updateSwatch(); });
// Intercambiar color primario y secundario
function swapColors() {
  const tmp = state.color; state.color = state.color2; state.color2 = tmp;
  $('#colorPicker').value = rgbToHex(state.color.r, state.color.g, state.color.b);
  $('#colorPicker2').value = rgbToHex(state.color2.r, state.color2.g, state.color2.b);
  $('#alpha').value = state.color.a;
  updateSwatch();
}
$('#btnSwapColors').addEventListener('click', swapColors);

function setPaletteColors(colors) {
  const pal = $('#palette');
  pal.innerHTML = '';
  for (const c of colors) {
    const sw = document.createElement('div');
    sw.className = 'pcolor';
    sw.style.background = colorLayer(`rgba(${c.r},${c.g},${c.b},${c.a / 255})`);
    sw.style.backgroundSize = 'auto, 8px 8px';
    sw.title = rgbToHex(c.r, c.g, c.b) + (c.a < 255 ? ` α${c.a}` : '');
    sw.addEventListener('click', () => {
      state.color = { ...c };
      $('#colorPicker').value = rgbToHex(c.r, c.g, c.b);
      $('#alpha').value = c.a;
      updateSwatch();
    });
    pal.appendChild(sw);
  }
}
function extractPalette() {
  if (!state.current) { toast('Abre una imagen primero para extraer su paleta de colores', 'err'); return; }
  recomposite();
  const c = state.composite;
  const d = state.cctx.getImageData(0, 0, c.width, c.height).data;
  const map = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const key = `${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  const top = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([k]) => { const [r, g, b, a] = k.split(',').map(Number); return { r, g, b, a }; });
  setPaletteColors(top.length ? top : DEFAULT_PALETTE);
}
const DEFAULT_PALETTE = [
  { r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }, { r: 136, g: 0, b: 21, a: 255 },
  { r: 237, g: 28, b: 36, a: 255 }, { r: 255, g: 127, b: 39, a: 255 }, { r: 255, g: 242, b: 0, a: 255 },
  { r: 34, g: 177, b: 76, a: 255 }, { r: 0, g: 162, b: 232, a: 255 }, { r: 63, g: 72, b: 204, a: 255 },
  { r: 163, g: 73, b: 164, a: 255 },
];
$('#btnExtract').addEventListener('click', extractPalette);


// ===================================================================
//  ZIP / BACKUP / CONFIG
// ===================================================================
$('#btnExport').addEventListener('click', async () => {
  const name = prompt('Nombre del ZIP (vacío = nombre automático con fecha):', '');
  if (name === null) return;
  toast('Empaquetando todo el pack…');
  try {
    const r = await api('/api/export-zip', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    toast('ZIP creado: ' + r.dest, 'ok', 6000);
  } catch (err) { toast('Error al exportar: ' + err.message, 'err', 5000); }
});
$('#btnBackup').addEventListener('click', async () => {
  toast('Creando copia de seguridad…');
  try {
    const r = await api('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast('Backup creado: ' + r.dest, 'ok', 6000);
  } catch (err) { toast('Error en backup: ' + err.message, 'err', 5000); }
});
// ===================================================================
//  PALETA DE COMANDOS (Ctrl+K) — buscar y ejecutar cualquier acción / abrir texturas
// ===================================================================
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function buildCommands() {
  const tool = (id, name) => ({ title: name, sub: 'Herramienta', kw: 'herramienta tool ' + id, run: () => setTool(id) });
  const click = (sel) => () => { const el = document.querySelector(sel); if (el) el.click(); };
  return [
    tool('pencil', 'Lápiz'), tool('eraser', 'Borrador'), tool('fill', 'Bote de relleno'),
    tool('picker', 'Cuentagotas'), tool('line', 'Línea'), tool('rect', 'Rectángulo'),
    tool('ellipse', 'Elipse'), tool('gradient', 'Degradado'), tool('select', 'Selección rectangular'),
    tool('lasso', 'Lazo'), tool('wand', 'Varita mágica'), tool('replace', 'Reemplazar color'), tool('pan', 'Mover vista'),
    { title: 'Deshacer', sub: 'Ctrl+Z', kw: 'undo deshacer', run: undo },
    { title: 'Rehacer', sub: 'Ctrl+Y', kw: 'redo rehacer', run: redo },
    { title: 'Guardar', sub: 'Ctrl+S', kw: 'save guardar', run: saveCurrent },
    { title: 'Voltear horizontal', kw: 'flip voltear espejo', run: () => flipDoc(true) },
    { title: 'Voltear vertical', kw: 'flip voltear espejo', run: () => flipDoc(false) },
    { title: 'Rotar 90°', kw: 'rotate rotar girar', run: rotateDoc },
    { title: 'Cambiar simetría', kw: 'simetria mirror espejo', run: cycleSymmetry },
    { title: 'Intercambiar colores (FG/BG)', kw: 'swap intercambiar color', run: swapColors },
    { title: 'Duplicar selección', sub: 'Ctrl+D', kw: 'duplicar seleccion', run: duplicateSelection },
    { title: 'Borrar selección', sub: 'Supr', kw: 'borrar delete seleccion', run: deleteSelection },
    { title: 'Quitar selección', kw: 'deseleccionar clear', run: clearSelection },
    { title: 'Extraer paleta de la imagen', kw: 'paleta palette color', run: extractPalette },
    { title: 'Nueva capa', kw: 'capa layer nueva', run: () => addLayer() },
    { title: 'Duplicar capa', kw: 'capa layer duplicar', run: duplicateLayer },
    { title: 'Borrar capa', kw: 'capa layer borrar', run: deleteLayer },
    { title: 'Nuevo fotograma', kw: 'frame fotograma animacion', run: () => addFrame() },
    { title: 'Duplicar fotograma', kw: 'frame fotograma animacion', run: () => addFrame({ dup: true }) },
    { title: 'Borrar fotograma', kw: 'frame fotograma animacion', run: deleteFrame },
    { title: 'Reproducir / pausar animación', kw: 'play animacion reproducir', run: togglePlay },
    { title: 'Papel cebolla (onion skin)', kw: 'onion cebolla animacion', run: click('#btnOnion') },
    { title: 'Acercar', kw: 'zoom acercar in', run: () => zoomBy(1.25) },
    { title: 'Alejar', kw: 'zoom alejar out', run: () => zoomBy(1 / 1.25) },
    { title: 'Ajustar a la vista', kw: 'fit ajustar zoom', run: fitToView },
    { title: 'Mostrar/ocultar cuadrícula', kw: 'grid cuadricula rejilla', run: click('#btnGrid') },
    { title: 'Exportar ZIP', kw: 'export zip empaquetar', run: click('#btnExport') },
    { title: 'Backup del pack', kw: 'backup copia seguridad', run: click('#btnBackup') },
    { title: 'Ver · Ocultar/mostrar texturas', sub: 'Ctrl+B', kw: 'ver panel izquierda texturas ocultar', run: () => togglePane('left') },
    { title: 'Ver · Ocultar/mostrar color', sub: 'Ctrl+J', kw: 'ver panel derecha color ocultar', run: () => togglePane('right') },
    { title: 'Ver · Ocultar/mostrar herramientas', kw: 'ver toolbar herramientas ocultar', run: () => togglePane('toolbar') },
    { title: 'Ver · Ocultar/mostrar barra de estado', kw: 'ver statusbar estado ocultar', run: () => togglePane('status') },
    { title: 'Ver · Modo enfoque', sub: 'Tab×2', kw: 'ver enfoque focus zen lienzo', run: () => toggleFocus() },
    { title: 'Ver · Restablecer vista', kw: 'ver reset restablecer paneles', run: () => resetUI() },
  ];
}
let _cmdItems = [], _cmdSel = 0;
// Puntuación de coincidencia: prefijo > substring > subsecuencia.
function scoreMatch(q, text) {
  if (!q) return 1;
  text = String(text).toLowerCase();
  const i = text.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 60 - i * 0.1;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) { const f = text.indexOf(q[qi], ti); if (f < 0) return 0; ti = f + 1; }
  return 20;
}
function filterCommands(q) {
  q = q.trim().toLowerCase();
  const scored = [];
  for (const c of buildCommands()) {
    const s = Math.max(scoreMatch(q, c.title), scoreMatch(q, c.kw || '') * 0.8);
    if (s > 0) scored.push({ ...c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  let items = scored.slice(0, 40);
  if (q.length >= 2 && state.files && state.files.length) {
    const files = state.files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 12)
      .map((f) => ({ title: f.path.split('/').pop(), sub: f.path, file: true, run: () => openFile(f.path) }));
    items = items.concat(files);
  }
  return items;
}
function renderCmd(q) {
  _cmdItems = filterCommands(q); _cmdSel = 0;
  const list = document.getElementById('cmdList');
  list.innerHTML = '';
  if (!_cmdItems.length) { list.innerHTML = '<div class="cmd-empty">Sin resultados</div>'; return; }
  _cmdItems.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'cmd-item' + (i === 0 ? ' sel' : '');
    row.innerHTML = `<span class="cmd-t">${it.file ? '📄 ' : ''}${escapeHtml(it.title)}</span>` + (it.sub ? `<span class="cmd-s">${escapeHtml(it.sub)}</span>` : '');
    row.addEventListener('click', () => runCmd(i));
    row.addEventListener('mousemove', () => setCmdSel(i));
    list.appendChild(row);
  });
}
function setCmdSel(i) {
  _cmdSel = i;
  const rows = document.querySelectorAll('#cmdList .cmd-item');
  rows.forEach((el, j) => el.classList.toggle('sel', j === i));
  if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
}
function runCmd(i) {
  const it = _cmdItems[i]; if (!it) return;
  closePalette();
  try { it.run(); } catch (err) { toast('Error: ' + err.message, 'err'); }
}
function openPalette() {
  document.getElementById('cmdPalette').classList.remove('hidden');
  const inp = document.getElementById('cmdInput');
  inp.value = ''; renderCmd(''); inp.focus();
}
function closePalette() { document.getElementById('cmdPalette').classList.add('hidden'); }
$('#cmdInput').addEventListener('input', (e) => renderCmd(e.target.value));
$('#cmdInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setCmdSel(Math.min(_cmdItems.length - 1, _cmdSel + 1)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdSel(Math.max(0, _cmdSel - 1)); }
  else if (e.key === 'Enter') { e.preventDefault(); runCmd(_cmdSel); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('#cmdPalette').addEventListener('click', (e) => { if (e.target.id === 'cmdPalette') closePalette(); });
// Ctrl/Cmd+K abre la paleta desde cualquier sitio (incluso con foco en un input)
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
}, true);

// ===================================================================
//  ATAJOS DE TECLADO
// ===================================================================
window.addEventListener('keydown', (e) => {
  if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
  // Visibilidad de paneles: Tab = ambos laterales (estilo Photoshop), Ctrl+B = izq, Ctrl+J = der
  if (e.key === 'Tab') { e.preventDefault(); const any = _ui.left || _ui.right; setPane('left', !any); setPane('right', !any); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); togglePane('left'); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'j') { e.preventDefault(); togglePane('right'); return; }
  if (e.code === 'Space') { state.spaceHeld = true; view.style.cursor = 'grab'; }
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && (state.floating || state.sel)) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape' && (state.floating || state.sel)) { clearSelection(); return; }
  if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey) { setTool('gradient'); return; }
  const map = { b: 'pencil', e: 'eraser', g: 'fill', i: 'picker', l: 'line', r: 'rect', o: 'ellipse', h: 'pan', m: 'select', q: 'lasso', w: 'wand', x: 'replace' };
  if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
  if (e.key === '+' || e.key === '=') { state.zoom = Math.min(64, state.zoom * 1.2); render(); }
  if (e.key === '-') { state.zoom = Math.max(1, state.zoom / 1.2); render(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') { state.spaceHeld = false; setTool(state.tool); } });
view.addEventListener('pointerdown', (e) => { if (state.spaceHeld) e.spaceHeld = true; }, true);

window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', resizeView);

// ---------- Secciones colapsables del panel derecho ----------
const RP = $('#rightpanel');
RP.addEventListener('click', (e) => {
  const title = e.target.closest('.panel-title');
  if (!title) return;
  if (e.target.closest('button, input, select, a, .layers-tools')) return; // no plegar al usar controles del header
  title.closest('.panel-block').classList.toggle('collapsed');
  savePanelCollapse();
});
function savePanelCollapse() {
  const collapsed = [...RP.querySelectorAll('.panel-block.collapsed')].map((b) => b.dataset.sec);
  try { localStorage.setItem('pe_panels', JSON.stringify(collapsed)); } catch {}
}
function restorePanelCollapse() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem('pe_panels') || '[]'); } catch {}
  for (const sec of arr) { const b = RP.querySelector(`.panel-block[data-sec="${sec}"]`); if (b) b.classList.add('collapsed'); }
}
restorePanelCollapse();

// ---------- Visibilidad de paneles (modelo pe_ui: izq / der / herramientas / estado) ----------
const UI_DEF = { left: false, right: false, toolbar: false, status: false };
let _ui = { ...UI_DEF };
function loadUI() { try { _ui = { ...UI_DEF, ...(JSON.parse(localStorage.getItem('pe_ui') || '{}')) }; } catch {} }
function saveUI() { try { localStorage.setItem('pe_ui', JSON.stringify(_ui)); } catch {} }
function applyUI() {
  document.body.classList.toggle('ui-left-collapsed', _ui.left);
  document.body.classList.toggle('ui-right-collapsed', _ui.right);
  document.body.classList.toggle('ui-toolbar-collapsed', _ui.toolbar);
  document.body.classList.toggle('ui-status-collapsed', _ui.status);
  const sync = (id, k) => { const el = $(id); if (el) el.checked = !_ui[k]; };
  sync('#vmLeft', 'left'); sync('#vmRight', 'right'); sync('#vmToolbar', 'toolbar'); sync('#vmStatus', 'status');
  if (typeof resizeView === 'function') resizeView(); // INVARIANTE: recalcular el lienzo tras cambiar anchos
}
function setPane(key, collapsed) {
  _ui[key] = collapsed; saveUI(); applyUI();
  if (collapsed && key === 'left') { if (window.hidePreview) window.hidePreview(); $('#railLeft') && $('#railLeft').focus(); }
  if (collapsed && key === 'right') { $('#railRight') && $('#railRight').focus(); }
}
function togglePane(key) { setPane(key, !_ui[key]); }
let _focusSnap = null;
function toggleFocus() {
  if (_focusSnap) { _ui = _focusSnap; _focusSnap = null; }
  else { _focusSnap = { ..._ui }; _ui = { left: true, right: true, toolbar: true, status: true }; }
  saveUI(); applyUI();
}
function resetUI() { _focusSnap = null; _ui = { ...UI_DEF }; saveUI(); applyUI(); }

// Aplicar al cargar SIN animación (anti-FOUC, crítica M3)
document.body.classList.add('no-anim');
loadUI(); applyUI();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('no-anim')));

$('#btnCollapseLeft') && $('#btnCollapseLeft').addEventListener('click', () => setPane('left', true));
$('#btnCollapseRight') && $('#btnCollapseRight').addEventListener('click', () => setPane('right', true));
$('#railLeft') && $('#railLeft').addEventListener('click', () => setPane('left', false));
$('#railRight') && $('#railRight').addEventListener('click', () => setPane('right', false));

// Onboarding una sola vez: pulso en los chevrons + tip (descubribilidad, crítica M2)
if (!localStorage.getItem('pe_seen_collapse')) {
  setTimeout(() => {
    ['#btnCollapseLeft', '#btnCollapseRight'].forEach((id) => $(id) && $(id).classList.add('hint-pulse'));
    document.querySelectorAll('.panel-title').forEach((t) => t.classList.add('hint-pulse'));
    toast('Tip: clic en los títulos (Color/Capas/IA) para plegarlos; usa « » en los bordes o el botón 👁 Ver para ocultar paneles enteros.', 'ok', 6500);
    try { localStorage.setItem('pe_seen_collapse', '1'); } catch {}
  }, 1200);
}

// ---------- Vista previa flotante al pasar el ratón por el árbol ----------
if (window.matchMedia('(hover: hover)').matches) (function setupTreePreview() {
  const tree = $('#tree');
  const el = document.createElement('div');
  el.id = 'treePreview'; el.hidden = true;
  el.innerHTML = '<img alt=""><span class="tp-label"></span>';
  document.body.appendChild(el);
  const img = el.querySelector('img'), label = el.querySelector('.tp-label');
  let hoverPath = null, showTimer = 0, rafId = 0, lastXY = null;

  function position(cx, cy) {
    const OFF = 16, M = 8, w = el.offsetWidth, h = el.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let x = cx + OFF; if (x + w + M > vw) x = cx - OFF - w;
    let y = cy + OFF; if (y + h + M > vh) y = cy - OFF - h;
    x = Math.max(M, Math.min(x, vw - w - M)); y = Math.max(M, Math.min(y, vh - h - M));
    el.style.transform = `translate(${x}px, ${y}px)`;
  }
  function show(path, cx, cy) {
    img.onload = () => {
      label.textContent = path.split('/').pop() + (img.naturalWidth ? ` · ${img.naturalWidth}×${img.naturalHeight}` : '');
      el.hidden = false; position(cx, cy);
    };
    img.src = '/api/file?path=' + encodeURIComponent(path); // crítica B1: directo, reusa la caché HTTP del thumb
    if (img.complete && img.naturalWidth) img.onload();
  }
  window.hidePreview = function () { el.hidden = true; img.onload = null; img.removeAttribute('src'); hoverPath = null; };

  tree.addEventListener('mouseover', (e) => {
    const f = e.target.closest('.tree-file'); if (!f || !tree.contains(f)) return;
    const path = f.dataset.path; if (path === hoverPath) return;
    hoverPath = path; const cx = e.clientX, cy = e.clientY;
    clearTimeout(showTimer); showTimer = setTimeout(() => show(path, cx, cy), 120);
  });
  tree.addEventListener('mouseout', (e) => {
    const f = e.target.closest('.tree-file'), to = e.relatedTarget;
    if (f && to && f.contains(to)) return;
    hoverPath = null; clearTimeout(showTimer); window.hidePreview();
  });
  tree.addEventListener('mousemove', (e) => {
    if (el.hidden) return; lastXY = [e.clientX, e.clientY]; if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; if (lastXY) position(lastXY[0], lastXY[1]); });
  });
  tree.addEventListener('scroll', () => window.hidePreview(), { passive: true });
  window.addEventListener('blur', () => window.hidePreview());
})();

// ---------- Cajones laterales (responsive / táctil) ----------
const sidebarEl = $('#sidebar'), rightEl = $('#rightpanel'), backdrop = $('#drawerBackdrop');
function closeDrawers() {
  sidebarEl.classList.remove('open'); rightEl.classList.remove('open');
  backdrop.classList.add('hidden');
  $('#btnDrawerLeft').setAttribute('aria-expanded', 'false');
  $('#btnDrawerRight').setAttribute('aria-expanded', 'false');
}
function toggleDrawer(panel) {
  const opening = !panel.classList.contains('open');
  closeDrawers();
  if (opening) {
    panel.classList.add('open');
    backdrop.classList.remove('hidden');
    const btn = panel === sidebarEl ? $('#btnDrawerLeft') : $('#btnDrawerRight');
    btn.setAttribute('aria-expanded', 'true');
  }
}
$('#btnDrawerLeft').addEventListener('click', () => toggleDrawer(sidebarEl));
$('#btnDrawerRight').addEventListener('click', () => toggleDrawer(rightEl));
backdrop.addEventListener('click', closeDrawers);
// Al elegir una textura en móvil, cierra el cajón para ver el lienzo
$('#tree').addEventListener('click', (e) => { if (e.target.closest('.tree-file')) closeDrawers(); });

// ---------- Esc cierra cualquier modal o cajón abierto (accesibilidad) ----------
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = [...document.querySelectorAll('.modal:not(.hidden)')].pop();
  if (modal) { modal.classList.add('hidden'); e.stopPropagation(); return; }
  if (sidebarEl.classList.contains('open') || rightEl.classList.contains('open')) { closeDrawers(); e.stopPropagation(); }
}, true);

// ---------- Pegar imagen del portapapeles (Ctrl+V) ----------
window.addEventListener('paste', (e) => {
  if (e.target && e.target.matches && e.target.matches('input, textarea')) return; // pegar texto normal en los campos
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const blob = it.getAsFile();
      if (blob) { e.preventDefault(); loadPastedImage(blob); return; }
    }
  }
});
function loadPastedImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    // Cargar en el lienzo (documento nuevo de una capa) para editar a mano
    initLayers(img.naturalWidth, img.naturalHeight, (ctx) => ctx.drawImage(img, 0, 0));
    state.srcMeta = null; // imagen pegada: no es animación
    state.current = { path: null, w: img.naturalWidth, h: img.naturalHeight };
    state.undo = []; state.redo = [];
    $('#noFile').classList.add('hidden');
    $('#stSize').textContent = `${img.naturalWidth}×${img.naturalHeight}px`;
    $('#stPath').textContent = '(imagen pegada · sin guardar)';
    $('#ctxBar').style.display = 'none';
    markDirty(true);
    fitToView();
    extractPalette();
    toast(`Imagen pegada (${img.naturalWidth}×${img.naturalHeight}). Edítala a mano.`, 'ok', 4000);
  };
  img.onerror = () => toast('No se pudo leer la imagen pegada', 'err');
  img.src = url;
}

// ===================================================================
//  ZONA DE TRABAJO (carpeta del pack) + BALANCE
// ===================================================================
async function loadTree() {
  const tree = await api('/api/tree');
  state.files = tree.files;
  $('#treeStats').textContent = `${tree.count} imágenes`;
  renderTree();
}
// ---------- Proyectos (recientes + cambiar de pack, con estado por proyecto) ----------
function loadProjects() { try { return JSON.parse(localStorage.getItem('pe_projects') || '[]'); } catch { return []; } }
function saveProjects(list) { try { localStorage.setItem('pe_projects', JSON.stringify(list.slice(0, 12))); } catch {} }
function rememberProject(path, name) {
  if (!path || path === '—') return;
  const list = loadProjects().filter((p) => p.path !== path);
  list.unshift({ path, name: name || path.split(/[\\/]/).pop(), lastOpened: Date.now() });
  saveProjects(list);
}
const projModal = $('#projectsModal'), projList = $('#projList'), projPath = $('#projPath'), projStatus = $('#projStatus');
function renderProjects() {
  const cur = ($('#packPath').textContent || '').trim();
  projList.innerHTML = '';
  for (const p of loadProjects()) {
    const row = document.createElement('div');
    row.className = 'proj-item' + (p.path === cur ? ' current' : '');
    row.innerHTML = `<svg class="ico"><use href="#i-folder"/></svg>
      <div class="proj-meta"><div class="proj-name"></div><div class="proj-path"></div></div>
      <button class="proj-del" title="Quitar de la lista" aria-label="Quitar"><svg class="ico"><use href="#i-trash"/></svg></button>`;
    row.querySelector('.proj-name').textContent = p.name;
    row.querySelector('.proj-path').textContent = p.path;
    row.addEventListener('click', (e) => { if (e.target.closest('.proj-del')) return; openProject(p.path); });
    row.querySelector('.proj-del').addEventListener('click', (e) => {
      e.stopPropagation(); saveProjects(loadProjects().filter((x) => x.path !== p.path)); renderProjects();
    });
    projList.appendChild(row);
  }
}
function openProjectsModal() {
  projStatus.textContent = ''; projStatus.className = 'ai-status';
  const cur = ($('#packPath').textContent || '').trim();
  projPath.value = cur && cur !== '—' ? cur : '';
  renderProjects();
  projModal.classList.remove('hidden');
  projPath.focus();
}
function closeProjectsModal() { projModal.classList.add('hidden'); }
async function openProject(path) {
  path = (path || '').trim();
  if (!path) { projStatus.textContent = 'Escribe la ruta de la carpeta.'; projStatus.className = 'ai-status err'; return; }
  projStatus.textContent = 'Abriendo…'; projStatus.className = 'ai-status';
  try {
    persistState(); // guarda el trabajo del proyecto SALIENTE (con su clave actual)
    const r = await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packRoot: path }),
    });
    $('#packPath').textContent = r.packRoot; // <- cambia la clave de _stateKey()
    rememberProject(r.packRoot);
    state.current = null; markDirty(false);
    await loadTree();
    $('#noFile').classList.remove('hidden');
    $('#stPath').textContent = ''; $('#stSize').textContent = '—';
    render();
    await restoreState(); // reabre el trabajo del proyecto ENTRANTE
    closeProjectsModal();
    toast('Proyecto: ' + r.packRoot, 'ok', 4000);
  } catch (err) {
    projStatus.textContent = 'No se pudo abrir: ' + err.message; projStatus.className = 'ai-status err';
  }
}
$('#projOpen').addEventListener('click', () => openProject(projPath.value));
$('#projCancel').addEventListener('click', closeProjectsModal);
projPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProject(projPath.value); });
projModal.addEventListener('click', (e) => { if (e.target === projModal) closeProjectsModal(); });
$('#packPath').addEventListener('click', openProjectsModal);
$('#packPath').style.cursor = 'pointer';
$('#packPath').title = 'Clic para gestionar proyectos / cambiar de pack';
const brandEl = document.querySelector('.brand');
if (brandEl) { brandEl.addEventListener('click', openProjectsModal); brandEl.style.cursor = 'pointer'; brandEl.title = 'Proyectos'; }

// ===================================================================
//  ARRANQUE
// ===================================================================
async function init() {
  setTool('pencil');
  updateSwatch();
  setPaletteColors(DEFAULT_PALETTE);
  resizeView();
  try {
    const cfg = await api('/api/config');
    $('#packPath').textContent = cfg.packRoot;
    if (cfg.packRoot && cfg.packRoot !== '—') rememberProject(cfg.packRoot);
  } catch {}
  try { await loadTree(); }
  catch (err) { toast('No se pudo leer el pack: ' + err.message, 'err', 6000); }
  await restoreState();
  // refreshBalance(); // sin IA en la versión pública
  renderLayersPanel(); renderFrames(); // estado inicial de capas y timeline
  updateInpaintSelUI(); // botón "rediseñar zona" arranca deshabilitado hasta que haya selección
}
init();

// Depuración local: expone el estado y utilidades en consola (solo en localhost).
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__ed = { get state() { return state; }, render, setTool, liftSelection, dropFloating, replaceColor, screenToPixel };
}

// Resize de paneles laterales
function makeResizable(handle, panel, side) {
  let startX, startW;
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX; startW = panel.offsetWidth;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = side === 'left' ? startW + dx : startW - dx;
      panel.style.width = Math.max(160, Math.min(560, w)) + 'px';
      resizeView();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
makeResizable($('#handleLeft'), $('#sidebar'), 'left');
makeResizable($('#handleRight'), $('#rightpanel'), 'right');
