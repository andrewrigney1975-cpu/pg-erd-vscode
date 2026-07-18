import { ForeignKeyModel, tableKey } from '../src/types';
import { columnRowCenterY, DiagramGeometry, TableBox } from './layout';

export const FILLET_RADIUS = 8;
const STUB = 24;
const SELF_LOOP_STUB = 48;

export interface Point {
  x: number;
  y: number;
}

export type Cardinality = 'one' | 'many';

export interface RelationshipMarker {
  point: Point;
  /** Unit vector pointing away from the table edge, i.e. the direction the notation marks face. */
  dir: Point;
  cardinality: Cardinality;
  optional: boolean;
}

export interface RoutedRelationship {
  key: string;
  fk: ForeignKeyModel;
  pathD: string;
  fromMarker: RelationshipMarker;
  toMarker: RelationshipMarker;
  /**
   * The raw (pre-fillet) waypoint chain the path was built from -- main.ts's click-to-highlight
   * fit-to-view uses this to compute a relationship's bounding box directly, rather than
   * re-parsing `pathD`'s arc/line commands. Safe as an upper bound on the rendered curve's true
   * extent: `roundedOrthogonalPath`'s fillets only cut corners INWARD (toward the segment
   * midpoints), never bulge outward past the straight polyline they're rounding.
   */
  waypoints: Point[];
}

type Side = 'left' | 'right' | 'top' | 'bottom';

function findRowIndex(box: TableBox, columnName: string): number {
  const idx = box.columns.findIndex((c) => c.column.name === columnName);
  return idx === -1 ? 0 : idx;
}

/** Which coordinate a side's exit travels along -- 'x' for left/right, 'y' for top/bottom. */
function axisOf(side: Side): 'x' | 'y' {
  return side === 'left' || side === 'right' ? 'x' : 'y';
}

function edgeAnchor(box: TableBox, rowIndex: number, side: Side): Point {
  if (side === 'left' || side === 'right') {
    const y = columnRowCenterY(box, rowIndex);
    const x = side === 'left' ? box.x : box.x + box.width;
    return { x, y };
  }
  // Top/bottom exits anchor at the table's horizontal center -- there's no natural column
  // row to line up with once the connector leaves vertically instead of from the side.
  const x = box.x + box.width / 2;
  const y = side === 'top' ? box.y : box.y + box.height;
  return { x, y };
}

/**
 * Picks left/right when two tables are separated more horizontally than vertically, and
 * top/bottom otherwise -- e.g. two tables that land in the same auto-layout grid column
 * (nearly identical x, but stacked in different rows) should route vertically instead of
 * being forced into a left/right exit that backtracks through the source table to reach a
 * target that's actually below/above it.
 */
function pickSides(from: TableBox, to: TableBox): { fromSide: Side; toSide: Side } {
  const fromCenterX = from.x + from.width / 2;
  const fromCenterY = from.y + from.height / 2;
  const toCenterX = to.x + to.width / 2;
  const toCenterY = to.y + to.height / 2;
  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function unitDir(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function stubOut(anchor: Point, side: Side, len: number): Point {
  switch (side) {
    case 'right':
      return { x: anchor.x + len, y: anchor.y };
    case 'left':
      return { x: anchor.x - len, y: anchor.y };
    case 'bottom':
      return { x: anchor.x, y: anchor.y + len };
    case 'top':
      return { x: anchor.x, y: anchor.y - len };
  }
}

/**
 * Builds an orthogonal (Manhattan) waypoint chain between two side-anchored points.
 * `fromSide`/`toSide` are always the same orientation (both horizontal or both vertical --
 * see `pickSides`), so the whole route is built generically along that shared exit axis.
 */
function routeWaypoints(from: Point, fromSide: Side, to: Point, toSide: Side): Point[] {
  const axis = axisOf(fromSide);
  const crossAxis = axis === 'x' ? 'y' : 'x';

  // Cap the stub so it can never eat more than half the gap between the anchors -- a fixed
  // stub would otherwise overshoot past the midpoint when two tables sit close together
  // (e.g. side-by-side in the same schema's packed grid), making the path briefly reverse
  // direction and collapse into degenerate near-zero-length corners.
  const available = Math.abs(to[axis] - from[axis]);
  const stub = Math.max(2, Math.min(STUB, available / 2 - 2));
  const p1 = stubOut(from, fromSide, stub);
  const p2 = stubOut(to, toSide, stub);

  if (Math.abs(p1[crossAxis] - p2[crossAxis]) < 0.5) {
    return [from, p1, p2, to];
  }

  const mid = (p1[axis] + p2[axis]) / 2;
  const mid1: Point = axis === 'x' ? { x: mid, y: p1.y } : { x: p1.x, y: mid };
  const mid2: Point = axis === 'x' ? { x: mid, y: p2.y } : { x: p2.x, y: mid };
  return [from, p1, mid1, mid2, p2, to];
}

/** Self-referencing FK: loop out from the right edge and back in, since from/to boxes coincide. */
function routeSelfLoop(box: TableBox, fromRow: number, toRow: number): Point[] {
  const from = edgeAnchor(box, fromRow, 'right');
  const to = edgeAnchor(box, toRow, 'right');
  const outX = box.x + box.width + SELF_LOOP_STUB;
  return [from, { x: outX, y: from.y }, { x: outX, y: to.y }, to];
}

function simplifyWaypoints(points: Point[]): Point[] {
  const cleaned: Point[] = [];
  for (const p of points) {
    const last = cleaned[cleaned.length - 1];
    if (last && dist(last, p) < 0.5) {
      continue;
    }
    cleaned.push(p);
  }
  let changed = true;
  while (changed && cleaned.length > 2) {
    changed = false;
    for (let i = 1; i < cleaned.length - 1; i++) {
      const a = cleaned[i - 1];
      const b = cleaned[i];
      const c = cleaned[i + 1];
      const v1 = unitDir(a, b);
      const v2 = unitDir(b, c);
      const cross = v1.x * v2.y - v1.y * v2.x;
      const dot = v1.x * v2.x + v1.y * v2.y;
      if (Math.abs(cross) < 1e-6 && dot > 0) {
        cleaned.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return cleaned;
}

function fmt(p: Point): string {
  return `${round(p.x)},${round(p.y)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Renders a waypoint chain as an SVG path with true circular fillets at each turn.
 * For an axis-aligned 90-degree corner, trimming both legs by `radius` and joining
 * with a same-radius arc is exactly tangent to both segments (verified analytically:
 * sweep-flag = 1 when the incoming-to-outgoing direction cross product is positive,
 * 0 otherwise, independent of turn orientation).
 */
export function roundedOrthogonalPath(rawPoints: Point[], radius = FILLET_RADIUS): string {
  const points = simplifyWaypoints(rawPoints);
  if (points.length < 2) {
    return '';
  }
  if (points.length === 2) {
    return `M ${fmt(points[0])} L ${fmt(points[1])}`;
  }

  let d = `M ${fmt(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const segLen1 = dist(prev, curr);
    const segLen2 = dist(curr, next);
    const r = Math.max(0, Math.min(radius, segLen1 / 2, segLen2 / 2));
    const v1 = unitDir(prev, curr);
    const v2 = unitDir(curr, next);
    const before = { x: curr.x - v1.x * r, y: curr.y - v1.y * r };
    const after = { x: curr.x + v2.x * r, y: curr.y + v2.y * r };
    const cross = v1.x * v2.y - v1.y * v2.x;
    const sweep = cross > 0 ? 1 : 0;

    d += ` L ${fmt(before)}`;
    if (r > 0.05) {
      d += ` A ${round(r)} ${round(r)} 0 0 ${sweep} ${fmt(after)}`;
    }
  }
  d += ` L ${fmt(points[points.length - 1])}`;
  return d;
}

function outwardDir(side: Side): Point {
  switch (side) {
    case 'right':
      return { x: 1, y: 0 };
    case 'left':
      return { x: -1, y: 0 };
    case 'bottom':
      return { x: 0, y: 1 };
    case 'top':
      return { x: 0, y: -1 };
  }
}

export function routeForeignKey(
  fk: ForeignKeyModel,
  geometry: DiagramGeometry
): RoutedRelationship | null {
  const fromBox = geometry.tables.get(tableKey(fk.fromSchema, fk.fromTable));
  const toBox = geometry.tables.get(tableKey(fk.toSchema, fk.toTable));
  if (!fromBox || !toBox) {
    return null;
  }

  const fromRow = findRowIndex(fromBox, fk.fromColumns[0]);
  const toRow = findRowIndex(toBox, fk.toColumns[0]);

  let waypoints: Point[];
  let fromSide: Side;
  let toSide: Side;

  if (fromBox.key === toBox.key) {
    fromSide = 'right';
    toSide = 'right';
    waypoints = routeSelfLoop(fromBox, fromRow, toRow);
  } else {
    const sides = pickSides(fromBox, toBox);
    fromSide = sides.fromSide;
    toSide = sides.toSide;
    const from = edgeAnchor(fromBox, fromRow, fromSide);
    const to = edgeAnchor(toBox, toRow, toSide);
    waypoints = routeWaypoints(from, fromSide, to, toSide);
  }

  const pathD = roundedOrthogonalPath(waypoints);

  const fromMarker: RelationshipMarker = {
    point: waypoints[0],
    dir: outwardDir(fromSide),
    cardinality: fk.fromUnique ? 'one' : 'many',
    optional: fk.fromNullable,
  };
  const toMarker: RelationshipMarker = {
    point: waypoints[waypoints.length - 1],
    dir: outwardDir(toSide),
    cardinality: 'one',
    optional: false,
  };

  return {
    key: fk.constraintName || `${fk.fromSchema}.${fk.fromTable}->${fk.toSchema}.${fk.toTable}`,
    fk,
    pathD,
    fromMarker,
    toMarker,
    waypoints,
  };
}

export function routeAllForeignKeys(geometry: DiagramGeometry, fks: ForeignKeyModel[]): RoutedRelationship[] {
  const routed: RoutedRelationship[] = [];
  for (const fk of fks) {
    const r = routeForeignKey(fk, geometry);
    if (r) {
      routed.push(r);
    }
  }
  return routed;
}
