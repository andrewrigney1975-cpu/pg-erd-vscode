import { Client, ClientConfig } from 'pg';
import { ConnectionProfile, DatabaseModel, ForeignKeyModel, TableModel, ColumnModel } from './types';

export interface IntrospectionOptions {
  includeSystemSchemas: boolean;
  connectionTimeoutMs: number;
}

function clientConfig(
  profile: ConnectionProfile,
  password: string,
  timeoutMs: number
): ClientConfig {
  return {
    host: profile.host,
    port: profile.port,
    user: profile.username,
    password,
    database: profile.database,
    ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: Math.max(timeoutMs * 3, 30000),
  };
}

export async function testConnection(
  profile: ConnectionProfile,
  password: string,
  timeoutMs: number
): Promise<void> {
  const client = new Client(clientConfig(profile, password, timeoutMs));
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog', 'pg_toast']);

export async function introspectDatabase(
  profile: ConnectionProfile,
  password: string,
  options: IntrospectionOptions
): Promise<DatabaseModel> {
  const client = new Client(clientConfig(profile, password, options.connectionTimeoutMs));
  await client.connect();
  try {
    const schemaNames = await fetchSchemaNames(client, options.includeSystemSchemas);
    if (schemaNames.length === 0) {
      return { schemas: [], tables: [], foreignKeys: [] };
    }
    const [tables, foreignKeys] = await Promise.all([
      fetchTables(client, schemaNames),
      fetchForeignKeys(client, schemaNames),
    ]);
    return {
      schemas: schemaNames.map((name) => ({ name })),
      tables,
      foreignKeys,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function fetchSchemaNames(client: Client, includeSystemSchemas: boolean): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname
     FROM pg_catalog.pg_namespace
     WHERE nspname !~ '^pg_temp_' AND nspname !~ '^pg_toast_temp_'
     ORDER BY nspname`
  );
  return rows
    .map((r) => r.nspname)
    .filter((name) => includeSystemSchemas || !SYSTEM_SCHEMAS.has(name) && !name.startsWith('pg_'));
}

interface TableRow {
  oid: string;
  schema: string;
  name: string;
  comment: string | null;
}

interface ColumnRow {
  schema: string;
  table: string;
  name: string;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  is_primary_key: boolean;
  is_foreign_key: boolean;
  is_unique: boolean;
}

async function fetchTables(client: Client, schemas: string[]): Promise<TableModel[]> {
  const { rows: tableRows } = await client.query<TableRow>(
    `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name,
            obj_description(c.oid, 'pg_class') AS comment
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname = ANY($1::text[])
     ORDER BY n.nspname, c.relname`,
    [schemas]
  );

  const { rows: columnRows } = await client.query<ColumnRow>(
    `SELECT
        n.nspname AS schema,
        c.relname AS table,
        a.attname AS name,
        format_type(a.atttypid, a.atttypmod) AS data_type,
        NOT a.attnotnull AS nullable,
        pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint con
          WHERE con.contype = 'p' AND con.conrelid = c.oid AND a.attnum = ANY(con.conkey)
        ) AS is_primary_key,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint con
          WHERE con.contype = 'f' AND con.conrelid = c.oid AND a.attnum = ANY(con.conkey)
        ) AS is_foreign_key,
        (
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint con
            WHERE con.contype IN ('u', 'p') AND con.conrelid = c.oid AND con.conkey = ARRAY[a.attnum]
          )
          OR EXISTS (
            SELECT 1 FROM pg_catalog.pg_index i
            WHERE i.indrelid = c.oid AND i.indisunique
              AND array_length(i.indkey::int[], 1) = 1 AND i.indkey[0] = a.attnum
          )
        ) AS is_unique
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
     WHERE c.relkind IN ('r', 'p')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND n.nspname = ANY($1::text[])
     ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas]
  );

  const columnsByTable = new Map<string, ColumnModel[]>();
  for (const row of columnRows) {
    const key = `${row.schema}.${row.table}`;
    const list = columnsByTable.get(key) ?? [];
    list.push({
      name: row.name,
      dataType: row.data_type,
      nullable: row.nullable,
      isPrimaryKey: row.is_primary_key,
      isForeignKey: row.is_foreign_key,
      isUnique: row.is_unique,
      defaultValue: row.default_value,
    });
    columnsByTable.set(key, list);
  }

  return tableRows.map((t) => ({
    schema: t.schema,
    name: t.name,
    comment: t.comment,
    columns: columnsByTable.get(`${t.schema}.${t.name}`) ?? [],
  }));
}

interface ForeignKeyRow {
  constraint_name: string;
  from_schema: string;
  from_table: string;
  from_columns: string[];
  to_schema: string;
  to_table: string;
  to_columns: string[];
  confupdtype: string;
  confdeltype: string;
  from_nullable: boolean;
  from_unique: boolean;
}

async function fetchForeignKeys(client: Client, schemas: string[]): Promise<ForeignKeyModel[]> {
  const { rows } = await client.query<ForeignKeyRow>(
    `SELECT
        con.conname AS constraint_name,
        nsrc.nspname AS from_schema,
        csrc.relname AS from_table,
        array_agg(af_src.attname::text ORDER BY k.ord) AS from_columns,
        ndst.nspname AS to_schema,
        cdst.relname AS to_table,
        array_agg(af_dst.attname::text ORDER BY k.ord) AS to_columns,
        con.confupdtype::text AS confupdtype,
        con.confdeltype::text AS confdeltype,
        bool_and(NOT af_src.attnotnull) AS from_nullable,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint uq
          WHERE uq.contype IN ('u', 'p') AND uq.conrelid = con.conrelid AND uq.conkey = con.conkey
        ) AS from_unique
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class csrc ON csrc.oid = con.conrelid
     JOIN pg_catalog.pg_namespace nsrc ON nsrc.oid = csrc.relnamespace
     JOIN pg_catalog.pg_class cdst ON cdst.oid = con.confrelid
     JOIN pg_catalog.pg_namespace ndst ON ndst.oid = cdst.relnamespace
     CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(srcattnum, dstattnum, ord)
     JOIN pg_catalog.pg_attribute af_src ON af_src.attrelid = con.conrelid AND af_src.attnum = k.srcattnum
     JOIN pg_catalog.pg_attribute af_dst ON af_dst.attrelid = con.confrelid AND af_dst.attnum = k.dstattnum
     WHERE con.contype = 'f'
       AND nsrc.nspname = ANY($1::text[])
     GROUP BY con.oid, con.conname, nsrc.nspname, csrc.relname, ndst.nspname, cdst.relname,
              con.confupdtype, con.confdeltype
     ORDER BY nsrc.nspname, csrc.relname, con.conname`,
    [schemas]
  );

  return rows.map((r) => ({
    constraintName: r.constraint_name,
    fromSchema: r.from_schema,
    fromTable: r.from_table,
    fromColumns: r.from_columns,
    toSchema: r.to_schema,
    toTable: r.to_table,
    toColumns: r.to_columns,
    fromNullable: r.from_nullable,
    fromUnique: r.from_unique,
    onUpdate: mapConfAction(r.confupdtype),
    onDelete: mapConfAction(r.confdeltype),
  }));
}

function mapConfAction(code: string): string | null {
  switch (code) {
    case 'a':
      return 'NO ACTION';
    case 'r':
      return 'RESTRICT';
    case 'c':
      return 'CASCADE';
    case 'n':
      return 'SET NULL';
    case 'd':
      return 'SET DEFAULT';
    default:
      return null;
  }
}
