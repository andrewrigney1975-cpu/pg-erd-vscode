// Shared types used by both the extension host (Node) and the webview (browser bundle).
// Kept dependency-free so this file can be imported from either side unchanged.

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  database: string;
  ssl: boolean;
}

/** Fields collected by the Add/Edit Connection form, including the plaintext password. */
export interface ConnectionProfileInput {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
}

export interface ColumnModel {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  /** True if covered by a UNIQUE constraint/index (drives crow's-foot "one" cardinality). */
  isUnique: boolean;
  defaultValue: string | null;
}

export interface TableModel {
  schema: string;
  name: string;
  columns: ColumnModel[];
  comment: string | null;
}

export type RelationshipEndCardinality = 'one' | 'many';

export interface ForeignKeyModel {
  constraintName: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
  /** Whether the referencing (FK) side permits nulls, i.e. an optional relationship. */
  fromNullable: boolean;
  /** Whether the FK columns are themselves unique, making this end of the relation "one" not "many". */
  fromUnique: boolean;
  onDelete: string | null;
  onUpdate: string | null;
}

export interface SchemaModel {
  name: string;
}

export interface DatabaseModel {
  schemas: SchemaModel[];
  tables: TableModel[];
  foreignKeys: ForeignKeyModel[];
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface ViewBoxState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramLayout {
  /** Keyed by `${schema}.${table}`. Entries are only present once a node has been moved from its auto layout position. */
  positions: Record<string, NodePosition>;
  viewBox: ViewBoxState | null;
  /** Names of groups (real schema names or custom group names) currently collapsed. */
  collapsedGroups: string[];
  /**
   * Keyed by `${schema}.${table}`. When present, overrides which visual group container a
   * table renders in -- independent of its real Postgres schema. Lets a diagram be organized
   * by function ("Operational", "Governance", ...) without actually restructuring the database.
   */
  tableGroupOverrides: Record<string, string>;
  /**
   * Index into the group color palette, assigned the first time a group name is ever
   * encountered and then kept forever -- guarantees distinct colors across however many groups
   * currently exist (rather than hashing each name independently, which collides badly for a
   * small palette and short, similar-length names like "Governance"/"Operational").
   */
  groupColorAssignments: Record<string, number>;
}

export function emptyLayout(): DiagramLayout {
  return { positions: {}, viewBox: null, collapsedGroups: [], tableGroupOverrides: {}, groupColorAssignments: {} };
}

/**
 * Fills in defaults for anything missing from a layout loaded out of persistent storage.
 * Data saved by an older build of this extension won't have fields added since (e.g.
 * `tableGroupOverrides` didn't exist before this session) -- trusting it to match the current
 * `DiagramLayout` shape without checking crashes the webview the moment it's read. Also
 * migrates the old `collapsedSchemas` field name forward instead of silently dropping it.
 */
export function normalizeLayout(raw: unknown): DiagramLayout {
  if (!raw || typeof raw !== 'object') {
    return emptyLayout();
  }
  const r = raw as Partial<DiagramLayout> & { collapsedSchemas?: unknown };
  const collapsedGroups = Array.isArray(r.collapsedGroups)
    ? r.collapsedGroups
    : Array.isArray(r.collapsedSchemas)
      ? (r.collapsedSchemas as string[])
      : [];
  return {
    positions: r.positions && typeof r.positions === 'object' ? r.positions : {},
    viewBox: r.viewBox ?? null,
    collapsedGroups,
    tableGroupOverrides:
      r.tableGroupOverrides && typeof r.tableGroupOverrides === 'object' ? r.tableGroupOverrides : {},
    groupColorAssignments:
      r.groupColorAssignments && typeof r.groupColorAssignments === 'object' ? r.groupColorAssignments : {},
  };
}

export function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

// ---------------------------------------------------------------------------
// Webview <-> extension host message protocol
// ---------------------------------------------------------------------------

export interface InitMessage {
  type: 'init';
  connectionName: string;
  theme: ThemeKind;
  database: DatabaseModel;
  layout: DiagramLayout;
  maxSchemaColumns: number;
}

export interface ThemeChangedMessage {
  type: 'themeChanged';
  theme: ThemeKind;
}

export interface RefreshedMessage {
  type: 'refreshed';
  database: DatabaseModel;
  maxSchemaColumns: number;
}

export interface HostErrorMessage {
  type: 'error';
  message: string;
}

/** Pushed after the host applies a group-membership change, so the webview re-renders in place. */
export interface LayoutUpdatedMessage {
  type: 'layoutUpdated';
  layout: DiagramLayout;
}

/**
 * Pushed after the host clears every manually-dragged table position (Reset Layout button) --
 * a distinct message from LayoutUpdatedMessage so the webview knows to ALSO reset the view (fit
 * everything back to the freshly recomputed auto-layout), where a plain group-membership edit
 * deliberately leaves the current pan/zoom alone.
 */
export interface LayoutResetMessage {
  type: 'layoutReset';
  layout: DiagramLayout;
}

export type HostToWebviewMessage =
  | InitMessage
  | ThemeChangedMessage
  | RefreshedMessage
  | HostErrorMessage
  | LayoutUpdatedMessage
  | LayoutResetMessage;

export interface WebviewReadyMessage {
  type: 'ready';
}

export interface SaveLayoutMessage {
  type: 'saveLayout';
  layout: DiagramLayout;
}

export interface ExportSvgMessage {
  type: 'exportSvg';
  svg: string;
  suggestedName: string;
}

export interface ExportPngMessage {
  type: 'exportPng';
  /** A `data:image/png;base64,...` URL produced by rasterizing the diagram via <canvas>. */
  dataUrl: string;
  suggestedName: string;
}

export interface RequestRefreshMessage {
  type: 'requestRefresh';
}

/** Asks the host to run the bulk "assign tables to a group" QuickPick flow. */
export interface ManageGroupsRequestMessage {
  type: 'manageGroupsRequest';
  tables: { schema: string; name: string }[];
}

/**
 * Asks the host to clear every manually-dragged table position for this connection (after a
 * confirmation dialog) -- Groups (tableGroupOverrides), collapsed state, and group colors are
 * deliberately left untouched; only `positions` is reset, letting the auto-layout algorithm
 * place everything again from scratch.
 */
export interface ResetLayoutRequestMessage {
  type: 'resetLayoutRequest';
}

export type WebviewToHostMessage =
  | WebviewReadyMessage
  | SaveLayoutMessage
  | ExportSvgMessage
  | ExportPngMessage
  | RequestRefreshMessage
  | ManageGroupsRequestMessage
  | ResetLayoutRequestMessage;
