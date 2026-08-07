# Pixel Editor · Resourcepack

Editor web local de pixel art para **resourcepacks de Minecraft**.
Lee y escribe los `.png` del pack directamente en disco, gestiona `.mcmeta` y fuentes bitmap, y exporta el pack entero a un `.zip` listo para subir.

> 🇪🇸 **Español** abajo · 🇺🇸 **English** below

![status](https://img.shields.io/badge/status-ready-success)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![deps](https://img.shields.io/badge/dependencies-zero-blue)

---

## 🇪🇸 Español

### ¿Qué es esto?

Una herramienta web que abre cualquier carpeta de resourcepack de Minecraft (ya descomprimida) y te deja **editar los `.png` píxel a píxel** desde el navegador: pincel, borrador, bote, cuentas, selección rectangular, lazo, varita mágica, simetría, capas, fotogramas, deshacer/rehacer, exportar a `.zip`. Sin servicios externos, sin telemetría, sin nube.

### ¿Qué **NO** incluye?

- **No incluye ningún resourcepack.** Tú apuntas el editor a tu propia carpeta.
- **No incluye integración con IA.** Esta versión pública es solo el editor. Si quieres IA, instala la versión completa por tu cuenta.
- **No publica a ningún servidor.** El ZIP se genera localmente y tú decides dónde subirlo.

### Requisitos

- **Windows 10/11** (usa PowerShell 5.1 para comprimir el ZIP — en macOS/Linux el editor funciona pero la exportación requiere `zip`).
- **Node.js ≥ 20** instalado y en el `PATH`. Compruébalo con:
  ```sh
  node -v
  ```
- Un resourcepack de Minecraft **descomprimido** en una carpeta (la raíz debe contener `pack.mcmeta` y `assets/`).

### Instalación y arranque

1. Clona el repo:
   ```sh
   git clone https://github.com/J3lk5d0x3l/pixel-editor-Ai.git
   cd pixel-editor-Ai
   ```
2. Copia el archivo de configuración de ejemplo y edita la ruta a tu pack:
   ```sh
   cp config.example.json config.json
   ```
   Edita `config.json` y pon en `packRoot` la **ruta absoluta** a la carpeta descomprimida de tu resourcepack:
   ```json
   { "packRoot": "C:\\Users\\TuUsuario\\mi-resourcepack", "port": 8787 }
   ```
3. Arranca el servidor (no hay dependencias que instalar):
   ```sh
   npm start
   ```
4. Abre el navegador en **http://localhost:8787**

> ⚠️ `config.json` está en `.gitignore` — cada usuario tiene el suyo. No lo commitees.

### ¿Cómo se usa?

- **Panel izquierdo**: árbol con todas las texturas del pack. Busca, navega por carpetas, haz clic para abrir.
- **Centro**: el editor. Herramientas en la barra superior (atajos: `B` lápiz, `E` borrador, `G` bote, `I` cuentas, `L` línea, `R` rectángulo, `O` elipse, `M` selección, `Q` lazo, `W` varita, `H` mover vista).
- **Panel derecho**: color (primario/secundario, alfa, paletas extraídas) y capas.
- **Botón Guardar** (Ctrl+S): escribe el PNG en su ruta del pack y crea/borra el `.mcmeta` hermano si hace falta.
- **Exportar ZIP**: empaqueta todo `packRoot` con rutas POSIX (`assets/...`) para que Minecraft lo acepte. El archivo sale en la carpeta padre del pack.
- **Backup**: crea un ZIP del pack en `backups/` por si la lías.
- **Ctrl+K**: paleta de comandos — busca herramientas, acciones o texturas.
- **Proyectos**: clic en el nombre del pack (arriba) para cambiar entre varias carpetas.

### Atajos útiles

| Atajo | Acción |
|---|---|
| `Ctrl+S` | Guardar PNG |
| `Ctrl+Z` / `Ctrl+Y` | Deshacer / Rehacer |
| `Ctrl+B` | Mostrar/ocultar texturas |
| `Ctrl+J` | Mostrar/ocultar color/capas |
| `Ctrl+K` | Paleta de comandos |
| `Espacio + arrastrar` | Mover la vista |
| `Alt + clic` | Cuentagotas con cualquier herramienta |
| `Shift + clic` | Línea recta (en herramientas que lo soporten) |
| `+` / `-` | Zoom |
| `Tab Tab` | Modo enfoque (oculta todo lo que no sea el lienzo) |

### Estructura

```
pixel-editor/
├── server.js            # Backend Node puro: sirve la UI + endpoints del pack
├── public/              # UI (HTML + CSS + JS)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── config.example.json  # Plantilla — copia a config.json y rellena packRoot
├── .gitignore           # Excluye config.json, secrets, temporales
├── package.json
└── README.md
```

### Endpoint `/api` (resumen)

El servidor expone una API mínima en `/api/*`:

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/api/config` | Devuelve `packRoot` y `port` actuales |
| `POST` | `/api/config` | Cambia `packRoot` (lo valida y persiste en `config.json`) |
| `GET` | `/api/tree` | Lista todos los `.png` del pack (con tamaño y mtime) |
| `GET` | `/api/context?path=...` | Devuelve dimensiones, `.mcmeta`, info de fuente bitmap y gemelo ES/EN |
| `GET` | `/api/file?path=...` | Sirve un PNG del pack |
| `POST` | `/api/save` | Escribe un PNG (data-URL base64) y opcionalmente su `.mcmeta` |
| `POST` | `/api/fs/{mkdir,rename,move,duplicate,delete}` | Operaciones de archivo (la papelera va a `backups/trash/`) |
| `POST` | `/api/export-zip` | Empaqueta el pack a `.zip` (POSIX paths) |
| `POST` | `/api/backup` | ZIP del pack en `backups/` |

### Solución de problemas

- **"La carpeta del pack no existe"** → edita `config.json`, comprueba la ruta y que la carpeta contenga `pack.mcmeta`.
- **El ZIP falla en Windows** → el script usa PowerShell 5.1 (que viene con Windows). Si lo desinstalaste, reinstálalo.
- **Cambié de pack y no se ven los archivos** → en la UI, clic en el nombre del pack arriba → "Proyectos" → poner la nueva ruta.

### Licencia

MIT. Úsalo, modifícalo, distribúyelo. Si te ayuda, una estrellita ⭐ en GitHub se agradece.

---

## 🇺🇸 English

### What is this?

A local web-based **pixel art editor for Minecraft resourcepacks**.
It reads and writes the pack's `.png` files directly on disk, manages `.mcmeta` and bitmap fonts, and exports the entire pack to a `.zip` ready to upload.

> ⚠️ **This is the editor only** — no resourcepack content, no AI integration, no publishing pipeline.

### Requirements

- **Windows 10/11** (the ZIP export uses PowerShell 5.1; on macOS/Linux you need a `zip` binary).
- **Node.js ≥ 20**. Check with `node -v`.
- An unpacked Minecraft resourcepack folder on disk (root must contain `pack.mcmeta` and `assets/`).

### Setup

1. Clone:
   ```sh
   git clone https://github.com/J3lk5d0x3l/pixel-editor-Ai.git
   cd pixel-editor-Ai
   ```
2. Copy the example config and point it at your pack:
   ```sh
   cp config.example.json config.json
   ```
   Edit `config.json` and set `packRoot` to the **absolute path** of your unpacked resourcepack:
   ```json
   { "packRoot": "C:\\Users\\You\\my-resourcepack", "port": 8787 }
   ```
3. Start the server (zero npm dependencies):
   ```sh
   npm start
   ```
4. Open **http://localhost:8787**

> ⚠️ `config.json` is gitignored — each user keeps their own. Don't commit it.

### How to use

- **Left panel**: file tree of every texture in the pack. Search, browse folders, click to open.
- **Center**: the editor. Tools in the top bar (shortcuts: `B` pencil, `E` eraser, `G` fill, `I` picker, `L` line, `R` rect, `O` ellipse, `M` select, `Q` lasso, `W` wand, `H` pan).
- **Right panel**: color (primary/secondary, alpha, extracted palettes) and layers.
- **Save** (Ctrl+S): writes the PNG to its path in the pack and creates/removes the sibling `.mcmeta` as needed.
- **Export ZIP**: packages the whole `packRoot` with POSIX paths so Minecraft accepts it. Output goes to the parent folder of your pack.
- **Backup**: creates a ZIP of the pack in `backups/`.
- **Ctrl+K**: command palette — search tools, actions or textures.
- **Projects**: click the pack name at the top to switch between packs.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save PNG |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+B` | Show/hide texture panel |
| `Ctrl+J` | Show/hide color/layers panel |
| `Ctrl+K` | Command palette |
| `Space + drag` | Pan the canvas |
| `Alt + click` | Eyedropper with any tool |
| `Shift + click` | Constrain to straight line (where supported) |
| `+` / `-` | Zoom |
| `Tab Tab` | Focus mode (hide everything except the canvas) |

### Project layout

```
pixel-editor/
├── server.js            # Pure-Node backend: serves UI + pack endpoints
├── public/              # UI (HTML + CSS + JS)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── config.example.json  # Template — copy to config.json and fill packRoot
├── .gitignore           # Excludes config.json, secrets, temp files
├── package.json
└── README.md
```

### `/api` endpoints (summary)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/config` | Returns `packRoot` and `port` |
| `POST` | `/api/config` | Updates `packRoot` (validates + persists) |
| `GET` | `/api/tree` | Lists every `.png` in the pack |
| `GET` | `/api/context?path=...` | Dimensions, `.mcmeta`, font info, ES/EN twin |
| `GET` | `/api/file?path=...` | Serves a pack PNG |
| `POST` | `/api/save` | Writes a PNG (base64 data-URL) and optional `.mcmeta` |
| `POST` | `/api/fs/{mkdir,rename,move,duplicate,delete}` | File operations (trash → `backups/trash/`) |
| `POST` | `/api/export-zip` | Packages pack to `.zip` (POSIX paths) |
| `POST` | `/api/backup` | ZIP of the pack in `backups/` |

### Troubleshooting

- **"Pack folder doesn't exist"** → edit `config.json`, verify the path and that the folder contains `pack.mcmeta`.
- **ZIP fails on Windows** → the script needs PowerShell 5.1, which is built into Windows.
- **Switched packs and nothing shows** → in the UI, click the pack name → "Projects" → enter the new path.

### License

MIT. Use it, fork it, ship it. A star ⭐ on GitHub is appreciated.