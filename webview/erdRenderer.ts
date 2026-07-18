import { DiagramLayout, tableKey } from '../src/types';
import { escapeXml, formatDataType } from './format';
import { CHIP_HEIGHT, DiagramGeometry, estimateChipWidth, GroupContainer, ROW_HEIGHT, TABLE_HEADER_HEIGHT, TableBox } from './layout';
import { Point, RelationshipMarker, RoutedRelationship } from './routing';
import { Palette } from './theme';

function sanitizeId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function pkIcon(x: number, y: number, color: string): string {
  return `<g transform="translate(${x},${y})">
    <circle cx="3" cy="6" r="2.5" fill="none" stroke="${color}" stroke-width="1.3"/>
    <line x1="5.3" y1="6" x2="10.6" y2="6" stroke="${color}" stroke-width="1.3"/>
    <line x1="8.4" y1="6" x2="8.4" y2="8.1" stroke="${color}" stroke-width="1.3"/>
    <line x1="10.6" y1="6" x2="10.6" y2="7.7" stroke="${color}" stroke-width="1.3"/>
  </g>`;
}

function fkIcon(x: number, y: number, color: string): string {
  return `<g transform="translate(${x},${y})">
    <rect x="0.5" y="3.2" width="6" height="3.6" rx="1.8" fill="none" stroke="${color}" stroke-width="1.1" transform="rotate(-30 3.5 5)"/>
    <rect x="4.5" y="3.2" width="6" height="3.6" rx="1.8" fill="none" stroke="${color}" stroke-width="1.1" transform="rotate(-30 7.5 5)"/>
  </g>`;
}

function renderTableBox(box: TableBox, palette: Palette, selected: boolean, dimmed: boolean): string {
  const id = sanitizeId(box.key);
  const rx = 5;
  const headerLabel = escapeXml(box.table.name);
  const strokeColor = selected ? palette.selectionBorder : palette.border;
  const strokeWidth = selected ? 2 : 1;
  const groupClass = dimmed ? 'pgerd-table pgerd-dimmed' : 'pgerd-table';

  const rows = box.columns
    .map((col, idx) => {
      const rowY = TABLE_HEADER_HEIGHT + idx * ROW_HEIGHT;
      const icon = col.column.isPrimaryKey
        ? pkIcon(10, rowY + 5, palette.pkAccent)
        : col.column.isForeignKey
          ? fkIcon(10, rowY + 5, palette.fkAccent)
          : '';
      const nameWeight = col.column.isPrimaryKey ? '600' : '400';
      const typeLabel = escapeXml(formatDataType(col.column.dataType));
      const nullMark = col.column.nullable ? '' : '<tspan xml:space="preserve"> *</tspan>';
      const title = `${escapeXml(col.column.name)} : ${typeLabel}${col.column.nullable ? '' : ' NOT NULL'}`;
      return `<g class="pgerd-row">
        <title>${title}</title>
        ${idx > 0 ? `<line x1="0" y1="${rowY}" x2="${box.width}" y2="${rowY}" stroke="${palette.border}" stroke-opacity="0.35" stroke-width="1"/>` : ''}
        ${icon}
        <text x="28" y="${rowY + ROW_HEIGHT / 2 + 4}" font-size="12" font-weight="${nameWeight}" fill="${palette.foreground}">${escapeXml(col.column.name)}${nullMark}</text>
        <text x="${box.width - 10}" y="${rowY + ROW_HEIGHT / 2 + 4}" font-size="11" text-anchor="end" fill="${palette.mutedText}">${typeLabel}</text>
      </g>`;
    })
    .join('\n');

  return `<g class="${groupClass}" data-key="${escapeXml(box.key)}" transform="translate(${box.x},${box.y})">
    <clipPath id="clip-${id}"><rect x="0" y="0" width="${box.width}" height="${box.height}" rx="${rx}"/></clipPath>
    <g clip-path="url(#clip-${id})">
      <rect x="0" y="0" width="${box.width}" height="${box.height}" fill="${palette.entityFill}"/>
      <rect x="0" y="0" width="${box.width}" height="${TABLE_HEADER_HEIGHT}" fill="${palette.entityHeaderFill}"/>
      <g transform="translate(0,${TABLE_HEADER_HEIGHT})">${rows}</g>
    </g>
    <rect class="pgerd-table-header" data-key="${escapeXml(box.key)}" x="0" y="0" width="${box.width}" height="${TABLE_HEADER_HEIGHT}" fill="transparent" style="cursor:grab"/>
    <text x="10" y="${TABLE_HEADER_HEIGHT / 2 + 4}" font-size="12.5" font-weight="700" fill="${palette.foreground}">${headerLabel}</text>
    <rect x="0.5" y="0.5" width="${box.width - 1}" height="${box.height - 1}" rx="${rx}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>
  </g>`;
}

/**
 * Looks up the color assigned to `name` in `layout.groupColorAssignments` -- callers (main.ts)
 * guarantee every group name has an entry before rendering, assigned in first-seen order and
 * persisted, so colors stay stable across sessions and never collide for up to 6 groups at once.
 */
function groupColor(name: string, palette: Palette, layout: DiagramLayout): string {
  const colors = palette.groupColors;
  if (colors.length === 0) {
    return palette.containerBorder;
  }
  const idx = layout.groupColorAssignments[name] ?? 0;
  return colors[idx % colors.length];
}

function renderGroupContainer(container: GroupContainer, palette: Palette, layout: DiagramLayout): string {
  const color = groupColor(container.name, palette, layout);
  return `<g class="pgerd-group" data-group="${escapeXml(container.name)}">
    <rect x="${container.x}" y="${container.y}" width="${container.width}" height="${container.height}" rx="10"
      fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.75"
      stroke-width="1.5" stroke-dasharray="5 4" pointer-events="none"/>
    <rect class="pgerd-group-header" data-group="${escapeXml(container.name)}" data-collapse-toggle="1"
      x="${container.x}" y="${container.y}" width="160" height="22" fill="transparent" style="cursor:pointer"/>
    <text x="${container.x + 10}" y="${container.y + 16}" font-size="12" font-weight="700" letter-spacing="0.4"
      fill="${color}">${escapeXml(container.name)} ▾</text>
  </g>`;
}

/** A collapsed group's chip in the stacked list to the left of the visible diagram (see renderDiagram). */
function renderCollapsedChip(
  name: string,
  x: number,
  y: number,
  width: number,
  palette: Palette,
  layout: DiagramLayout
): string {
  const color = groupColor(name, palette, layout);
  return `<g class="pgerd-group-chip" data-group="${escapeXml(name)}">
    <rect class="pgerd-group-header" data-group="${escapeXml(name)}" data-collapse-toggle="1"
      x="${x}" y="${y}" width="${width}" height="${CHIP_HEIGHT}" rx="${CHIP_HEIGHT / 2}"
      fill="${palette.containerFill}" stroke="${color}" stroke-width="1.5" style="cursor:pointer"/>
    <text x="${x + width / 2}" y="${y + CHIP_HEIGHT / 2 + 4}" font-size="12" font-weight="700" text-anchor="middle"
      fill="${color}">${escapeXml(name)} ▸</text>
  </g>`;
}

/** Point offset from `p` by `outDist` outward along `dir` (away from the table) and `perpOffset` sideways. */
function along(p: Point, dir: Point, perp: Point, outDist: number, perpOffset: number): Point {
  return {
    x: p.x + dir.x * outDist + perp.x * perpOffset,
    y: p.y + dir.y * outDist + perp.y * perpOffset,
  };
}

function renderMarker(marker: RelationshipMarker, palette: Palette): string {
  const { point: p, dir, cardinality, optional } = marker;
  const perp: Point = { x: -dir.y, y: dir.x };
  const parts: string[] = [];
  let cursor: number;

  if (cardinality === 'many') {
    const back = 14;
    const spread = 6;
    const p1 = along(p, dir, perp, back, spread);
    const p2 = along(p, dir, perp, back, -spread);
    parts.push(
      `<path d="M ${p1.x},${p1.y} L ${p.x},${p.y} L ${p2.x},${p2.y}" fill="none" stroke="${palette.relationshipLine}" stroke-width="1.4"/>`
    );
    cursor = back;
    if (!optional) {
      const tickC = along(p, dir, perp, back + 5, 0);
      const t1 = { x: tickC.x + perp.x * 6, y: tickC.y + perp.y * 6 };
      const t2 = { x: tickC.x - perp.x * 6, y: tickC.y - perp.y * 6 };
      parts.push(
        `<line x1="${t1.x}" y1="${t1.y}" x2="${t2.x}" y2="${t2.y}" stroke="${palette.relationshipLine}" stroke-width="1.4"/>`
      );
      cursor = back + 5;
    }
  } else {
    const tick1 = along(p, dir, perp, 14, 0);
    const t1a = { x: tick1.x + perp.x * 6, y: tick1.y + perp.y * 6 };
    const t1b = { x: tick1.x - perp.x * 6, y: tick1.y - perp.y * 6 };
    parts.push(
      `<line x1="${t1a.x}" y1="${t1a.y}" x2="${t1b.x}" y2="${t1b.y}" stroke="${palette.relationshipLine}" stroke-width="1.4"/>`
    );
    cursor = 14;
    if (!optional) {
      const tick2 = along(p, dir, perp, 19, 0);
      const t2a = { x: tick2.x + perp.x * 6, y: tick2.y + perp.y * 6 };
      const t2b = { x: tick2.x - perp.x * 6, y: tick2.y - perp.y * 6 };
      parts.push(
        `<line x1="${t2a.x}" y1="${t2a.y}" x2="${t2b.x}" y2="${t2b.y}" stroke="${palette.relationshipLine}" stroke-width="1.4"/>`
      );
      cursor = 19;
    }
  }

  if (optional) {
    const r = 4.5;
    const c = along(p, dir, perp, cursor + r + 6, 0);
    parts.push(
      `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${palette.background}" stroke="${palette.relationshipLine}" stroke-width="1.4"/>`
    );
  }

  return parts.join('\n');
}

function renderRelationship(r: RoutedRelationship, palette: Palette, dimmed: boolean): string {
  const title = `${r.fk.fromSchema}.${r.fk.fromTable}(${r.fk.fromColumns.join(', ')}) → ${r.fk.toSchema}.${r.fk.toTable}(${r.fk.toColumns.join(', ')})`;
  const groupClass = dimmed ? 'pgerd-relationship pgerd-dimmed' : 'pgerd-relationship';
  return `<g class="${groupClass}" data-fk="${escapeXml(r.key)}">
    <title>${escapeXml(title)}</title>
    <path class="pgerd-connector-hitbox" d="${r.pathD}" fill="none" stroke="transparent" stroke-width="14" vector-effect="non-scaling-stroke"/>
    <path class="pgerd-connector-line" d="${r.pathD}" fill="none" stroke="${palette.relationshipLine}" stroke-width="1.4"/>
    <g class="pgerd-marker">${renderMarker(r.fromMarker, palette)}</g>
    <g class="pgerd-marker">${renderMarker(r.toMarker, palette)}</g>
  </g>`;
}

export interface RenderedDiagram {
  markup: string;
  viewBox: { x: number; y: number; width: number; height: number };
}

const CANVAS_PADDING = 60;

/**
 * Click-to-highlight (ported from the Enkl.app Tables & Columns ERD): clicking a relationship
 * connector keeps its own two tables and that one connector at full opacity and dims everything
 * else; clicking a table keeps it plus every table/connector it's directly related to and dims the
 * rest; clicking whitespace clears back to fully visible. `null` from both getters below means "no
 * highlight active" -- nothing gets dimmed. A relationship click takes priority over a table
 * selection (they're mutually exclusive states, see main.ts).
 */
export function computeHighlightSets(
  relationships: RoutedRelationship[],
  selectedTableKey: string | null,
  selectedRelationshipKey: string | null
): { tableKeys: Set<string> | null; relationshipKeys: Set<string> | null } {
  if (selectedRelationshipKey) {
    const rel = relationships.find((r) => r.key === selectedRelationshipKey);
    if (rel) {
      return {
        tableKeys: new Set([tableKey(rel.fk.fromSchema, rel.fk.fromTable), tableKey(rel.fk.toSchema, rel.fk.toTable)]),
        relationshipKeys: new Set([rel.key]),
      };
    }
  }

  if (selectedTableKey) {
    const tableKeys = new Set<string>([selectedTableKey]);
    const relationshipKeys = new Set<string>();
    relationships.forEach((r) => {
      const fromKey = tableKey(r.fk.fromSchema, r.fk.fromTable);
      const toKey = tableKey(r.fk.toSchema, r.fk.toTable);
      if (fromKey === selectedTableKey || toKey === selectedTableKey) {
        tableKeys.add(fromKey);
        tableKeys.add(toKey);
        relationshipKeys.add(r.key);
      }
    });
    return { tableKeys, relationshipKeys };
  }

  return { tableKeys: null, relationshipKeys: null };
}

export function renderDiagram(
  geometry: DiagramGeometry,
  relationships: RoutedRelationship[],
  layout: DiagramLayout,
  palette: Palette,
  selectedKey: string | null,
  selectedRelationshipKey: string | null = null
): RenderedDiagram {
  const highlight = computeHighlightSets(relationships, selectedKey, selectedRelationshipKey);
  const relMarkup = relationships
    .map((r) => renderRelationship(r, palette, highlight.relationshipKeys !== null && !highlight.relationshipKeys.has(r.key)))
    .join('\n');
  const groupMarkup = geometry.groups.map((g) => renderGroupContainer(g, palette, layout)).join('\n');
  const tableMarkup = [...geometry.tables.values()]
    .map((box) =>
      renderTableBox(
        box,
        palette,
        box.key === selectedKey,
        highlight.tableKeys !== null && !highlight.tableKeys.has(box.key)
      )
    )
    .join('\n');

  // Collapsed groups render as a stacked list of chips to the LEFT of the visible diagram,
  // top-aligned with it -- a fixed gutter clear of the leftmost table/group, one chip per row
  // (CHIP_HEIGHT + CHIP_GAP apart), each right-aligned against that gutter so varying name
  // lengths don't produce a ragged left edge. Deliberately NOT tied to any group's own clustered
  // position (unlike a visible group's container) -- collapsing removes a group from the
  // relationship-driven layout entirely, so its chip lives in its own separate column instead.
  const collapsedNames = layout.collapsedGroups;
  const CHIP_GAP = 10;
  const CHIP_STACK_GUTTER = 30;
  const chipWidths = collapsedNames.map((name) => estimateChipWidth(name));
  const maxChipWidth = chipWidths.length > 0 ? Math.max(...chipWidths) : 0;
  const stackLeftX = geometry.bounds.minX - CHIP_STACK_GUTTER - maxChipWidth;
  const chipMarkup = collapsedNames
    .map((name, i) => {
      const w = chipWidths[i];
      const x = stackLeftX + (maxChipWidth - w); // right-align each chip within the stack's column
      const y = geometry.bounds.minY + i * (CHIP_HEIGHT + CHIP_GAP);
      return renderCollapsedChip(name, x, y, w, palette, layout);
    })
    .join('\n');
  const stackHeight =
    collapsedNames.length > 0 ? collapsedNames.length * CHIP_HEIGHT + (collapsedNames.length - 1) * CHIP_GAP : 0;

  const contentMinX = maxChipWidth > 0 ? stackLeftX : geometry.bounds.minX;
  const minX = contentMinX - CANVAS_PADDING;
  const minY = geometry.bounds.minY - CANVAS_PADDING;
  const width = geometry.bounds.maxX - contentMinX + CANVAS_PADDING * 2;
  const height = Math.max(geometry.bounds.maxY - geometry.bounds.minY, stackHeight) + CANVAS_PADDING * 2;

  const markup = `<g class="pgerd-relationships">${relMarkup}</g>
    <g class="pgerd-groups">${groupMarkup}</g>
    <g class="pgerd-tables">${tableMarkup}</g>
    <g class="pgerd-chips">${chipMarkup}</g>`;

  return { markup, viewBox: { x: minX, y: minY, width: Math.max(width, 200), height: Math.max(height, 200) } };
}

export function buildStandaloneSvg(rendered: RenderedDiagram, palette: Palette): string {
  const { x, y, width, height } = rendered.viewBox;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width}" height="${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
  <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${palette.background}"/>
  ${rendered.markup}
</svg>`;
}
