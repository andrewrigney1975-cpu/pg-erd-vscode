import { ColumnModel, DatabaseModel, DiagramLayout, TableModel, tableKey } from '../src/types';
import { formatDataType } from './format';

export const TABLE_HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 22;
export const TABLE_MIN_WIDTH = 200;
export const TABLE_MAX_WIDTH = 360;
const TABLE_GUTTER = 44;
const GROUP_GUTTER = 72;
const GROUP_PADDING = 24;
const GROUP_HEADER_HEIGHT = 34;

export interface ColumnLayout {
  column: ColumnModel;
  rowIndex: number;
}

export interface TableBox {
  key: string;
  schema: string;
  table: TableModel;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: ColumnLayout[];
}

/**
 * A visual container box. Its `name` is usually a real Postgres schema name, but can also be a
 * custom group name from `DiagramLayout.tableGroupOverrides` -- the two are rendered identically.
 * Only exists for VISIBLE (non-collapsed) groups -- a collapsed group renders as a small chip in
 * a separate stacked list instead (see erdRenderer.ts's renderDiagram/renderCollapsedChip), not a
 * GroupContainer.
 */
export interface GroupContainer {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CHIP_HEIGHT = 26;

/** Shared footprint formula for a collapsed group's chip -- used by erdRenderer.ts to size and
 *  position the stacked list of chips, so there's only one place this formula lives. */
export function estimateChipWidth(name: string): number {
  return Math.max(90, name.length * 7.5 + 40);
}

export interface DiagramBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DiagramGeometry {
  tables: Map<string, TableBox>;
  groups: GroupContainer[];
  bounds: DiagramBounds;
}

/** Which container a table renders in: its manually-assigned group if any, else its real schema. */
export function effectiveGroupName(table: TableModel, layout: DiagramLayout): string {
  return layout.tableGroupOverrides[tableKey(table.schema, table.name)] ?? table.schema;
}

function estimateTableWidth(table: TableModel): number {
  let maxLine = table.name.length + 3;
  for (const col of table.columns) {
    const line = `${col.name}  ${formatDataType(col.dataType)}`;
    maxLine = Math.max(maxLine, line.length);
  }
  const px = maxLine * 6.8 + 60;
  return Math.min(TABLE_MAX_WIDTH, Math.max(TABLE_MIN_WIDTH, Math.round(px)));
}

function estimateTableHeight(table: TableModel): number {
  const rows = Math.max(table.columns.length, 1);
  return TABLE_HEADER_HEIGHT + rows * ROW_HEIGHT + 8;
}

/**
 * A generic sized, keyed box for the masonry packer below -- deliberately NOT table-specific, so
 * the same packer arranges both tables-within-a-group AND groups-within-the-diagram (see
 * computeLayout's two calls to chooseColumnCount/packGrid).
 */
interface SizedItem {
  key: string;
  width: number;
  height: number;
}

interface RelativePlacement {
  positions: Map<string, { x: number; y: number; width: number; height: number }>;
  totalWidth: number;
  totalHeight: number;
}

/** Target width:height ratio for an auto-packed grid (used for both tables-in-a-group and groups-in-the-diagram). */
const TARGET_ASPECT_RATIO = 16 / 10;

/** Lays `sized` out in a `cols`-wide row-major grid and measures the actual resulting box. */
function packGrid(sized: SizedItem[], cols: number, gutter: number): RelativePlacement {
  const rows = Math.ceil(sized.length / cols);
  const colWidths = new Array(cols).fill(0);
  const rowHeights = new Array(rows).fill(0);
  sized.forEach((s, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colWidths[c] = Math.max(colWidths[c], s.width);
    rowHeights[r] = Math.max(rowHeights[r], s.height);
  });

  const colX: number[] = [];
  let accX = 0;
  for (let c = 0; c < cols; c++) {
    colX.push(accX);
    accX += colWidths[c] + gutter;
  }
  const rowY: number[] = [];
  let accY = 0;
  for (let r = 0; r < rows; r++) {
    rowY.push(accY);
    accY += rowHeights[r] + gutter;
  }

  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  sized.forEach((s, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    positions.set(s.key, {
      x: colX[c],
      y: rowY[r],
      width: s.width,
      height: s.height,
    });
  });

  const totalWidth = cols > 0 ? colX[cols - 1] + colWidths[cols - 1] : 0;
  const totalHeight = rows > 0 ? rowY[rows - 1] + rowHeights[rows - 1] : 0;
  return { positions, totalWidth, totalHeight };
}

/**
 * Tries every column count from 1 up to `maxColumns`, actually packs the grid for each
 * (not just an averaged estimate), and picks whichever produces a width:height ratio
 * closest to 16:10.
 */
function chooseColumnCount(sized: SizedItem[], maxColumns: number, gutter: number): number {
  const n = sized.length;
  const upperBound = Math.max(1, Math.min(maxColumns, n));
  let bestCols = 1;
  let bestDiff = Infinity;
  for (let cols = 1; cols <= upperBound; cols++) {
    const { totalWidth, totalHeight } = packGrid(sized, cols, gutter);
    const ratio = totalHeight > 0 ? totalWidth / totalHeight : 0;
    const diff = Math.abs(ratio - TARGET_ASPECT_RATIO);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCols = cols;
    }
  }
  return bestCols;
}

/**
 * Packs a group's tables (already in clustered order -- see clusterOrder/computeLayout) into an
 * aligned grid relative to (0,0), targeting a 16:10 box.
 */
function autoLayoutGroup(tables: TableModel[], maxColumns: number): RelativePlacement {
  const sized: SizedItem[] = tables.map((t) => ({
    key: tableKey(t.schema, t.name),
    width: estimateTableWidth(t),
    height: estimateTableHeight(t),
  }));
  const cols = chooseColumnCount(sized, maxColumns, TABLE_GUTTER);
  return packGrid(sized, cols, TABLE_GUTTER);
}

/** Undirected, weighted adjacency: adjacency.get(a).get(b) === adjacency.get(b).get(a) === edge count. */
type Adjacency = Map<string, Map<string, number>>;

function addEdge(adjacency: Adjacency, a: string, b: string): void {
  if (a === b) {
    return;
  }
  const aEdges = adjacency.get(a) ?? new Map<string, number>();
  aEdges.set(b, (aEdges.get(b) ?? 0) + 1);
  adjacency.set(a, aEdges);
  const bEdges = adjacency.get(b) ?? new Map<string, number>();
  bEdges.set(a, (bEdges.get(a) ?? 0) + 1);
  adjacency.set(b, bEdges);
}

/**
 * Orders `keys` so that closely-related ones (per `adjacency`) end up adjacent -- the shared
 * clustering heuristic behind both intra-group table ordering and inter-group ordering in
 * computeLayout(). Conceptually the same BFS-from-the-most-connected-node approach as the
 * Enkl.app Tables & Columns ERD's clusteredTableOrder() (schema-erd.js), generalized to weighted
 * edges: start from whichever key has the highest total adjacency weight, then BFS outward
 * visiting each node's neighbors strongest-edge-first (ties broken alphabetically for
 * determinism -- same schema always lays out the same way). `adjacency` may reference keys
 * outside `keys` (e.g. a collapsed group, or a table whose group isn't in this call's universe)
 * -- those edges are simply ignored, as if they didn't exist for this ordering pass. Any key
 * never reached at all (no in-universe relationships) is appended in plain alphabetical order at
 * the end, matching clusteredTableOrder()'s own defensive fallback for disconnected tables.
 */
function clusterOrder(keys: string[], adjacency: Adjacency): string[] {
  const keySet = new Set(keys);

  const inUniverseWeight = (key: string): number => {
    const edges = adjacency.get(key);
    if (!edges) {
      return 0;
    }
    let total = 0;
    edges.forEach((weight, neighbor) => {
      if (keySet.has(neighbor)) {
        total += weight;
      }
    });
    return total;
  };

  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [];

  const enqueue = (key: string): void => {
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    queue.push(key);
  };

  const startKey = keys
    .slice()
    .sort((a, b) => inUniverseWeight(b) - inUniverseWeight(a) || a.localeCompare(b))[0];
  if (startKey !== undefined) {
    enqueue(startKey);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    const edges = adjacency.get(current);
    if (!edges) {
      continue;
    }
    [...edges.entries()]
      .filter(([neighbor]) => keySet.has(neighbor) && !visited.has(neighbor))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([neighbor]) => enqueue(neighbor));
  }

  keys
    .filter((key) => !visited.has(key))
    .sort((a, b) => a.localeCompare(b))
    .forEach((key) => order.push(key));

  return order;
}

export function computeLayout(
  db: DatabaseModel,
  layout: DiagramLayout,
  maxSchemaColumns = 20
): DiagramGeometry {
  const tableByKey = new Map<string, TableModel>();
  const groupOf = new Map<string, string>();
  const tablesByGroup = new Map<string, TableModel[]>();
  for (const t of db.tables) {
    const key = tableKey(t.schema, t.name);
    const group = effectiveGroupName(t, layout);
    tableByKey.set(key, t);
    groupOf.set(key, group);
    const list = tablesByGroup.get(group) ?? [];
    list.push(t);
    tablesByGroup.set(group, list);
  }

  // Two separate adjacency graphs from the SAME foreign-key list: an in-group edge (both ends in
  // the same group) feeds that group's own intra-group table ordering; a cross-group edge (ends
  // in different groups) feeds the inter-group ordering below. Self-referencing FKs contribute to
  // neither -- a table isn't "related to itself" for clustering purposes (addEdge already no-ops
  // when a === b).
  const interGroupAdjacency: Adjacency = new Map();
  const intraGroupAdjacency = new Map<string, Adjacency>();
  for (const fk of db.foreignKeys) {
    const fromKey = tableKey(fk.fromSchema, fk.fromTable);
    const toKey = tableKey(fk.toSchema, fk.toTable);
    const fromGroup = groupOf.get(fromKey);
    const toGroup = groupOf.get(toKey);
    if (fromGroup === undefined || toGroup === undefined) {
      continue; // defensive -- matches routeForeignKey's own null-guard for an FK to an unknown table
    }
    if (fromGroup === toGroup) {
      let groupGraph = intraGroupAdjacency.get(fromGroup);
      if (!groupGraph) {
        groupGraph = new Map();
        intraGroupAdjacency.set(fromGroup, groupGraph);
      }
      addEdge(groupGraph, fromKey, toKey);
    } else {
      addEdge(interGroupAdjacency, fromGroup, toGroup);
    }
  }

  // Collapsed groups are excluded entirely from clustering/packing -- they render as a separate
  // stacked list of chips instead (see erdRenderer.ts), not as a participant in the group grid.
  const visibleGroupNames = [...tablesByGroup.keys()].filter(
    (g) => !layout.collapsedGroups.includes(g)
  );
  const groupOrder = clusterOrder(visibleGroupNames, interGroupAdjacency);

  // Pass 1: lay out each group's own tables (clustered order, relative to its own (0,0)).
  interface GroupLayoutResult {
    name: string;
    placement: RelativePlacement;
    outerWidth: number;
    outerHeight: number;
  }
  const groupResults: GroupLayoutResult[] = groupOrder.map((groupName) => {
    const groupTables = tablesByGroup.get(groupName) ?? [];
    const tableKeys = groupTables.map((t) => tableKey(t.schema, t.name));
    const orderedKeys = clusterOrder(tableKeys, intraGroupAdjacency.get(groupName) ?? new Map());
    const orderedTables = orderedKeys.map((k) => tableByKey.get(k)!);
    const placement = autoLayoutGroup(orderedTables, maxSchemaColumns);
    return {
      name: groupName,
      placement,
      outerWidth: Math.max(placement.totalWidth, TABLE_MIN_WIDTH) + GROUP_PADDING * 2,
      outerHeight: placement.totalHeight + GROUP_PADDING * 2 + GROUP_HEADER_HEIGHT,
    };
  });

  // Pass 2: pack the groups themselves (each treated as one sized item) using the SAME masonry
  // packer, clustered by inter-group relationship strength (groupOrder) rather than left-to-right
  // alphabetical -- this is what gives related groups visual proximity, keeps consistent
  // (GROUP_GUTTER) spacing and guarantees no overlap (grid placement, not force-directed), and
  // lets the whole diagram grow in a compact 2D shape instead of one ever-widening row.
  const sizedGroups: SizedItem[] = groupResults.map((g) => ({
    key: g.name,
    width: g.outerWidth,
    height: g.outerHeight,
  }));
  const groupCols = chooseColumnCount(sizedGroups, sizedGroups.length, GROUP_GUTTER);
  const groupPlacement = packGrid(sizedGroups, groupCols, GROUP_GUTTER);

  const tables = new Map<string, TableBox>();
  const groups: GroupContainer[] = [];
  for (const g of groupResults) {
    const offset = groupPlacement.positions.get(g.name)!;
    const originX = offset.x + GROUP_PADDING;
    const originY = offset.y + GROUP_PADDING + GROUP_HEADER_HEIGHT;
    const groupTables = tablesByGroup.get(g.name) ?? [];
    for (const t of groupTables) {
      const key = tableKey(t.schema, t.name);
      const auto = g.placement.positions.get(key)!;
      const saved = layout.positions[key];
      const x = saved ? saved.x : originX + auto.x;
      const y = saved ? saved.y : originY + auto.y;
      tables.set(key, {
        key,
        schema: t.schema,
        table: t,
        x,
        y,
        width: auto.width,
        height: auto.height,
        columns: t.columns.map((c, idx) => ({ column: c, rowIndex: idx })),
      });
    }

    // Group container bounds are (re)derived from the tables' FINAL positions, not the pass-2
    // size estimate -- a manually-dragged table (saved.x/y above) can sit outside where the
    // packer would have put it, and the rendered dashed container needs to actually contain it.
    const members = groupTables.map((t) => tables.get(tableKey(t.schema, t.name))!);
    if (members.length === 0) {
      continue;
    }
    const minX = Math.min(...members.map((b) => b.x)) - GROUP_PADDING;
    const minY = Math.min(...members.map((b) => b.y)) - GROUP_PADDING - GROUP_HEADER_HEIGHT;
    const maxX = Math.max(...members.map((b) => b.x + b.width)) + GROUP_PADDING;
    const maxY = Math.max(...members.map((b) => b.y + b.height)) + GROUP_PADDING;
    groups.push({ name: g.name, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }

  let bounds: DiagramBounds = { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  if (groups.length > 0) {
    bounds = {
      minX: Math.min(...groups.map((s) => s.x)),
      minY: Math.min(...groups.map((s) => s.y)),
      maxX: Math.max(...groups.map((s) => s.x + s.width)),
      maxY: Math.max(...groups.map((s) => s.y + s.height)),
    };
  }

  return { tables, groups, bounds };
}

export function columnRowCenterY(box: TableBox, rowIndex: number): number {
  return box.y + TABLE_HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
}
