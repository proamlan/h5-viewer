import * as vscode from 'vscode';
import * as hdf5 from 'jsfive';

// ---------------------------------------------------------------------------
// Shared wire types (must stay in sync with src/webview/main.ts)
// ---------------------------------------------------------------------------

export interface H5NodeInfo {
  name: string;
  path: string; // absolute HDF5 path, e.g. "/entry/data"
  type: 'group' | 'dataset';
  children?: H5NodeInfo[];
  shape?: number[];
  dtype?: string;
  nElements?: number;
  attrs?: Record<string, unknown>;
  chunks?: number[] | null;
  compression?: string | null;
}

export interface DatasetPage {
  path: string;
  dtype: string;
  shape: number[];
  /** 2-D view actually sent (after slicing N-D → 2-D). */
  viewShape: [number, number];
  /** For rank >= 3: index applied on axis 0. Null when N/A. */
  sliceIndex: number | null;
  page: number;
  pageSize: number;
  totalRows: number;
  totalCols: number;
  /** Stringified-safe cell values for the requested page. */
  rows: unknown[][];
  truncated: boolean;
}

type ToWebview =
  | { type: 'tree'; fileName: string; fileSize: number; root: H5NodeInfo }
  | { type: 'dataset'; data: DatasetPage }
  | { type: 'error'; message: string };

type FromWebview =
  | { type: 'ready' }
  | { type: 'getTree' }
  | { type: 'getDataset'; path: string; sliceIndex?: number | null; page?: number; pageSize?: number }
  | { type: 'copyText'; text: string }
  | { type: 'exportCsv'; path: string; sliceIndex?: number | null };

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/** Warn but continue above this size; jsfive needs the whole file in memory. */
const WARN_FILE_BYTES = 300 * 1024 * 1024;
/** Hard refuse above this size to avoid OOM in the extension host. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** Max cells sent per dataset page response. */
const MAX_CELLS_PER_RESPONSE = 20_000;
/** Max tree depth guard against malicious/corrupt deep links. */
const MAX_WALK_DEPTH = 64;

class Hdf5Document implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly fileSize: number,
    public readonly buffer: Uint8Array,
    public readonly h5file: any
  ) {}

  dispose(): void {
    // Allow GC of the buffer + parsed file. jsfive has no close().
    (this as { buffer?: unknown }).buffer = undefined;
    (this as { h5file?: unknown }).h5file = undefined;
  }
}

export class Hdf5EditorProvider implements vscode.CustomReadonlyEditorProvider<Hdf5Document> {
  public static readonly viewType = 'h5Viewer.hdf5Editor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  // -- vscode.CustomReadonlyEditorProvider ----------------------------------

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<Hdf5Document> {
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      const msg = `H5 Viewer: cannot read file: ${String(err)}`;
      void vscode.window.showErrorMessage(msg);
      throw new Error(msg);
    }

    if (raw.byteLength === 0) {
      const msg = 'H5 Viewer: file is empty (0 bytes).';
      void vscode.window.showErrorMessage(msg);
      throw new Error(msg);
    }
    if (raw.byteLength > MAX_FILE_BYTES) {
      const msg = `H5 Viewer: file is ${(raw.byteLength / 2 ** 30).toFixed(2)} GiB, over the 1 GiB safe limit. Refusing to load.`;
      void vscode.window.showErrorMessage(msg);
      throw new Error(msg);
    }
    if (raw.byteLength > WARN_FILE_BYTES) {
      void vscode.window.showWarningMessage(
        `H5 Viewer: large file (${(raw.byteLength / 2 ** 20).toFixed(1)} MiB). Structure loads first; dataset values are paged on demand.`
      );
    }

    // Copy into a fresh ArrayBuffer (jsfive wants ArrayBuffer; Buffer.pool reuse breaks byteOffset).
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const ab = copy.buffer as ArrayBuffer;

    let file: any;
    try {
      const name = uri.path.split('/').pop() ?? 'file.h5';
      file = new hdf5.File(ab, name);
    } catch (err) {
      const msg = `H5 Viewer: failed to parse HDF5 (malformed or unsupported): ${err instanceof Error ? err.message : String(err)}`;
      void vscode.window.showErrorMessage(msg);
      throw new Error(msg);
    }

    return new Hdf5Document(uri, raw.byteLength, copy, file);
  }

  async resolveCustomEditor(
    document: Hdf5Document,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const send = (msg: ToWebview): void => {
      void webviewPanel.webview.postMessage(msg);
    };

    const sendTree = (): void => {
      try {
        const root = this.buildTree(document.h5file);
        send({
          type: 'tree',
          fileName: document.uri.path.split('/').pop() ?? document.uri.toString(),
          fileSize: document.fileSize,
          root,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: `Failed to walk HDF5 structure: ${message}` });
        void vscode.window.showErrorMessage(`H5 Viewer: ${message}`);
      }
    };

    webviewPanel.webview.onDidReceiveMessage(
      (msg: FromWebview) => {
        try {
          switch (msg.type) {
            case 'ready':
            case 'getTree':
              sendTree();
              break;
            case 'getDataset': {
              const data = this.pageDataset(document.h5file, msg.path, msg.sliceIndex ?? null, msg.page ?? 0, msg.pageSize ?? 100);
              send({ type: 'dataset', data });
              break;
            }
            case 'copyText': {
              void vscode.env.clipboard.writeText(msg.text);
              break;
            }
            case 'exportCsv': {
              void this.exportCsv(document, msg.path, msg.sliceIndex ?? null);
              break;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send({ type: 'error', message });
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  /** Export the current 2-D view of a dataset to a user-chosen .csv file. */
  private async exportCsv(document: Hdf5Document, path: string, sliceIndex: number | null): Promise<void> {
    const { matrix, dtype, shape } = this.datasetMatrix(document.h5file, path, sliceIndex);
    const cells = matrix.length * (matrix.length > 0 ? matrix[0].length : 0);
    const MAX_EXPORT_CELLS = 200_000;
    let rows = matrix;
    let note = '';
    if (cells > MAX_EXPORT_CELLS) {
      const maxRows = Math.max(1, Math.floor(MAX_EXPORT_CELLS / Math.max(1, matrix[0].length)));
      rows = matrix.slice(0, maxRows);
      note = ` (truncated to first ${maxRows} rows — full view is ${matrix.length} rows)`;
      void vscode.window.showWarningMessage(`H5 Viewer: dataset view exceeds CSV export cap; exporting first ${maxRows} rows.`);
    }
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    const suggested = `${(path.split('/').pop() || 'dataset').replace(/[^\w.-]+/g, '_')}.csv`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.Uri.file(document.uri.fsPath.replace(/[^/]+$/, '')), suggested),
      saveLabel: 'Export CSV',
      filters: { 'CSV files': ['csv'] },
    });
    if (!uri) {
      return; // user cancelled
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(csv));
    void vscode.window.showInformationMessage(
      `H5 Viewer: exported ${path} [${shape.join('×')}, ${dtype}]${note} → ${uri.fsPath}`
    );
  }

  // -- HTML ------------------------------------------------------------------

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const nonce = randomNonce();
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      `connect-src 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>HDF5 Inspector</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // -- Tree walking (header-first, lazy values) --------------------------------

  private buildTree(h5file: any): H5NodeInfo {
    const root: H5NodeInfo = { name: '/', path: '/', type: 'group', children: [], attrs: safeAttrs(h5file) };
    const keys: string[] = Array.isArray(h5file?.keys) ? h5file.keys : [];
    root.children = keys.map((k) => this.walk(h5file, k, `/${k}`, 1));
    return root;
  }

  private walk(parent: any, key: string, absPath: string, depth: number): H5NodeInfo {
    if (depth > MAX_WALK_DEPTH) {
      return { name: key, path: absPath, type: 'group', children: [] };
    }
    let obj: any = null;
    try {
      obj = typeof parent?.get === 'function' ? parent.get(key) : null;
    } catch {
      obj = null;
    }
    if (!obj) {
      return { name: key, path: absPath, type: 'group', children: [] };
    }
    const isDataset = 'value' in obj || 'dtype' in obj || 'shape' in obj;
    const hasKeys = Array.isArray(obj?.keys);
    if (isDataset && !hasKeys) {
      return this.describeDataset(key, absPath, obj);
    }
    if (hasKeys) {
      const children: H5NodeInfo[] = [];
      for (const k of obj.keys as string[]) {
        children.push(this.walk(obj, k, `${absPath}/${k}`, depth + 1));
      }
      return { name: key, path: absPath, type: 'group', children, attrs: safeAttrs(obj) };
    }
    // Fallback: treat unknown as dataset if it carries a value.
    return this.describeDataset(key, absPath, obj);
  }

  private describeDataset(name: string, absPath: string, obj: any): H5NodeInfo {
    let shape: number[] | undefined;
    let dtype: string | undefined;
    try {
      shape = inferShape(obj);
    } catch {
      shape = undefined;
    }
    try {
      dtype = inferDtype(obj);
    } catch {
      dtype = 'unknown';
    }
    const nElements = shape ? shape.reduce((a, b) => a * b, 1) : undefined;
    return {
      name,
      path: absPath,
      type: 'dataset',
      shape,
      dtype,
      nElements,
      attrs: safeAttrs(obj),
      chunks: Array.isArray(obj?.chunks) ? obj.chunks : obj?.chunkdims ?? null,
      compression: obj?.compression ?? obj?.filter ?? null,
    };
  }

  // -- Dataset paging / slicing ----------------------------------------------

  /** Resolve a dataset to its displayable 2-D matrix (slicing N-D → 2-D). */
  private datasetMatrix(
    h5file: any,
    path: string,
    sliceIndex: number | null
  ): { matrix: unknown[][]; dtype: string; shape: number[]; viewShape: [number, number]; appliedSlice: number | null } {
    const clean = path.replace(/^\//, '');
    let obj: any = null;
    try {
      obj = clean === '' ? h5file : h5file.get(clean);
    } catch (err) {
      throw new Error(`Cannot open dataset "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!obj || !('value' in obj)) {
      throw new Error(`"${path}" is not a dataset (or jsfive cannot expose its value).`);
    }

    const shape = inferShape(obj) ?? [];
    const dtype = inferDtype(obj);
    const rank = shape.length;

    // Normalize to a 2-D view: 0-D → 1x1, 1-D → Nx1, 2-D → as-is, N-D → slice axis-0.
    let matrix: unknown[][];
    let viewShape: [number, number];
    let appliedSlice: number | null = null;

    if (rank === 0) {
      // jsfive exposes scalar values as single-element arrays (e.g. [0.75]).
      const scalar = Array.isArray(obj.value) && obj.value.length === 1 ? obj.value[0] : obj.value;
      matrix = [[toCell(scalar)]];
      viewShape = [1, 1];
    } else if (rank === 1) {
      const arr = toArray1D(obj.value);
      matrix = arr.map((v) => [toCell(v)]);
      viewShape = [arr.length, 1];
    } else if (rank === 2) {
      matrix = toMatrix2D(obj.value, shape[0], shape[1]);
      viewShape = [shape[0], shape[1]];
    } else {
      const dim0 = shape[0];
      const idx = sliceIndex == null ? 0 : Math.min(Math.max(0, sliceIndex), dim0 - 1);
      appliedSlice = idx;
      const sliced = sliceFirstAxis(obj.value, idx, shape);
      const rest = shape.slice(1);
      if (rest.length === 1) {
        const arr = toArray1D(sliced);
        matrix = arr.map((v) => [toCell(v)]);
        viewShape = [rest[0], 1];
      } else {
        // Collapse remaining rank to 2-D by taking [ :, : ] of the first two axes
        // (deeper axes flattened into columns would explode; show first 2-D plane).
        matrix = toMatrix2D(sliced, rest[0], rest[1]);
        viewShape = [rest[0], rest[1]];
      }
    }
    return { matrix, dtype, shape, viewShape, appliedSlice };
  }

  private pageDataset(h5file: any, path: string, sliceIndex: number | null, page: number, pageSize: number): DatasetPage {
    const { matrix, dtype, shape, viewShape, appliedSlice } = this.datasetMatrix(h5file, path, sliceIndex);

    page = Math.max(0, Math.floor(page));
    pageSize = Math.min(500, Math.max(10, Math.floor(pageSize)));

    const totalRows = matrix.length;
    const totalCols = totalRows > 0 ? matrix[0].length : 0;
    const start = page * pageSize;
    const end = Math.min(start + pageSize, totalRows);
    // Enforce cell cap: shrink page if needed.
    let rows = matrix.slice(start, end);
    let truncated = end < totalRows;
    if (rows.length * Math.max(1, totalCols) > MAX_CELLS_PER_RESPONSE) {
      const maxRows = Math.max(1, Math.floor(MAX_CELLS_PER_RESPONSE / Math.max(1, totalCols)));
      rows = matrix.slice(start, start + maxRows);
      truncated = start + maxRows < totalRows;
    }
    return { path, dtype, shape, viewShape, sliceIndex: appliedSlice, page, pageSize, totalRows, totalCols, rows, truncated };
  }
}

// ---------------------------------------------------------------------------
// jsfive introspection helpers (defensive: API surface varies by version)
// ---------------------------------------------------------------------------

function safeAttrs(obj: any): Record<string, unknown> {
  try {
    const a = obj?.attrs;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a)) {
        out[k] = toCell(v);
      }
      return out;
    }
  } catch {
    // ignore
  }
  return {};
}

function inferDtype(obj: any): string {
  const d = obj?.dtype;
  if (typeof d === 'string') {
    return d;
  }
  if (d && typeof d === 'object') {
    // jsfive/pako dtype objects sometimes look like { '<u4': ... } or have .name
    if (typeof (d as any).name === 'string') {
      return (d as any).name;
    }
    const keys = Object.keys(d);
    if (keys.length === 1) {
      return keys[0];
    }
    return JSON.stringify(d).slice(0, 80);
  }
  const v = obj?.value;
  if (typeof v === 'string') {
    return 'string';
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? 'int' : 'float';
  }
  if (ArrayBuffer.isView(v)) {
    return (v as any).constructor?.name ?? 'array';
  }
  if (Array.isArray(v)) {
    const flat = flattenFirst(v, 50);
    const t = typeof flat;
    return t === 'number' ? (Number.isInteger(flat as number) ? 'int' : 'float') : t;
  }
  return 'unknown';
}

function inferShape(obj: any): number[] | undefined {
  const s = obj?.shape;
  if (Array.isArray(s) && s.every((n) => typeof n === 'number')) {
    return [...s];
  }
  if (typeof s === 'number') {
    return [s];
  }
  const v = obj?.value;
  if (v == null) {
    return undefined;
  }
  if (ArrayBuffer.isView(v)) {
    return [(v as unknown as ArrayLike<unknown>).length];
  }
  if (Array.isArray(v)) {
    return shapeOfNested(v);
  }
  return []; // scalar
}

function shapeOfNested(arr: unknown[]): number[] {
  const shape: number[] = [];
  let cur: unknown = arr;
  const seen = new Set<unknown>();
  while (Array.isArray(cur)) {
    if (seen.has(cur)) {
      break;
    }
    seen.add(cur);
    shape.push(cur.length);
    cur = cur.length > 0 ? cur[0] : undefined;
  }
  return shape;
}

function flattenFirst(arr: unknown[], limit: number): unknown {
  const stack: unknown[] = [...arr];
  let count = 0;
  while (stack.length && count < limit) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      stack.push(...v);
    } else {
      return v;
    }
    count++;
  }
  return undefined;
}

function toCell(v: unknown): unknown {
  if (typeof v === 'bigint') {
    // JSON-safe: big ints exceed Number.MAX_SAFE_INTEGER.
    return `${v.toString()}n`;
  }
  if (typeof v === 'string') {
    // Fixed-length HDF5 strings ("S5") arrive NUL-padded ("beta\0").
    return v.replace(/\0+$/g, '');
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : String(v);
  }
  if (v instanceof Uint8Array || (ArrayBuffer.isView(v) && !(v instanceof DataView))) {
    // Small typed arrays (e.g. attribute vectors) → plain arrays.
    const arr = Array.from(v as unknown as ArrayLike<number>);
    return arr.length <= 32 ? arr : `[${(v as any).constructor?.name ?? 'TypedArray'} len=${arr.length}]`;
  }
  if (Array.isArray(v)) {
    return v.length <= 8 && v.every((x) => typeof x !== 'object') ? v.map(toCell) : `[array len=${v.length}]`;
  }
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v).slice(0, 200);
    } catch {
      return String(v);
    }
  }
  return v as string | number | boolean | null;
}

function toArray1D(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<unknown>);
  }
  return [value];
}

function toMatrix2D(value: unknown, rows: number, cols: number): unknown[][] {
  // Case A: nested arrays (jsfive sometimes returns these).
  if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
    const out: unknown[][] = [];
    for (let r = 0; r < Math.min(rows, value.length); r++) {
      const row = value[r] as unknown[];
      const cells: unknown[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(toCell(row[c]));
      }
      out.push(cells);
    }
    return out;
  }
  // Case B: flat row-major array (plain JS array, the common jsfive shape for N-D).
  if (Array.isArray(value)) {
    const out: unknown[][] = [];
    for (let r = 0; r < rows; r++) {
      const cells: unknown[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(toCell(value[r * cols + c]));
      }
      out.push(cells);
    }
    return out;
  }
  // Case C: flat TypedArray row-major.
  if (ArrayBuffer.isView(value)) {
    const flat = value as unknown as ArrayLike<unknown>;
    const out: unknown[][] = [];
    for (let r = 0; r < rows; r++) {
      const cells: unknown[] = [];
      for (let c = 0; c < cols; c++) {
        cells.push(toCell(flat[r * cols + c]));
      }
      out.push(cells);
    }
    return out;
  }
  return [[toCell(value)]];
}

/**
 * Index the first axis of a nested-array, flat-array, or flat TypedArray value.
 * `shape` is the full N-D shape (rank >= 3); slicing returns the axis-0 plane
 * as a flat array of length prod(shape[1:]).
 */
function sliceFirstAxis(value: unknown, idx: number, shape: number[]): unknown {
  const planeSize = shape.slice(1).reduce((a, b) => a * b, 1);
  const safe = Math.min(Math.max(0, idx), Math.max(0, shape[0] - 1));
  if (Array.isArray(value)) {
    if (value.length > 0 && Array.isArray(value[0])) {
      return value[Math.min(safe, value.length - 1)];
    }
    // Flat plain array: carve out the plane row-major.
    return value.slice(safe * planeSize, (safe + 1) * planeSize);
  }
  if (ArrayBuffer.isView(value)) {
    const flat = value as unknown as ArrayLike<unknown>;
    const out: unknown[] = [];
    for (let i = 0; i < planeSize; i++) {
      out.push(flat[safe * planeSize + i]);
    }
    return out;
  }
  return value;
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** Quote a cell for CSV output (RFC 4180). */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
