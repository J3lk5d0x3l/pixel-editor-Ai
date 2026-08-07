// Editor de pixel art para resourcepacks de Minecraft.
// Backend Node nativo (cero dependencias). Sirve la UI, lee/escribe PNGs
// in-place dentro del resourcepack y empaqueta todo el pack a un .zip
// listo para subir. Sin servicios externos.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Configuración ----------
// El usuario debe crear su propio config.json a partir de config.example.json.
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      packRoot: path.resolve(raw.packRoot || ''),
      port: Number(raw.port) || 8787,
    };
  } catch (err) {
    console.error('No se pudo leer config.json. Cópialo desde config.example.json y rellena packRoot.');
    return { packRoot: '', port: 8787 };
  }
}
let config = loadConfig();

// ---------- Utilidades HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}
function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Cuerpo de la petición demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// Resuelve una ruta relativa dentro del packRoot evitando path traversal.
function safeResolve(rel) {
  if (!config.packRoot) return null;
  const cleaned = String(rel || '').replace(/^[/\\]+/, '');
  const full = path.resolve(config.packRoot, cleaned);
  const root = path.resolve(config.packRoot);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

// ---------- Recorrido del resourcepack ----------
async function walkPngs(dir, root, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkPngs(abs, root, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      let stat;
      try { stat = await fsp.stat(abs); } catch { continue; }
      out.push({
        path: path.relative(root, abs).split(path.sep).join('/'),
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  return out;
}

// ---------- Conciencia de formato (dimensiones, mcmeta, fuentes) ----------
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

function fontFileToRel(file) {
  let ns = 'minecraft', p = file;
  const i = file.indexOf(':');
  if (i >= 0) { ns = file.slice(0, i); p = file.slice(i + 1); }
  return `assets/${ns}/textures/${p}`;
}

let _fontIndex = null, _fontIndexRoot = null;
async function collectFontJsons(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await collectFontJsons(abs, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.json') && abs.split(path.sep).includes('font')) out.push(abs);
  }
  return out;
}
async function ensureFontIndex() {
  if (!config.packRoot) return new Map();
  if (_fontIndex && _fontIndexRoot === config.packRoot) return _fontIndex;
  const idx = new Map();
  const jsons = await collectFontJsons(config.packRoot, []);
  for (const jf of jsons) {
    let data;
    try { data = JSON.parse(await fsp.readFile(jf, 'utf8')); } catch { continue; }
    const providers = Array.isArray(data.providers) ? data.providers : [];
    for (const pr of providers) {
      if (pr.type === 'bitmap' && pr.file) {
        const rel = fontFileToRel(pr.file).split(path.sep).join('/');
        if (!idx.has(rel)) idx.set(rel, {
          height: pr.height, ascent: pr.ascent, chars: pr.chars,
          font: path.relative(config.packRoot, jf).split(path.sep).join('/'),
        });
      }
    }
  }
  _fontIndex = idx; _fontIndexRoot = config.packRoot;
  return idx;
}

// ---------- Empaquetado ZIP (PowerShell Compress-Archive, sin dependencias) ----------
function runPowerShell(psCommand) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      }
    );
  });
}
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// IMPORTANTE: Compress-Archive de Windows PowerShell 5.1 escribe las rutas con '\',
// y Minecraft/Java rechazan esos packs. Construimos el zip con System.IO.Compression
// forzando '/' en cada entrada.
async function zipPackTo(dest) {
  const root = config.packRoot;
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$root='${q(root)}'`,
    `$dest='${q(dest)}'`,
    'if (Test-Path $dest) { Remove-Item $dest -Force }',
    '$dir = Split-Path $dest -Parent',
    'if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$rootFull = (Resolve-Path $root).Path',
    "$zip = [System.IO.Compression.ZipFile]::Open($dest,'Create')",
    'try {',
    '  Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {',
    "    $rel = $_.FullName.Substring($rootFull.Length).TrimStart('\\','/').Replace('\\','/')",
    '    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel)',
    '  }',
    '} finally { $zip.Dispose() }',
  ].join('\n');
  await runPowerShell(ps);
  const stat = await fsp.stat(dest);
  return { dest, size: stat.size };
}
async function exportZip(outName) {
  const root = config.packRoot;
  const parent = path.dirname(root);
  const base = outName && outName.trim() ? outName.trim().replace(/[^\w.\- ]/g, '_') : `${path.basename(root)}_editado_${timestamp()}`;
  const dest = path.join(parent, base.endsWith('.zip') ? base : base + '.zip');
  return await zipPackTo(dest);
}
async function backupPack() {
  const root = config.packRoot;
  const dest = path.join(__dirname, 'backups');
  await fsp.mkdir(dest, { recursive: true });
  const zip = path.join(dest, `${path.basename(root)}_backup_${timestamp()}.zip`);
  const r = await zipPackTo(zip);
  return { dest: zip, size: r.size };
}

// ---------- Gestión de archivos del pack ----------
function relOf(full) { return path.relative(path.resolve(config.packRoot), full).split(path.sep).join('/'); }
async function fsMkdir(rel) {
  const full = safeResolve(rel); if (!full) throw new Error('Ruta inválida');
  if (fs.existsSync(full)) throw new Error('Ya existe esa carpeta');
  await fsp.mkdir(full, { recursive: true });
  return relOf(full);
}
async function fsRename(rel, newName) {
  const full = safeResolve(rel); if (!full) throw new Error('Ruta inválida');
  const clean = String(newName || '').replace(/[/\\]/g, '').trim();
  if (!clean) throw new Error('Nombre inválido');
  const dest = path.join(path.dirname(full), clean);
  const root = path.resolve(config.packRoot);
  if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error('Destino inválido');
  if (fs.existsSync(dest)) throw new Error('Ya existe algo con ese nombre');
  await fsp.rename(full, dest);
  return relOf(dest);
}
async function fsMove(rel, destDirRel) {
  const full = safeResolve(rel); const destDir = safeResolve(destDirRel || '');
  if (!full || destDir === null) throw new Error('Ruta inválida');
  if (!fs.existsSync(destDir)) await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(full));
  if (fs.existsSync(dest)) throw new Error('Ya existe en el destino');
  await fsp.rename(full, dest);
  return relOf(dest);
}
async function fsDuplicate(rel) {
  const full = safeResolve(rel); if (!full) throw new Error('Ruta inválida');
  const dir = path.dirname(full), ext = path.extname(full), base = path.basename(full, ext);
  let i = 1, dest;
  do { dest = path.join(dir, `${base}_copia${i > 1 ? i : ''}${ext}`); i++; } while (fs.existsSync(dest) && i < 1000);
  await fsp.copyFile(full, dest);
  return relOf(dest);
}
async function fsTrash(rel) {
  const full = safeResolve(rel); if (!full) throw new Error('Ruta inválida');
  const trashDir = path.join(__dirname, 'backups', 'trash', timestamp());
  await fsp.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, path.basename(full));
  await fsp.rename(full, dest);
  return dest;
}

// ---------- Estáticos ----------
async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'Prohibido');
  try {
    const data = await fsp.readFile(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendError(res, 404, 'No encontrado: ' + rel);
  }
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const p = url.pathname;

    if (p === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, { packRoot: config.packRoot, port: config.port });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readJSON(req);
      if (body.packRoot) {
        const resolved = path.resolve(body.packRoot);
        if (!fs.existsSync(resolved)) return sendError(res, 400, 'La carpeta no existe: ' + resolved);
        const raw = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
        raw.packRoot = resolved;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
        config = loadConfig();
      }
      return sendJSON(res, 200, { packRoot: config.packRoot });
    }

    if (p === '/api/tree' && req.method === 'GET') {
      if (!config.packRoot || !fs.existsSync(config.packRoot)) {
        return sendError(res, 400, 'La carpeta del pack no existe: ' + (config.packRoot || '(vacía)'));
      }
      const files = await walkPngs(config.packRoot, config.packRoot, []);
      files.sort((a, b) => a.path.localeCompare(b.path));
      return sendJSON(res, 200, { packRoot: config.packRoot, count: files.length, files });
    }

    if (p === '/api/context' && req.method === 'GET') {
      const rel = String(url.searchParams.get('path') || '').replace(/^[/\\]+/, '');
      const full = safeResolve(rel);
      if (!full) return sendError(res, 400, 'Ruta inválida');
      const ctx = { path: rel };
      try {
        const buf = await fsp.readFile(full);
        const sz = pngSize(buf);
        if (sz) { ctx.width = sz.width; ctx.height = sz.height; ctx.pow2 = isPow2(sz.width) && isPow2(sz.height); }
      } catch { return sendError(res, 404, 'No encontrado'); }
      try { ctx.mcmeta = JSON.parse(await fsp.readFile(full + '.mcmeta', 'utf8')); } catch {}
      const idx = await ensureFontIndex();
      const relN = rel.split('\\').join('/');
      if (idx.has(relN)) ctx.font = idx.get(relN);
      const base = relN.split('/').pop();
      for (const [k, v] of idx) {
        if (k !== relN && k.split('/').pop() === base) { ctx.twin = { path: k, ...v }; break; }
      }
      return sendJSON(res, 200, ctx);
    }

    if (p === '/api/file' && req.method === 'GET') {
      const full = safeResolve(url.searchParams.get('path'));
      if (!full) return sendError(res, 400, 'Ruta inválida');
      try {
        const data = await fsp.readFile(full);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(data);
      } catch {
        return sendError(res, 404, 'Archivo no encontrado');
      }
    }

    if (p === '/api/save' && req.method === 'POST') {
      const body = await readJSON(req);
      const full = safeResolve(body.path);
      if (!full) return sendError(res, 400, 'Ruta inválida');
      const dataUrl = body.dataUrl || '';
      const m = /^data:image\/png;base64,(.+)$/s.exec(dataUrl);
      if (!m) return sendError(res, 400, 'Se esperaba un PNG en dataUrl');
      const buf = Buffer.from(m[1], 'base64');
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, buf);
      if (body.mcmeta) {
        await fsp.writeFile(full + '.mcmeta', JSON.stringify(body.mcmeta, null, 2));
      } else if (body.mcmeta === null) {
        try { await fsp.unlink(full + '.mcmeta'); } catch {}
      }
      const stat = await fsp.stat(full);
      return sendJSON(res, 200, { ok: true, size: stat.size, mtime: stat.mtimeMs });
    }

    if (p.startsWith('/api/fs/') && req.method === 'POST') {
      const op = p.slice('/api/fs/'.length);
      const body = await readJSON(req);
      try {
        const r = { ok: true };
        if (op === 'mkdir') r.path = await fsMkdir(body.path);
        else if (op === 'rename') r.path = await fsRename(body.path, body.name);
        else if (op === 'move') r.path = await fsMove(body.path, body.dest);
        else if (op === 'duplicate') r.path = await fsDuplicate(body.path);
        else if (op === 'delete') r.trashed = await fsTrash(body.path);
        else return sendError(res, 404, 'Operación desconocida: ' + op);
        _fontIndex = null; // la estructura cambió; rehacer índice de fuentes
        return sendJSON(res, 200, r);
      } catch (err) { return sendError(res, 400, err.message); }
    }

    if (p === '/api/export-zip' && req.method === 'POST') {
      const body = await readJSON(req);
      try {
        const result = await exportZip(body.name);
        return sendJSON(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendError(res, 500, 'Error al crear el ZIP: ' + err.message);
      }
    }

    if (p === '/api/backup' && req.method === 'POST') {
      try {
        const result = await backupPack();
        return sendJSON(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendError(res, 500, 'Error al crear el backup: ' + err.message);
      }
    }

    // --- Estáticos ---
    if (req.method === 'GET') return serveStatic(req, res, p);

    return sendError(res, 404, 'Ruta no encontrada');
  } catch (err) {
    sendError(res, 500, 'Error del servidor: ' + (err && err.message ? err.message : String(err)));
  }
});

server.listen(config.port, () => {
  console.log('\n  Pixel Resourcepack Editor');
  console.log('  ──────────────────────────────────────────');
  console.log(`  Pack:     ${config.packRoot || '(sin configurar)'}`);
  console.log(`  Abre:     http://localhost:${config.port}`);
  console.log('  ──────────────────────────────────────────\n');
});
