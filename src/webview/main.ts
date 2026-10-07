// H5 Viewer — webview frontend (no external deps, CSP-safe).
// Message protocol mirrors src/hdf5EditorProvider.ts.

interface H5NodeInfo {
  name: string;
  path: string;
  type: 'group' | 'dataset';
  children?: H5NodeInfo[];
  shape?: number[];
  dtype?: string;
  nElements?: number;
  attrs?: Record<string, unknown>;
  chunks?: number[] | null;
  compression?: string | null;
}

interface DatasetPage {
  path: string;
  dtype: string;
  shape: number[];
  viewShape: [number, number];
  sliceIndex: number | null;
  page: number;
  pageSize: number;
  totalRows: number;
  totalCols: number;
  rows: unknown[][];
  truncated: boolean;
}

type ToExtension =
  | { type: 'ready' }
  | { type: 'getTree' }
  | { type: 'getDataset'; path: string; sliceIndex?: number | null; page?: number; pageSize?: number }
  | { type: 'copyText'; text: string }
  | { type: 'exportCsv'; path: string; sliceIndex?: number | null };

type FromExtension =
  | { type: 'tree'; fileName: string; fileSize: number; root: H5NodeInfo }
  | { type: 'dataset'; data: DatasetPage }
  | { type: 'error'; message: string };

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();

const state = {
  root: null as H5NodeInfo | null,
  fileName: '',
  fileSize: 0,
  filter: '',
  collapsed: new Set<string>(),
  selectedPath: null as string | null,
  selectedNode: null as H5NodeInfo | null,
  dataset: null as DatasetPage | null,
  loadingDataset: false,
  pageSize: 100,
  sliceIndex: 0,
  showChart: true,
  valueFilter: '',
};

const app = document.getElementById('app') as HTMLElement;

window.addEventListener('message', (event: MessageEvent<FromExtension>) => {
  const msg = event.data;
  if (!msg || typeof (msg as { type?: unknown }).type !== 'string') {
    return;
  }
  switch (msg.type) {
    case 'tree':
      state.root = msg.root;
      state.fileName = msg.fileName;
      state.fileSize = msg.fileSize;
      render();
      break;
    case 'dataset':
      state.dataset = msg.data;
      state.loadingDataset = false;
      state.sliceIndex = msg.data.sliceIndex ?? state.sliceIndex;
      render();
      drawPreview();
      break;
    case 'error':
      state.loadingDataset = false;
      renderError(msg.message);
      break;
  }
});

function request(msg: ToExtension): void {
  vscode.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Inline SVG icons (theme-aware via currentColor, no external assets)
// ---------------------------------------------------------------------------

const ICONS: Record<string, string> = {
  folder: '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M1.5 2.5c0-.83.67-1.5 1.5-1.5h3l1.2 1.5h5.3c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5h-10c-.83 0-1.5-.67-1.5-1.5v-8.5z" opacity=".95"/></svg>',
  dataset: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><line x1="1.5" y1="6" x2="14.5" y2="6"/><line x1="1.5" y1="9.7" x2="14.5" y2="9.7"/><line x1="6" y1="2.5" x2="6" y2="13.5"/><line x1="10.2" y1="2.5" x2="10.2" y2="13.5"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5c0 .83-.67 1.5-1.5 1.5h-7C3.67 16 3 15.33 3 14.5v-11.5c0-.83.67-1.5 1-1.5z"/></svg>',
  scalar: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3"/></svg>',
  expand: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>',
  collapse: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 2H2v4M14 6h-4M10 14h4v-4M2 10h4"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 2v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/></svg>',
  chart: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 14V8M6.5 14V4.5M11 14v-6M15 14V2"/></svg>',
};

function iconEl(kind: 'group' | 'dataset' | 'file' | 'scalar', label: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'icon icon-' + kind;
  s.title = label;
  const key = kind === 'group' ? 'folder' : kind === 'dataset' ? 'dataset' : kind === 'scalar' ? 'scalar' : 'file';
  s.innerHTML = ICONS[key];
  return s;
}

function btnIcon(svgKey: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn';
  b.title = title;
  const ic = document.createElement('span');
  ic.className = 'btn-ic';
  ic.innerHTML = ICONS[svgKey];
  b.appendChild(ic);
  const t = document.createElement('span');
  t.textContent = text;
  b.appendChild(t);
  return b;
}

// ---------------------------------------------------------------------------
// Rendering shell
// ---------------------------------------------------------------------------

function render(): void {
  app.innerHTML = '';
  app.appendChild(buildToolbar());
  const layout = document.createElement('div');
  layout.className = 'layout';
  const left = buildLeftPane();
  layout.appendChild(left);
  layout.appendChild(buildRightPane());
  app.appendChild(layout);
  app.appendChild(buildFooter());
  const toastHost = document.createElement('div');
  toastHost.id = 'toast-host';
  app.appendChild(toastHost);
}

function renderError(message: string): void {
  app.innerHTML = '';
  app.appendChild(buildToolbar());
  const div = document.createElement('div');
  div.className = 'error';
  div.textContent = `Could not open HDF5 file: ${message}`;
  app.appendChild(div);
}

let toastTimer = 0;
function toast(message: string): void {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    app.appendChild(host);
  }
  host.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    host.innerHTML = '';
  }, 2200);
}

function copyText(text: string, label: string): void {
  request({ type: 'copyText', text });
  toast(`${label} copied to clipboard`);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function buildToolbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  const badge = document.createElement('span');
  badge.className = 'file-badge';
  const fic = document.createElement('span');
  fic.className = 'icon icon-file';
  fic.innerHTML = ICONS.file;
  badge.appendChild(fic);
  const name = document.createElement('span');
  name.textContent = state.fileName || 'HDF5 Inspector';
  name.title = state.fileName;
  badge.appendChild(name);
  bar.appendChild(badge);
  if (state.fileSize > 0) {
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = formatBytes(state.fileSize);
    bar.appendChild(size);
  }
  const spacer = document.createElement('span');
  spacer.className = 'toolbar-spacer';
  bar.appendChild(spacer);

  const expandAll = btnIcon('expand', 'Expand', 'Expand all groups');
  expandAll.addEventListener('click', () => {
    state.collapsed.clear();
    patchTreeOnly();
  });
  const collapseAll = btnIcon('collapse', 'Collapse', 'Collapse all groups');
  collapseAll.addEventListener('click', () => {
    collectGroupPaths(state.root).forEach((p) => state.collapsed.add(p));
    patchTreeOnly();
  });
  const refresh = btnIcon('refresh', 'Reload', 'Re-read file structure');
  refresh.addEventListener('click', () => request({ type: 'getTree' }));
  bar.appendChild(expandAll);
  bar.appendChild(collapseAll);
  bar.appendChild(refresh);

  const searchWrap = document.createElement('span');
  searchWrap.className = 'search-wrap';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Filter nodes…';
  search.value = state.filter;
  search.setAttribute('aria-label', 'Filter tree nodes');
  search.addEventListener('input', () => {
    state.filter = search.value;
    if (state.filter.trim()) {
      // Auto-expand so matches are visible.
      state.collapsed.clear();
    }
    patchTreeOnly();
  });
  searchWrap.appendChild(search);
  bar.appendChild(searchWrap);
  return bar;
}

function collectGroupPaths(root: H5NodeInfo | null): string[] {
  const out: string[] = [];
  if (!root) {
    return out;
  }
  const stack: H5NodeInfo[] = [...(root.children ?? [])];
  while (stack.length) {
    const n = stack.pop() as H5NodeInfo;
    if (n.type === 'group') {
      out.push(n.path);
      stack.push(...(n.children ?? []));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Left pane: tree
// ---------------------------------------------------------------------------

function buildLeftPane(): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'pane-left';
  const head = document.createElement('div');
  head.className = 'pane-head';
  const counts = state.root ? `${countGroups(state.root)} groups · ${countDatasets(state.root)} datasets` : 'Loading…';
  head.textContent = counts;
  pane.appendChild(head);
  const host = document.createElement('div');
  host.id = 'tree-host';
  host.setAttribute('role', 'tree');
  host.tabIndex = 0;
  host.setAttribute('aria-label', 'HDF5 object tree. Arrow keys navigate, Enter opens.');
  host.addEventListener('keydown', onTreeKey);
  host.appendChild(buildTreeDom());
  pane.appendChild(host);
  return pane;
}

function patchTreeOnly(): void {
  const host = document.getElementById('tree-host');
  if (!host) {
    render();
    return;
  }
  host.innerHTML = '';
  host.appendChild(buildTreeDom());
  const head = document.querySelector('.pane-left .pane-head');
  if (head && state.root) {
    head.textContent = `${countGroups(state.root)} groups · ${countDatasets(state.root)} datasets`;
  }
}

function nodeMatches(node: H5NodeInfo, q: string): boolean {
  if (!q) {
    return true;
  }
  if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
    return true;
  }
  return (node.children ?? []).some((c) => nodeMatches(c, q));
}

function buildTreeDom(): HTMLElement {
  const wrap = document.createElement('div');
  if (!state.root) {
    const s = document.createElement('div');
    s.className = 'status';
    s.textContent = 'Loading HDF5 structure…';
    wrap.appendChild(s);
    return wrap;
  }
  const q = state.filter.trim().toLowerCase();
  const frag = document.createElement('div');
  for (const child of state.root.children ?? []) {
    if (nodeMatches(child, q)) {
      frag.appendChild(treeNodeEl(child, q));
    }
  }
  if (!frag.hasChildNodes()) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = q ? `No nodes match "${state.filter}".` : 'File has no top-level objects.';
    wrap.appendChild(empty);
    return wrap;
  }
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row' + (state.selectedPath === '/' ? ' selected' : '');
  rootRow.setAttribute('role', 'treeitem');
  rootRow.dataset.path = '/';
  rootRow.appendChild(iconEl('group', 'root group'));
  const nm = document.createElement('span');
  nm.className = 'node-name';
  nm.textContent = '/ (root)';
  rootRow.appendChild(nm);
  rootRow.addEventListener('click', () => selectNode(state.root as H5NodeInfo));
  wrap.appendChild(rootRow);
  wrap.appendChild(frag);
  return wrap;
}

function datasetKind(node: H5NodeInfo): 'dataset' | 'scalar' {
  const rank = node.shape?.length ?? -1;
  return rank === 0 ? 'scalar' : 'dataset';
}

function treeNodeEl(node: H5NodeInfo, q: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row' + (state.selectedPath === node.path ? ' selected' : '');
  row.setAttribute('role', 'treeitem');
  row.dataset.path = node.path;
  const kids = node.type === 'group' ? (node.children ?? []).filter((c) => nodeMatches(c, q)) : [];
  const open = !state.collapsed.has(node.path);
  if (node.type === 'group') {
    const t = document.createElement('span');
    t.className = 'twisty' + (open ? ' open' : '');
    t.textContent = '▸';
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(node.path);
    });
    row.appendChild(t);
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'twisty leaf';
    spacer.textContent = '·';
    row.appendChild(spacer);
  }
  row.appendChild(iconEl(node.type === 'group' ? 'group' : datasetKind(node), node.type));
  const nm = document.createElement('span');
  nm.className = 'node-name';
  nm.textContent = node.name;
  nm.title = node.path;
  row.appendChild(nm);
  if (node.type === 'dataset') {
    const meta = document.createElement('span');
    meta.className = 'node-meta';
    meta.textContent = node.shape ? `[${node.shape.join('×') || 'scalar'}]` : '';
    row.appendChild(meta);
    if (node.dtype) {
      const dt = document.createElement('span');
      dt.className = 'node-dtype';
      dt.textContent = node.dtype;
      row.appendChild(dt);
    }
  } else if (kids.length > 0) {
    const count = document.createElement('span');
    count.className = 'node-meta';
    count.textContent = String(kids.length);
    row.appendChild(count);
  }
  row.addEventListener('click', () => {
    if (node.type === 'group' && state.collapsed.has(node.path)) {
      state.collapsed.delete(node.path);
      patchTreeOnly();
    }
    selectNode(node);
  });
  box.appendChild(row);
  if (node.type === 'group' && kids.length > 0) {
    const childBox = document.createElement('div');
    childBox.className = 'tree-children' + (open ? '' : ' collapsed');
    childBox.setAttribute('role', 'group');
    for (const c of kids) {
      childBox.appendChild(treeNodeEl(c, q));
    }
    box.appendChild(childBox);
  }
  return box;
}

function toggleCollapse(path: string): void {
  if (state.collapsed.has(path)) {
    state.collapsed.delete(path);
  } else {
    state.collapsed.add(path);
  }
  patchTreeOnly();
}

/** Flat list of visible tree rows for keyboard navigation. */
function visiblePaths(): string[] {
  const host = document.getElementById('tree-host');
  if (!host) {
    return [];
  }
  return Array.from(host.querySelectorAll('.tree-row')).map((el) => (el as HTMLElement).dataset.path ?? '');
}

function onTreeKey(e: KeyboardEvent): void {
  const paths = visiblePaths();
  if (paths.length === 0) {
    return;
  }
  let idx = paths.indexOf(state.selectedPath ?? '');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    idx = idx < 0 ? 0 : (idx + (e.key === 'ArrowDown' ? 1 : -1) + paths.length) % paths.length;
    const node = findNode(state.root, paths[idx]);
    if (node) {
      selectNode(node);
      focusRow(paths[idx]);
    }
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const node = state.selectedNode;
    if (node && node.type === 'group') {
      e.preventDefault();
      const isCollapsed = state.collapsed.has(node.path);
      if (e.key === 'ArrowRight' && isCollapsed) {
        toggleCollapse(node.path);
      } else if (e.key === 'ArrowLeft' && !isCollapsed) {
        toggleCollapse(node.path);
      }
      focusRow(node.path);
    }
  } else if (e.key === 'Enter') {
    const node = state.selectedNode;
    if (node && node.type === 'group') {
      toggleCollapse(node.path);
      focusRow(node.path);
    }
  }
}

function focusRow(path: string): void {
  const host = document.getElementById('tree-host');
  const row = host?.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`) as HTMLElement | null;
  row?.scrollIntoView({ block: 'nearest' });
}

function selectNode(node: H5NodeInfo): void {
  state.selectedPath = node.path;
  state.selectedNode = node;
  state.dataset = null;
  state.valueFilter = '';
  state.loadingDataset = node.type === 'dataset';
  if (node.type === 'dataset') {
    state.sliceIndex = 0;
    request({ type: 'getDataset', path: node.path, sliceIndex: 0, page: 0, pageSize: state.pageSize });
  }
  render();
  drawPreview();
}

function findNode(root: H5NodeInfo | null, path: string | null): H5NodeInfo | null {
  if (!root || path == null) {
    return null;
  }
  if (path === '/') {
    return root;
  }
  const stack: H5NodeInfo[] = [...(root.children ?? [])];
  while (stack.length) {
    const n = stack.pop() as H5NodeInfo;
    if (n.path === path) {
      return n;
    }
    if (n.type === 'group') {
      stack.push(...(n.children ?? []));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Right pane
// ---------------------------------------------------------------------------

function buildRightPane(): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'pane-right';
  const node = state.selectedNode;
  if (!node) {
    const hero = document.createElement('div');
    hero.className = 'hero';
    const h = document.createElement('h2');
    h.textContent = state.root ? 'Select an object to inspect' : 'Loading…';
    hero.appendChild(h);
    if (state.root) {
      const p = document.createElement('p');
      p.textContent = `${countDatasets(state.root)} dataset(s) and ${countGroups(state.root)} group(s) in this file. Use the filter box to find nodes, arrow keys to navigate.`;
      hero.appendChild(p);
    }
    pane.appendChild(hero);
    return pane;
  }
  pane.appendChild(buildBreadcrumbs(node));
  pane.appendChild(buildMetaCard(node));
  if (node.type === 'group') {
    pane.appendChild(buildGroupTable(node));
  } else {
    pane.appendChild(buildDatasetControls(node));
    const tableHost = document.createElement('div');
    tableHost.id = 'table-host';
    tableHost.appendChild(buildDataTable());
    pane.appendChild(tableHost);
    pane.appendChild(buildChartBlock());
  }
  return pane;
}

function buildBreadcrumbs(node: H5NodeInfo): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'crumbs';
  nav.setAttribute('aria-label', 'HDF5 path');
  const segs = node.path.split('/').filter((s) => s.length > 0);
  const rootBtn = document.createElement('button');
  rootBtn.className = 'crumb';
  rootBtn.textContent = '/';
  rootBtn.title = 'Go to root';
  rootBtn.addEventListener('click', () => {
    const r = findNode(state.root, '/');
    if (r) {
      selectNode(r);
    }
  });
  nav.appendChild(rootBtn);
  let acc = '';
  segs.forEach((seg, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    nav.appendChild(sep);
    acc += '/' + seg;
    const at = acc;
    const isLast = i === segs.length - 1;
    if (isLast) {
      const cur = document.createElement('span');
      cur.className = 'crumb current';
      cur.textContent = seg;
      nav.appendChild(cur);
    } else {
      const b = document.createElement('button');
      b.className = 'crumb';
      b.textContent = seg;
      b.addEventListener('click', () => {
        const n = findNode(state.root, at);
        if (n) {
          selectNode(n);
        }
      });
      nav.appendChild(b);
    }
  });
  return nav;
}

function buildMetaCard(node: H5NodeInfo): HTMLElement {
  const card = document.createElement('div');
  card.className = 'meta-card';
  const head = document.createElement('div');
  head.className = 'meta-head';
  const h = document.createElement('h2');
  h.textContent = node.path;
  head.appendChild(h);
  const actions = document.createElement('div');
  actions.className = 'meta-actions';
  const copyBtn = btnIcon('copy', 'Copy path', 'Copy HDF5 path to clipboard');
  copyBtn.addEventListener('click', () => copyText(node.path, 'Path'));
  actions.appendChild(copyBtn);
  if (node.type === 'dataset') {
    const expBtn = btnIcon('download', 'Export CSV', 'Export current view to CSV');
    expBtn.addEventListener('click', () => {
      request({ type: 'exportCsv', path: node.path, sliceIndex: state.sliceIndex });
      toast('Choose a location in the save dialog…');
    });
    actions.appendChild(expBtn);
  }
  head.appendChild(actions);
  card.appendChild(head);

  const dl = document.createElement('dl');
  dl.className = 'meta-grid';
  const isScalar = node.type === 'dataset' && (node.shape?.length ?? -1) === 0;
  const rows: Array<[string, string, string?]> = [
    ['Type', node.type === 'group' ? 'Group' : isScalar ? 'Dataset (scalar)' : 'Dataset', node.type],
    ['Datatype', node.dtype ?? (node.type === 'group' ? '—' : 'unknown')],
    ['Shape', node.shape ? (node.shape.length === 0 ? 'scalar' : `[${node.shape.join(', ')}] · rank ${node.shape.length}`) : node.type === 'group' ? '—' : 'unknown'],
    ['Elements', node.nElements != null ? node.nElements.toLocaleString() : '—'],
    ['Chunking', node.chunks ? `[${node.chunks.join(', ')}]` : 'contiguous / n/a'],
    ['Compression', node.compression ? String(node.compression) : 'none / n/a'],
  ];
  if (state.dataset) {
    rows.push(['View', `${state.dataset.viewShape[0].toLocaleString()} rows × ${state.dataset.viewShape[1].toLocaleString()} cols${state.dataset.sliceIndex != null ? ` · slice [${state.dataset.sliceIndex}, :, :]` : ''}`]);
  }
  for (const [k, v, tag] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (k === 'Type' && tag) {
      const pill = document.createElement('span');
      pill.className = 'pill pill-' + tag;
      pill.textContent = v;
      dd.appendChild(pill);
    } else {
      dd.textContent = v;
      dd.className = 'mono';
    }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  card.appendChild(dl);

  const attrs = node.attrs ?? {};
  const keys = Object.keys(attrs);
  if (keys.length > 0) {
    const h3 = document.createElement('h3');
    h3.className = 'attrs-head';
    h3.textContent = `Attributes (${keys.length})`;
    card.appendChild(h3);
    const t = document.createElement('table');
    t.className = 'attrs-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const col of ['Key', 'Value']) {
      const th = document.createElement('th');
      th.textContent = col;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    t.appendChild(thead);
    const tb = document.createElement('tbody');
    for (const k of keys.slice(0, 200)) {
      const tr = document.createElement('tr');
      const tdK = document.createElement('td');
      tdK.textContent = k;
      tdK.className = 'mono';
      const tdV = document.createElement('td');
      tdV.textContent = stringifyCell(attrs[k]);
      tdV.title = 'Click to copy';
      tdV.className = 'copyable mono';
      tdV.addEventListener('click', () => copyText(stringifyCell(attrs[k]), `Attribute "${k}"`));
      tr.appendChild(tdK);
      tr.appendChild(tdV);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    card.appendChild(t);
    if (keys.length > 200) {
      const more = document.createElement('div');
      more.className = 'chart-caption';
      more.textContent = `… and ${keys.length - 200} more attributes (truncated).`;
      card.appendChild(more);
    }
  }
  return card;
}

function buildGroupTable(node: H5NodeInfo): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'group-wrap';
  const kids = node.children ?? [];
  const h = document.createElement('h3');
  h.className = 'section-title';
  h.textContent = kids.length === 0 ? 'Empty group' : `Members (${kids.length})`;
  wrap.appendChild(h);
  if (kids.length === 0) {
    return wrap;
  }
  const t = document.createElement('table');
  t.className = 'member-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const col of ['Name', 'Type', 'Shape', 'Datatype']) {
    const th = document.createElement('th');
    th.textContent = col;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);
  const tb = document.createElement('tbody');
  for (const c of kids) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.title = `Open ${c.path}`;
    const tdN = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'member-name';
    chip.appendChild(iconEl(c.type === 'group' ? 'group' : datasetKind(c), c.type));
    const nm = document.createElement('span');
    nm.textContent = c.name;
    chip.appendChild(nm);
    tdN.appendChild(chip);
    const tdT = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill pill-' + c.type;
    pill.textContent = c.type;
    tdT.appendChild(pill);
    const tdS = document.createElement('td');
    tdS.className = 'mono';
    tdS.textContent = c.type === 'group' ? `${(c.children ?? []).length} members` : c.shape ? (c.shape.length === 0 ? 'scalar' : `[${c.shape.join('×')}]`) : '—';
    const tdD = document.createElement('td');
    tdD.className = 'mono';
    tdD.textContent = c.dtype ?? '—';
    tr.appendChild(tdN);
    tr.appendChild(tdT);
    tr.appendChild(tdS);
    tr.appendChild(tdD);
    tr.addEventListener('click', () => selectNode(c));
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  wrap.appendChild(t);
  return wrap;
}

// ---------------------------------------------------------------------------
// Dataset controls + table
// ---------------------------------------------------------------------------

function buildDatasetControls(node: H5NodeInfo): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'controls card';
  const rank = node.shape?.length ?? 0;

  if (rank >= 3 && node.shape) {
    const dim0 = node.shape[0];
    const sliceBox = document.createElement('label');
    sliceBox.className = 'slice-box';
    const lab = document.createElement('span');
    lab.textContent = `Slice [i, :, :] · i = ${state.sliceIndex} / ${dim0 - 1}`;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(Math.max(0, dim0 - 1));
    slider.step = '1';
    slider.value = String(state.sliceIndex);
    slider.setAttribute('aria-label', 'Slice index along first axis');
    slider.addEventListener('change', () => {
      state.sliceIndex = parseInt(slider.value, 10) || 0;
      requestDatasetPage(0);
    });
    sliceBox.appendChild(slider);
    sliceBox.appendChild(lab);
    wrap.appendChild(sliceBox);
    const num = document.createElement('input');
    num.type = 'number';
    num.min = '0';
    num.max = String(Math.max(0, dim0 - 1));
    num.value = String(state.sliceIndex);
    num.className = 'slice-num';
    num.setAttribute('aria-label', 'Slice index number');
    num.addEventListener('change', () => {
      state.sliceIndex = Math.min(Math.max(0, parseInt(num.value, 10) || 0), Math.max(0, dim0 - 1));
      requestDatasetPage(0);
    });
    wrap.appendChild(num);
  }

  const filter = document.createElement('input');
  filter.type = 'search';
  filter.className = 'value-filter';
  filter.placeholder = 'Filter values in page…';
  filter.value = state.valueFilter;
  filter.setAttribute('aria-label', 'Filter values in current page');
  filter.addEventListener('input', () => {
    state.valueFilter = filter.value;
    patchTableOnly();
  });
  wrap.appendChild(filter);

  const sizeLabel = document.createElement('label');
  sizeLabel.className = 'rows-label';
  sizeLabel.textContent = 'Rows/page ';
  const sizeSel = document.createElement('select');
  for (const n of [50, 100, 200, 500]) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = String(n);
    if (n === state.pageSize) {
      opt.selected = true;
    }
    sizeSel.appendChild(opt);
  }
  sizeSel.addEventListener('change', () => {
    state.pageSize = parseInt(sizeSel.value, 10) || 100;
    requestDatasetPage(0);
  });
  sizeLabel.appendChild(sizeSel);
  wrap.appendChild(sizeLabel);

  const chartBtn = btnIcon('chart', state.showChart ? 'Hide preview' : 'Preview', state.showChart ? 'Hide chart preview' : 'Show chart preview');
  chartBtn.addEventListener('click', () => {
    state.showChart = !state.showChart;
    render();
    drawPreview();
  });
  wrap.appendChild(chartBtn);

  const d = state.dataset;
  if (d) {
    const pages = Math.max(1, Math.ceil(d.totalRows / state.pageSize));
    const pager = document.createElement('span');
    pager.className = 'pager';
    const prev = document.createElement('button');
    prev.className = 'btn';
    prev.textContent = '‹ Prev';
    prev.disabled = d.page <= 0;
    prev.addEventListener('click', () => requestDatasetPage(d.page - 1));
    const next = document.createElement('button');
    next.className = 'btn';
    next.textContent = 'Next ›';
    next.disabled = (d.page + 1) * state.pageSize >= d.totalRows;
    next.addEventListener('click', () => requestDatasetPage(d.page + 1));
    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = `Page ${d.page + 1}/${pages} · ${d.totalRows.toLocaleString()}×${d.totalCols.toLocaleString()}${d.truncated ? ' · truncated' : ''}`;
    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
    wrap.appendChild(pager);
  }
  return wrap;
}

function requestDatasetPage(page: number): void {
  if (!state.selectedNode || state.selectedPath == null) {
    return;
  }
  state.loadingDataset = true;
  patchTableOnly();
  request({ type: 'getDataset', path: state.selectedPath, sliceIndex: state.sliceIndex, page, pageSize: state.pageSize });
}

function filteredRows(d: DatasetPage): { rows: unknown[][]; base: number[] } {
  const q = state.valueFilter.trim().toLowerCase();
  const base = d.page * d.pageSize;
  if (!q) {
    return { rows: d.rows, base: d.rows.map((_, i) => base + i) };
  }
  const rows: unknown[][] = [];
  const idx: number[] = [];
  d.rows.forEach((r, i) => {
    if (r.some((c) => stringifyCell(c).toLowerCase().includes(q))) {
      rows.push(r);
      idx.push(base + i);
    }
  });
  return { rows, base: idx };
}

function patchTableOnly(): void {
  const host = document.getElementById('table-host');
  if (!host) {
    return;
  }
  host.innerHTML = '';
  host.appendChild(buildDataTable());
}

function buildDataTable(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.id = 'table-host-inner';
  const d = state.dataset;
  if (state.loadingDataset || !d) {
    wrap.appendChild(skeleton());
    return wrap;
  }
  if (d.totalRows === 0 || d.totalCols === 0) {
    const s = document.createElement('div');
    s.className = 'status';
    s.textContent = 'Empty dataset (0 rows or 0 columns).';
    wrap.appendChild(s);
    return wrap;
  }
  const { rows, base } = filteredRows(d);
  if (rows.length === 0) {
    const s = document.createElement('div');
    s.className = 'status';
    s.textContent = `No values in this page match "${state.valueFilter}".`;
    wrap.appendChild(s);
    return wrap;
  }
  const scroller = document.createElement('div');
  scroller.className = 'data-table-wrap';
  const table = document.createElement('table');
  table.className = 'data';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'rowh';
  corner.textContent = '#';
  hr.appendChild(corner);
  for (let c = 0; c < d.totalCols; c++) {
    const th = document.createElement('th');
    th.textContent = `c${c}`;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = document.createElement('tbody');
  for (let r = 0; r < rows.length; r++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('th');
    rh.className = 'rowh';
    rh.textContent = String(base[r]);
    tr.appendChild(rh);
    const row = rows[r] ?? [];
    for (let c = 0; c < d.totalCols; c++) {
      const td = document.createElement('td');
      const txt = stringifyCell(row[c]);
      td.textContent = txt;
      td.title = txt + ' (click to copy)';
      td.className = isNumericCell(row[c]) ? 'num' : '';
      td.addEventListener('click', () => copyText(txt, 'Cell value'));
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  if (state.valueFilter.trim()) {
    const note = document.createElement('div');
    note.className = 'chart-caption';
    note.textContent = `Showing ${rows.length} of ${d.rows.length} rows in page (filtered).`;
    wrap.appendChild(note);
  }
  return wrap;
}

function skeleton(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'skeleton';
  s.setAttribute('aria-label', 'Loading dataset values');
  for (let i = 0; i < 8; i++) {
    const bar = document.createElement('div');
    bar.className = 'sk-bar';
    bar.style.width = `${92 - i * 4}%`;
    s.appendChild(bar);
  }
  return s;
}

function buildChartBlock(): HTMLElement {
  const wrap = document.createElement('div');
  if (!state.showChart) {
    return wrap;
  }
  const card = document.createElement('div');
  card.className = 'card chart-card';
  const h = document.createElement('h3');
  h.className = 'section-title';
  h.textContent = 'Preview';
  card.appendChild(h);
  const row = document.createElement('div');
  row.className = 'chart-row';
  const canvas = document.createElement('canvas');
  canvas.id = 'preview-canvas';
  canvas.className = 'preview';
  canvas.width = 560;
  canvas.height = 240;
  row.appendChild(canvas);
  const legend = document.createElement('div');
  legend.className = 'chart-side';
  legend.id = 'preview-caption';
  row.appendChild(legend);
  card.appendChild(row);
  wrap.appendChild(card);
  return wrap;
}

// ---------------------------------------------------------------------------
// Canvas preview (zero-dep): line chart for 1-D, heatmap for 2-D slices
// ---------------------------------------------------------------------------

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function drawPreview(): void {
  const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement | null;
  if (!canvas || !state.dataset || !state.showChart) {
    return;
  }
  const d = state.dataset;
  const cap = document.getElementById('preview-caption');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = cssVar('--vscode-editor-background', '#1e1e1e');
  ctx.fillRect(0, 0, W, H);

  const nums = d.rows.flat().map(toNumber).filter((v) => Number.isFinite(v)) as number[];
  if (nums.length === 0) {
    ctx.fillStyle = '#888';
    ctx.font = '12px sans-serif';
    ctx.fillText('No numeric values in this page (strings?).', 12, 20);
    if (cap) {
      cap.textContent = 'Non-numeric data — chart skipped. Click any cell to copy its value.';
    }
    return;
  }

  if (d.shape.length <= 1 || (d.viewShape[1] === 1 && d.viewShape[0] > 1)) {
    drawLineChart(ctx, nums, W, H);
    if (cap) {
      cap.innerHTML = '';
      const stats = lineStats(nums);
      const ul = document.createElement('ul');
      ul.className = 'stat-list';
      for (const [k, v] of stats) {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = k + ' ';
        li.appendChild(b);
        li.appendChild(document.createTextNode(v));
        ul.appendChild(li);
      }
      const note = document.createElement('div');
      note.className = 'chart-caption';
      note.textContent = `Line chart of first ${nums.length} values (page ${d.page + 1}).`;
      cap.appendChild(ul);
      cap.appendChild(note);
    }
  } else {
    drawHeatmap(ctx, d.rows, W, H);
    if (cap) {
      cap.innerHTML = '';
      const mm = minMax(nums);
      const ul = document.createElement('ul');
      ul.className = 'stat-list';
      for (const [k, v] of [['min', fmt(mm[0])], ['max', fmt(mm[1])], ['mean', fmt(mean(nums))]] as Array<[string, string]>) {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = k + ' ';
        li.appendChild(b);
        li.appendChild(document.createTextNode(v));
        ul.appendChild(li);
      }
      const ramp = document.createElement('div');
      ramp.className = 'ramp';
      ramp.title = 'Grayscale color scale: min (dark) → max (light)';
      const rl = document.createElement('div');
      rl.className = 'chart-caption';
      rl.textContent = `Heatmap ${d.rows.length}×${d.totalCols}${d.sliceIndex != null ? ` · slice ${d.sliceIndex}` : ''}. Dark = min, light = max.`;
      cap.appendChild(ul);
      cap.appendChild(ramp);
      cap.appendChild(rl);
    }
  }
}

function lineStats(vals: number[]): Array<[string, string]> {
  const mm = minMax(vals);
  return [
    ['n', String(vals.length)],
    ['min', fmt(mm[0])],
    ['max', fmt(mm[1])],
    ['mean', fmt(mean(vals))],
  ];
}

function minMax(vals: number[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }
  return [min, max];
}

function mean(vals: number[]): number {
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
}

function drawLineChart(ctx: CanvasRenderingContext2D, vals: number[], W: number, H: number): void {
  const padL = 46;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const [min, max] = minMax(vals);
  const span = max - min || 1;
  const grid = cssVar('--vscode-widget-border', '#555');

  // Gridlines + y ticks.
  ctx.strokeStyle = grid;
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = min + (span * i) / 4;
    const y = H - padB - ((v - min) / span) * (H - padT - padB);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(fmt(v), 4, y + 3);
  }
  // X ticks (index).
  const n = vals.length;
  for (let i = 0; i <= 4; i++) {
    const idx = Math.round((n - 1) * (i / 4));
    const x = padL + (idx / Math.max(1, n - 1)) * (W - padL - padR);
    ctx.fillText(String(idx), x - 6, H - 8);
  }

  ctx.strokeStyle = cssVar('--vscode-charts-blue', '#4aa3ff');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
    const y = H - padB - ((v - min) / span) * (H - padT - padB);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function drawHeatmap(ctx: CanvasRenderingContext2D, rows: unknown[][], W: number, H: number): void {
  const R = rows.length;
  const C = rows.length > 0 ? rows[0].length : 0;
  if (R === 0 || C === 0) {
    return;
  }
  let min = Infinity;
  let max = -Infinity;
  const grid: number[][] = rows.map((r) =>
    r.map((v) => {
      const n = toNumber(v);
      if (Number.isFinite(n)) {
        if ((n as number) < min) {
          min = n as number;
        }
        if ((n as number) > max) {
          max = n as number;
        }
        return n as number;
      }
      return NaN;
    })
  );
  if (!Number.isFinite(min)) {
    return;
  }
  const span = max - min || 1;
  const padL = 46;
  const padB = 22;
  const cw = Math.max(1, (W - padL - 6) / C);
  const rh = Math.max(1, (H - 10 - padB) / R);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const v = grid[r][c];
      const t = Number.isFinite(v) ? ((v as number) - min) / span : 0;
      // Blue→teal→white ramp for readability on dark and light themes.
      const rr = Math.round(30 + t * 225);
      const gg = Math.round(80 + t * 175);
      const bb = Math.round(160 + t * 95);
      ctx.fillStyle = Number.isFinite(v) ? `rgb(${rr},${gg},${bb})` : '#5a2a2a';
      ctx.fillRect(padL + c * cw, 6 + r * rh, Math.ceil(cw), Math.ceil(rh));
    }
  }
  // Row/col index labels.
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  if (R <= 20) {
    for (let r = 0; r < R; r++) {
      ctx.fillText(String(r), 8, 6 + r * rh + Math.min(10, rh - 1));
    }
  }
  if (C <= 20) {
    for (let c = 0; c < C; c++) {
      ctx.fillText(`c${c}`, padL + c * cw, H - 8);
    }
  }
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function buildFooter(): HTMLElement {
  const f = document.createElement('div');
  f.className = 'footer';
  const left = state.selectedPath ?? 'no selection';
  const rightBits: string[] = [];
  if (state.dataset) {
    rightBits.push(`${state.dataset.totalRows.toLocaleString()}×${state.dataset.totalCols.toLocaleString()} · page ${state.dataset.page + 1} · ${state.dataset.dtype}`);
  } else if (state.selectedNode?.type === 'group') {
    rightBits.push(`${(state.selectedNode.children ?? []).length} members`);
  }
  const l = document.createElement('span');
  l.className = 'mono';
  l.textContent = left;
  l.title = left;
  const r = document.createElement('span');
  r.textContent = rightBits.join('  ');
  f.appendChild(l);
  f.appendChild(r);
  return f;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyCell(v: unknown): string {
  if (v == null) {
    return '';
  }
  if (typeof v === 'number') {
    return fmt(v);
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  try {
    const s = JSON.stringify(v);
    return s == null ? String(v) : s.slice(0, 120);
  } catch {
    return String(v);
  }
}

function isNumericCell(v: unknown): boolean {
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  if (Number.isInteger(n) && Math.abs(n) < 1e15) {
    return String(n);
  }
  const s = n.toPrecision(6);
  return s.includes('e') ? s : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return NaN;
}

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

function countDatasets(root: H5NodeInfo): number {
  let n = 0;
  const stack: H5NodeInfo[] = [...(root.children ?? [])];
  while (stack.length) {
    const node = stack.pop() as H5NodeInfo;
    if (node.type === 'dataset') {
      n++;
    } else {
      stack.push(...(node.children ?? []));
    }
  }
  return n;
}

function countGroups(root: H5NodeInfo): number {
  let n = 0;
  const stack: H5NodeInfo[] = [...(root.children ?? [])];
  while (stack.length) {
    const node = stack.pop() as H5NodeInfo;
    if (node.type === 'group') {
      n++;
      stack.push(...(node.children ?? []));
    }
  }
  return n;
}

// Boot
request({ type: 'ready' });
