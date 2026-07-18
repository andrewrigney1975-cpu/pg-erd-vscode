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
  collapsedSchemas: string[];
}

export function emptyLayout(): DiagramLayout {
  return { positions: {}, viewBox: null, collapsedSchemas: [] };
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

export type HostToWebviewMessage =
  | InitMessage
  | ThemeChangedMessage
  | RefreshedMessage
  | HostErrorMessage;

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

export type WebviewToHostMessage =
  | WebviewReadyMessage
  | SaveLayoutMessage
  | ExportSvgMessage
  | ExportPngMessage
  | RequestRefreshMessage;
