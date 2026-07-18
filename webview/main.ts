import { DatabaseModel, DiagramLayout, emptyLayout } from '../src/types';
import { buildStandaloneSvg, computeHighlightSets, renderDiagram } from './erdRenderer';
import { escapeXml } from './format';
import { computeLayout, DiagramGeometry, effectiveGroupName } from './layout';
import { PanZoomController, ViewBox } from './panzoom';
import { rasterizeSvgToPngDataUrl } from './rasterize';
import { routeAllForeignKeys, RoutedRelationship } from './routing';
import { Palette, resolvePalette } from './theme';
import { onHostMessage, postToHost } from './vscodeApi';

const PNG_EXPORT_SCALE = 2;
/** Fixed diagram-unit margin around a fit-to-highlight view -- same convention as
 *  erdRenderer.ts's own CANVAS_PADDING for the initial fit-all view. */
const HIGHLIGHT_FIT_PADDING = 60;
const HIGHLIGHT_ANIM_MS = 350;

let database: DatabaseModel | null = null;
let layout: DiagramLayout = emptyLayout();
let palette: Palette;
let geometry: DiagramGeometry | null = null;
let relationships: RoutedRelationship[] = [];
let selectedKey: string | null = null;
/** Click-to-highlight state for a relationship connector (see erdRenderer.ts's computeHighlightSets)
 *  -- mutually exclusive with selectedKey, a table-click or a connector-click always clears the other. */
let selectedRelationshipKey: string | null = null;
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

/**
 * Assigns every group name a color slot the first time it's ever seen, in encounter order, and
 * persists it -- guarantees distinct colors across however many groups currently exist, rather
 * than deriving a color from each name independently (which risks collisions for a small
 * palette). Covers collapsed groups too, not just currently-visible ones, so a chip's color
 * doesn't change the moment its group gets expanded.
 */
function ensureGroupColorAssignments(db: DatabaseModel, currentLayout: DiagramLayout): void {
  let changed = false;
  for (const t of db.tables) {
    const name = effectiveGroupName(t, currentLayout);
    if (!(name in currentLayout.groupColorAssignments)) {
      currentLayout.groupColorAssignments[name] = Object.keys(currentLayout.groupColorAssignments).length;
      changed = true;
    }
  }
  if (changed) {
    scheduleSaveLayout();
  }
}

function renderAll(resetView: boolean): void {
  if (!database) {
    return;
  }
  palette = resolvePalette();
  ensureGroupColorAssignments(database, layout);
  geometry = computeLayout(database, layout, maxSchemaColumns);
  relationships = routeAllForeignKeys(geometry, database.foreignKeys);
  const rendered = renderDiagram(geometry, relationships, layout, palette, selectedKey, selectedRelationshipKey);
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

/**
 * Bounding box (in diagram/user-space units) of everything the CURRENT click-to-highlight
 * selection keeps at full opacity -- reuses erdRenderer.ts's own computeHighlightSets so this can
 * never disagree with what's actually dimmed on screen. Returns null when nothing is highlighted
 * (selectedKey and selectedRelationshipKey both null), which callers treat as "fit-to-highlight
 * doesn't apply, use the default view instead."
 */
function computeHighlightBoundsRect(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!geometry) {
    return null;
  }
  const highlight = computeHighlightSets(relationships, selectedKey, selectedRelationshipKey);
  if (highlight.tableKeys === null) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;

  highlight.tableKeys.forEach((key) => {
    const box = geometry!.tables.get(key);
    if (!box) {
      return;
    }
    any = true;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  });

  if (highlight.relationshipKeys) {
    relationships.forEach((r) => {
      if (!highlight.relationshipKeys!.has(r.key)) {
        return;
      }
      r.waypoints.forEach((p) => {
        any = true;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      });
    });
  }

  return any ? { minX, minY, maxX, maxY } : null;
}

/**
 * Called right after any click that changes the highlight selection (a table body/relationship
 * click, or a whitespace click that clears it) -- animates the viewBox to fit the newly
 * highlighted elements, or eases back to the default fit-all view once nothing is highlighted.
 * Deliberately NOT called from the table-header's own pointerdown (see attachInteractionHandlers)
 * -- that click also starts a drag, and animating the viewport out from under an active drag
 * gesture would fight the user's own repositioning instead of helping them inspect connections.
 */
function updateHighlightView(): void {
  if (!panzoom) {
    return;
  }
  const bounds = computeHighlightBoundsRect();
  const target: ViewBox = bounds
    ? {
        x: bounds.minX - HIGHLIGHT_FIT_PADDING,
        y: bounds.minY - HIGHLIGHT_FIT_PADDING,
        width: Math.max(50, bounds.maxX - bounds.minX + HIGHLIGHT_FIT_PADDING * 2),
        height: Math.max(50, bounds.maxY - bounds.minY + HIGHLIGHT_FIT_PADDING * 2),
      }
    : panzoom.getBaseViewBox();

  panzoom.suspended = true;
  panzoom.animateTo(target, HIGHLIGHT_ANIM_MS, () => {
    if (panzoom) {
      panzoom.suspended = false;
    }
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
      selectedRelationshipKey = null;
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

  svgEl.querySelectorAll('.pgerd-group-header[data-collapse-toggle]').forEach((el) => {
    el.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const name = el.getAttribute('data-group');
      if (!name) {
        return;
      }
      const idx = layout.collapsedGroups.indexOf(name);
      if (idx === -1) {
        layout.collapsedGroups.push(name);
      } else {
        layout.collapsedGroups.splice(idx, 1);
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

/**
 * Click-to-highlight (ported from Enkl.app's Tables & Columns ERD): clicking anywhere in a table
 * NOT already handled by the header's own pointerdown above (i.e. clicking the body/rows) selects
 * that table without starting a drag; clicking a relationship connector highlights just its own
 * two tables and that one connector; clicking whitespace (canvas background, group containers,
 * chips) clears back to fully visible. The header's own listener above calls stopPropagation(), so
 * this never double-handles a header click.
 */
svgEl.addEventListener('pointerdown', (e) => {
  const target = e.target as Element;

  const tableEl = target.closest('.pgerd-table');
  if (tableEl) {
    const key = tableEl.getAttribute('data-key');
    if (key) {
      selectedKey = key;
      selectedRelationshipKey = null;
      scheduleRender();
      updateHighlightView();
    }
    return;
  }

  const relEl = target.closest('.pgerd-relationship');
  if (relEl) {
    const key = relEl.getAttribute('data-fk');
    if (key) {
      selectedRelationshipKey = key;
      selectedKey = null;
      scheduleRender();
      updateHighlightView();
    }
    return;
  }

  if (selectedKey !== null || selectedRelationshipKey !== null) {
    selectedKey = null;
    selectedRelationshipKey = null;
    scheduleRender();
    updateHighlightView();
  }
});

// --- Toolbar ---
document.getElementById('zoomInBtn')?.addEventListener('click', () => panzoom?.zoomAtCenter(1 / 1.25));
document.getElementById('zoomOutBtn')?.addEventListener('click', () => panzoom?.zoomAtCenter(1.25));
document.getElementById('resetBtn')?.addEventListener('click', () => panzoom?.reset());
document.getElementById('resetLayoutBtn')?.addEventListener('click', () => {
  postToHost({ type: 'resetLayoutRequest' });
});
document.getElementById('refreshBtn')?.addEventListener('click', () => {
  clearError();
  postToHost({ type: 'requestRefresh' });
});
document.getElementById('groupsBtn')?.addEventListener('click', () => {
  if (!database) {
    return;
  }
  postToHost({
    type: 'manageGroupsRequest',
    tables: database.tables.map((t) => ({ schema: t.schema, name: t.name })),
  });
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
    case 'layoutUpdated':
      layout = msg.layout;
      renderAll(false);
      break;
    case 'layoutReset':
      layout = msg.layout;
      renderAll(true);
      break;
    case 'error':
      showError(msg.message);
      break;
  }
});

postToHost({ type: 'ready' });
