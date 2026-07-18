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
 */
export interface GroupContainer {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
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

interface SizedTable {
  table: TableModel;
  width: number;
  height: number;
}

interface RelativePlacement {
  positions: Map<string, { x: number; y: number; width: number; height: number }>;
  totalWidth: number;
  totalHeight: number;
}

/** Target width:height ratio for a group's auto-packed table grid. */
const TARGET_ASPECT_RATIO = 16 / 10;

/** Lays `sized` out in a `cols`-wide row-major grid and measures the actual resulting box. */
function packGrid(sized: SizedTable[], cols: number): RelativePlacement {
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
    accX += colWidths[c] + TABLE_GUTTER;
  }
  const rowY: number[] = [];
  let accY = 0;
  for (let r = 0; r < rows; r++) {
    rowY.push(accY);
    accY += rowHeights[r] + TABLE_GUTTER;
  }

  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  sized.forEach((s, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    positions.set(tableKey(s.table.schema, s.table.name), {
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
function chooseColumnCount(sized: SizedTable[], maxColumns: number): number {
  const n = sized.length;
  const upperBound = Math.max(1, Math.min(maxColumns, n));
  let bestCols = 1;
  let bestDiff = Infinity;
  for (let cols = 1; cols <= upperBound; cols++) {
    const { totalWidth, totalHeight } = packGrid(sized, cols);
    const ratio = totalHeight > 0 ? totalWidth / totalHeight : 0;
    const diff = Math.abs(ratio - TARGET_ASPECT_RATIO);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCols = cols;
    }
  }
  return bestCols;
}

/** Packs a group's tables into an aligned grid, relative to (0,0), targeting a 16:10 box. */
function autoLayoutGroup(tables: TableModel[], maxColumns: number): RelativePlacement {
  const sized: SizedTable[] = tables.map((t) => ({
    table: t,
    width: estimateTableWidth(t),
    height: estimateTableHeight(t),
  }));
  const cols = chooseColumnCount(sized, maxColumns);
  return packGrid(sized, cols);
}

export function computeLayout(
  db: DatabaseModel,
  layout: DiagramLayout,
  maxSchemaColumns = 20
): DiagramGeometry {
  const tablesByGroup = new Map<string, TableModel[]>();
  for (const t of db.tables) {
    const group = effectiveGroupName(t, layout);
    const list = tablesByGroup.get(group) ?? [];
    list.push(t);
    tablesByGroup.set(group, list);
  }

  const groupNames = [...tablesByGroup.keys()].sort((a, b) => a.localeCompare(b));

  const tables = new Map<string, TableBox>();
  let cursorX = 0;

  for (const groupName of groupNames) {
    if (layout.collapsedGroups.includes(groupName)) {
      continue;
    }
    const groupTables = (tablesByGroup.get(groupName) ?? [])
      .slice()
      .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
    const { positions, totalWidth } = autoLayoutGroup(groupTables, maxSchemaColumns);

    const originX = cursorX + GROUP_PADDING;
    const originY = GROUP_HEADER_HEIGHT + GROUP_PADDING;

    for (const t of groupTables) {
      const key = tableKey(t.schema, t.name);
      const auto = positions.get(key)!;
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

    cursorX += Math.max(totalWidth, TABLE_MIN_WIDTH) + GROUP_PADDING * 2 + GROUP_GUTTER;
  }

  const groups: GroupContainer[] = [];
  for (const groupName of groupNames) {
    if (layout.collapsedGroups.includes(groupName)) {
      continue;
    }
    const members = (tablesByGroup.get(groupName) ?? []).map(
      (t) => tables.get(tableKey(t.schema, t.name))!
    );
    if (members.length === 0) {
      continue;
    }
    const minX = Math.min(...members.map((b) => b.x)) - GROUP_PADDING;
    const minY = Math.min(...members.map((b) => b.y)) - GROUP_PADDING - GROUP_HEADER_HEIGHT;
    const maxX = Math.max(...members.map((b) => b.x + b.width)) + GROUP_PADDING;
    const maxY = Math.max(...members.map((b) => b.y + b.height)) + GROUP_PADDING;
    groups.push({ name: groupName, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
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
