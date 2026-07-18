const TYPE_ABBREVIATIONS: [string, string][] = [
  ['character varying', 'varchar'],
  ['timestamp without time zone', 'timestamp'],
  ['timestamp with time zone', 'timestamptz'],
  ['time without time zone', 'time'],
  ['time with time zone', 'timetz'],
  ['double precision', 'float8'],
  ['boolean', 'bool'],
  ['bigint', 'int8'],
  ['smallint', 'int2'],
  ['integer', 'int4'],
  ['character', 'char'],
];

export function formatDataType(dataType: string): string {
  for (const [long, short] of TYPE_ABBREVIATIONS) {
    if (dataType.startsWith(long)) {
      return short + dataType.slice(long.length);
    }
  }
  return dataType;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
