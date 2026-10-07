<img src="images/icon.png" width="96" align="right" alt="H5 Viewer icon" />

# H5 Viewer — HDF5 Inspector for VS Code

Fast, lightweight, zero-native-dependency viewer for HDF5 files (`.h5`, `.hdf5`, `.he5`).

Open any HDF5 file and get a hierarchical explorer, rich metadata, a paginated data grid
with slicing for multidimensional tensors, and zero-dependency canvas previews —
all parsed with pure JavaScript, no HDF5 native library required.

## Features

- **Tree explorer** — groups, datasets and scalars with collapsible nodes, SVG icons,
  dtype badges, live filter, expand/collapse-all, and full keyboard navigation (↑ ↓ ← →, Enter).
- **Metadata panel** — path breadcrumbs, datatype, shape/rank, element count, chunking,
  compression, and an attributes table (click any value to copy it).
- **Data grid** — paginated tabular view (50–500 rows/page) for 1-D/2-D data;
  slice slider (`[i, :, :]`) plus numeric box for 3-D+ tensors; in-page value filter;
  click any cell to copy it.
- **Previews** — line chart with axes + min/max/mean stats for 1-D data;
  heatmap with color legend + stats for 2-D slices. Pure `<canvas>`, no chart library.
- **Export CSV** — one click exports the current 2-D view via a save dialog
  (capped at 200k cells with a truncation warning for giant views).
- **Group overview** — member table (name / type / shape / datatype) with click-through.
- **Safe by design** — structure loads first, dataset values are fetched lazily per page;
  corrupt files produce a friendly error, never a crash; strict Content Security Policy
  (nonce scripts, no CDN, no `eval`).
- **Native look** — styled entirely with `var(--vscode-*)` design tokens, so it follows
  your theme (dark, light, high-contrast) automatically.

## Requirements

- VS Code `^1.85.0`
- Node.js 18+ (only needed to build from source, not to use the packaged extension)

## Installation

### Option A — from the `.vsix` file

```bash
code --install-extension h5-viewer-0.1.0.vsix
```

Or in VS Code: Extensions view (⇧⌘X) → `...` menu → **Install from VSIX…** → pick the file.

### Option B — build from source

```bash
git clone <your-repo-url> h5_viewer
cd h5_viewer
npm install
npm run compile
```

Then press **F5** to launch the Extension Development Host, or package it:

```bash
npx @vscode/vsce package
code --install-extension h5-viewer-0.1.0.vsix
```

## Usage

1. Open any `.h5` / `.hdf5` / `.he5` file — it opens in the **HDF5 Inspector** automatically.
   - If VS Code opens it as binary instead: right-click the editor tab →
     **Reopen Editor With → HDF5 Inspector**, or run the command
     **H5 Viewer: Reopen as HDF5 Inspector**.
2. Browse the tree on the left (filter box, arrow keys work); click a dataset.
3. Page through values, drag the slice slider for 3-D+ tensors, toggle the preview,
   export to CSV when needed.

## Commands

| Command | Description |
|---|---|
| `H5 Viewer: Reopen as HDF5 Inspector` (`h5Viewer.reopenAsHdf5`) | Reopen the active file in the HDF5 custom editor |

## Project structure

```
package.json                  manifest: customEditors, activation, icon, scripts
esbuild.js                    bundles src/extension.ts -> dist/extension.js
                              and src/webview/main.ts -> dist/webview.js (+ copies CSS)
tsconfig.json                 extension-host TS config
tsconfig.webview.json         webview TS config (DOM, bundler resolution)
src/
  extension.ts                activate(): registers Hdf5EditorProvider
  hdf5EditorProvider.ts       CustomReadonlyEditorProvider: jsfive parsing,
                              tree walk, paged/sliced dataset protocol, CSP HTML,
                              clipboard + CSV-export handlers
  jsfive.d.ts                 minimal typings for the untyped jsfive package
  webview/
    main.ts                   tree + breadcrumbs + metadata + paginated table +
                              slice slider + canvas charts + toasts + footer
    styles.css                VS Code token styling, responsive split pane
images/icon.png               extension icon
dist/                         build output (git-ignored)
.vscode/{launch,tasks}.json   F5 Extension Development Host wiring
```

## Development

| Script | What it does |
|---|---|
| `npm run compile` | `node esbuild.js` → `dist/extension.js`, `dist/webview.js`, `dist/webview.css` |
| `npm run watch` | esbuild watch mode for UI iteration |
| `npm run lint` | `tsc --noEmit` (extension host). Webview: `npx tsc --noEmit -p tsconfig.webview.json` |
| `npm run package` | `vsce package` → `.vsix` |

### Debug in the Extension Development Host (F5)

1. Open this folder in VS Code.
2. Press **F5** (runs the `npm: compile` pre-launch task, then opens a second window).
3. In the host window, open an `.h5` file and exercise the UI:
   filter → select dataset → page → slice → preview → export.
4. Sanity-check corruption handling: `echo garbage > bad.h5` and open it —
   expect a notification + inline error, not a crash.

## How it works

- **Parser:** [`jsfive`](https://www.npmjs.com/package/jsfive) (pure JS, port of `pyfive`)
  runs in the extension host. `openCustomDocument` reads the file once and builds only the
  **tree + attributes + shape/dtype**; dataset `value`s stay in the host and are converted
  to a paged 2-D window on demand (`MAX_CELLS_PER_RESPONSE = 20,000`, `pageSize ≤ 500`).
  Rank ≥ 3 tensors are sliced as `[sliceIndex, :, :]` before paging; N-D values arrive
  flat from jsfive and are re-chunked row-major; scalar values unwrap from 1-element arrays.
- **Messaging** (`postMessage` / `onDidReceiveMessage`):

  Webview → host: `ready` · `getTree` · `getDataset { path, sliceIndex?, page?, pageSize? }` ·
  `copyText { text }` · `exportCsv { path, sliceIndex? }`

  Host → webview: `tree { fileName, fileSize, root }` · `dataset { data: DatasetPage }` · `error { message }`

- **Memory safety:** 300 MiB warning toast, 1 GiB hard refuse
  (tune `WARN_FILE_BYTES` / `MAX_FILE_BYTES` in `hdf5EditorProvider.ts`).
  `bigint` attributes are stringified so `postMessage` payloads stay JSON-safe.

## Limitations

- `jsfive` loads the whole file `ArrayBuffer` into memory — "lazy" means lazy
  *value transfer to the webview*, not lazy file I/O. For > 1 GiB files, swap
  `datasetMatrix()` for [`h5wasm`](https://github.com/usnistgov/h5wasm) slicing;
  the `DatasetPage` wire shape stays unchanged, so the webview needs no edits.
- Exotic datatypes/filters jsfive can't decode surface as per-dataset errors, not per-file.
- Read-only: HDF5 editing is out of scope (`CustomReadonlyEditorProvider`).

## License

MIT — see `package.json` (`"license": "MIT"`).
