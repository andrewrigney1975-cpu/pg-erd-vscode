import { DatabaseModel, DiagramLayout, emptyLayout } from '../src/types';
import { buildStandaloneSvg, renderDiagram } from './erdRenderer';
import { escapeXml } from './format';
import { computeLayout, DiagramGeometry } from './layout';
import { PanZoomController, ViewBox } from './panzoom';
import { rasterizeSvgToPngDataUrl } from './rasterize';
import { routeAllForeignKeys, RoutedRelationship } from './routing';
import { Palette, resolvePalette } from './theme';
import { onHostMessage, postToHost } from './vscodeApi';

const PNG_EXPORT_SCALE = 4;

let database: DatabaseModel | null = null;
let layout: DiagramLayout = emptyLayout();
let palette: Palette;
let geometry: DiagramGeometry | null = null;
let relationships: RoutedRelationship[] = [];
let selectedKey: string | null = null;
let panzoom: PanZoomController | null = null;
let pendingFrame = false;
let saveTimer: number | undefined;
let connectionName = '';
let maxSchemaColumns = 20;

interface DragState {
  key: string;
  startClientX: number;
  startClientY: number;
  startBoxX: number;
  startBoxY: number;
  scaleX: number;
  scaleY: number;
}
let dragState: DragState | null = null;

const svgEl = document.getElementById('erdSvg') as unknown as SVGSVGElement;
const titleEl = document.getElementById('connectionTitle')!;
const emptyStateEl = document.getElementById('emptyState')!;
const errorBannerEl = document.getElementById('errorBanner')!;

function showError(message: string): void {
  errorBannerEl.textContent = message;
  errorBannerEl.classList.remove('hidden');
}

function clearError(): void {
  errorBannerEl.classList.add('hidden');
}

function scheduleSaveLayout(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    postToHost({ type: 'saveLayout', layout });
  }, 400);
}

function renderAll(resetView: boolean): void {
  if (!database) {
    return;
  }
  palette = resolvePalette();
  geometry = computeLayout(database, layout, maxSchemaColumns);
  relationships = routeAllForeignKeys(geometry, database.foreignKeys);
  const rendered = renderDiagram(geometry, relationships, layout, palette, selectedKey);
  svgEl.innerHTML = rendered.markup;

  const hasTables = database.tables.length > 0;
  emptyStateEl.classList.toggle('hidden', hasTables);
  if (!hasTables) {
    const schemaList = database.schemas.map((s) => s.name).join(', ');
    emptyStateEl.innerHTML =
      '<p>No tables found.</p>' +
      (schemaList
        ? `<p class="hint">Connected successfully and scanned schema(s): <code>${escapeXml(schemaList)}</code>.<br/>If your tables live elsewhere, double-check the connection's <b>Database</b> field.</p>`
        : `<p class="hint">Connected successfully, but no non-system schemas were found at all — double-check the connection's <b>Database</b> field.</p>`);
  }

  if (!panzoom) {
    const initialView: ViewBox = layout.viewBox ?? rendered.viewBox;
    panzoom = new PanZoomController(svgEl, initialView, (vb) => {
      layout.viewBox = vb;
      scheduleSaveLayout();
    });
    panzoom.setBaseViewBox(rendered.viewBox, false);
  } else {
    panzoom.setBaseViewBox(rendered.viewBox, resetView);
  }

  attachInteractionHandlers();
}

function scheduleRender(): void {
  if (pendingFrame) {
    return;
  }
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    renderAll(false);
  });
}

function attachInteractionHandlers(): void {
  svgEl.querySelectorAll('.pgerd-table-header').forEach((el) => {
    el.addEventListener('pointerdown', (evt) => {
      const e = evt as PointerEvent;
      e.stopPropagation();
      const key = el.getAttribute('data-key');
      if (!key || !geometry) {
        return;
      }
      const box = geometry.tables.get(key);
      if (!box) {
        return;
      }
      selectedKey = key;
      const rect = svgEl.getBoundingClientRect();
      const vb = panzoom!.getViewBox();
      dragState = {
        key,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startBoxX: box.x,
        startBoxY: box.y,
        scaleX: vb.width / rect.width,
        scaleY: vb.height / rect.height,
      };
      (el as Element).setPointerCapture(e.pointerId);
      panzoom!.suspended = true;
      scheduleRender();
    });
  });

  svgEl.querySelectorAll('.pgerd-schema-header[data-collapse-toggle]').forEach((el) => {
    el.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const name = el.getAttribute('data-schema');
      if (!name) {
        return;
      }
      const idx = layout.collapsedSchemas.indexOf(name);
      if (idx === -1) {
        layout.collapsedSchemas.push(name);
      } else {
        layout.collapsedSchemas.splice(idx, 1);
      }
      renderAll(false);
      scheduleSaveLayout();
    });
  });
}

svgEl.addEventListener('pointermove', (e) => {
  if (!dragState) {
    return;
  }
  const dxClient = e.clientX - dragState.startClientX;
  const dyClient = e.clientY - dragState.startClientY;
  const newX = dragState.startBoxX + dxClient * dragState.scaleX;
  const newY = dragState.startBoxY + dyClient * dragState.scaleY;
  layout.positions[dragState.key] = { x: Math.round(newX), y: Math.round(newY) };
  scheduleRender();
});

function endDrag(): void {
  if (!dragState) {
    return;
  }
  dragState = null;
  if (panzoom) {
    panzoom.suspended = false;
  }
  scheduleSaveLayout();
}
svgEl.addEventListener('pointerup', endDrag);
svgEl.addEventListener('pointercancel', endDrag);

svgEl.addEventListener('pointerdown', (e) => {
  const target = e.target as Element;
  if (!target.closest('.pgerd-table')) {
    if (selectedKey !== null) {
      selectedKey = null;
      scheduleRender();
    }
  }
});

// --- Toolbar ---
document.getElementById('zoomInBtn')?.addEventListener('click', () => panzoom?.zoomAtCenter(1 / 1.25));
document.getElementById('zoomOutBtn')?.addEventListener('click', () => panzoom?.zoomAtCenter(1.25));
document.getElementById('resetBtn')?.addEventListener('click', () => panzoom?.reset());
document.getElementById('refreshBtn')?.addEventListener('click', () => {
  clearError();
  postToHost({ type: 'requestRefresh' });
});
document.getElementById('exportBtn')?.addEventListener('click', () => {
  if (!geometry) {
    return;
  }
  palette = resolvePalette();
  const rendered = renderDiagram(geometry, relationships, layout, palette, null);
  const svgString = buildStandaloneSvg(rendered, palette);
  postToHost({
    type: 'exportSvg',
    svg: svgString,
    suggestedName: `${connectionName || 'erd'}.svg`,
  });
});
document.getElementById('exportPngBtn')?.addEventListener('click', async () => {
  if (!geometry) {
    return;
  }
  palette = resolvePalette();
  const rendered = renderDiagram(geometry, relationships, layout, palette, null);
  const svgString = buildStandaloneSvg(rendered, palette);
  try {
    const dataUrl = await rasterizeSvgToPngDataUrl(
      svgString,
      rendered.viewBox.width,
      rendered.viewBox.height,
      PNG_EXPORT_SCALE
    );
    postToHost({
      type: 'exportPng',
      dataUrl,
      suggestedName: `${connectionName || 'erd'}.png`,
    });
  } catch (err) {
    showError(`PNG export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

onHostMessage((msg) => {
  switch (msg.type) {
    case 'init':
      connectionName = msg.connectionName;
      titleEl.textContent = msg.connectionName;
      database = msg.database;
      layout = msg.layout;
      maxSchemaColumns = msg.maxSchemaColumns;
      clearError();
      renderAll(true);
      break;
    case 'refreshed':
      database = msg.database;
      maxSchemaColumns = msg.maxSchemaColumns;
      clearError();
      renderAll(false);
      break;
    case 'themeChanged':
      renderAll(false);
      break;
    case 'error':
      showError(msg.message);
      break;
  }
});

postToHost({ type: 'ready' });
