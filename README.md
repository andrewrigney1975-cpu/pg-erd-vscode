# PostgreSQL ERD

A VS Code extension that generates interactive, theme-aware SVG entity-relationship diagrams from a
live PostgreSQL database. No Electron webview frameworks, no charting library — the diagram is
hand-rolled inline SVG, same as the rest of a normal VS Code extension.

## Features

- **Saved connections** — a sidebar (Activity Bar icon) lists named connections (host, port, username,
  password, database, SSL). Passwords are stored in VS Code's `SecretStorage`, never in plain
  settings/state.
- **Live schema introspection** — reads `pg_catalog` directly (not just `information_schema`) to get
  accurate primary keys, foreign keys (including composite and self-referencing), uniqueness, and
  nullability.
- **Schema-grouped containers** — each Postgres schema becomes a dashed container box, grouping tables
  that share a common function (`public`, `billing`, `auth`, ...). Click a schema's header to
  collapse/expand it — collapsed groups show as small pill-shaped chips stacked in a column to the
  left of the visible diagram, top-aligned with it.
- **Custom table groups** — if your real schema doesn't already split things up the way you'd like
  visually (e.g. everything lives in one big `public` schema), the **Groups…** toolbar button lets you
  bucket tables into your own named groups (e.g. "Operational", "Governance", "Administration") that
  render as the same dashed containers, entirely independent of the real Postgres schema — no database
  changes required. It's a bulk operation: pick or create a group name, then check off every table
  that belongs to it from a multi-select list. Tables left ungrouped stay in their real schema's
  container.
- **Relationship-clustered auto layout** — tables within a group, and groups within the diagram,
  are ordered by foreign-key relationship proximity (not alphabetically): directly-related tables
  land in the same or neighboring grid cells, and groups with more cross-group relationships end up
  positioned closer together. Still a plain grid/masonry packer under the hood (deterministic,
  overlap-free by construction, consistent spacing around every group) — clustering only changes
  the visiting order fed into it, never the packing mechanics themselves.
- **Standard crow's-foot ER notation** — mandatory/optional, one/many markers derived from real FK
  nullability and uniqueness; a key glyph on primary-key columns and a link glyph on foreign-key
  columns.
- **Orthogonal connectors** — 90° Manhattan routing between the FK and PK column rows, with true
  circular 8px-radius fillets at every bend (not an approximation — verified analytically and via a
  runtime harness during development). Routing picks whichever of left/right or top/bottom exits
  matches how the two tables are actually separated, so two tables stacked in the same auto-layout
  grid column route vertically instead of backtracking through the source table.
- **Pan, zoom, reset, export** — mouse-wheel zoom, drag-to-pan, a "Reset View" button that returns
  to a fit-all view, a "Reset Layout" button (confirmation required) that clears every manually-
  dragged table position and lets the auto-layout place everything again — Groups and collapsed
  state are kept — "Export SVG" (a fully standalone, self-contained SVG file — theme colors are
  resolved and inlined at export time, so it renders correctly outside VS Code too), and "Export
  PNG (2x)" (rasterized in the webview via `<canvas>`, no extra dependency).
- **Draggable layout, persisted per connection** — drag any table to reposition it; the layout
  (positions, pan/zoom, collapsed schemas) is saved automatically and restored next time you open
  that connection's ERD.
- **Theme-aware** — every color is read from the active VS Code theme's `--vscode-*` CSS variables at
  render time, so the diagram repaints automatically when you switch themes.
- **Click-to-highlight** — click a table to dim every table and connector it isn't directly related
  to; click a relationship connector to dim everything except its own two tables and that one
  connector; click empty canvas to clear back to fully visible. The view also smoothly pans/zooms
  to fit whatever is currently highlighted, easing back to the default fit-all view once cleared.

## Using it

1. Open the **PostgreSQL ERD** icon in the Activity Bar.
2. Click **Add Connection** (or the `+` in the view title bar) and fill in the connection details.
   The extension will test the connection before saving (you can still save if the test fails).
3. Click the saved connection to open its ERD. Use the toolbar to zoom/reset/export, drag tables to
   rearrange them, click a schema's header to collapse it, or use **Groups…** to organize tables into
   your own named containers.
4. Right-click a connection for Edit / Duplicate / Delete.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pgErd.connectionTimeoutMs` | `10000` | Connection timeout when introspecting or testing a connection. |
| `pgErd.includeSystemSchemas` | `false` | Include `pg_catalog`/`information_schema`/`pg_toast` when introspecting. |
| `pgErd.maxSchemaColumns` | `20` | Upper bound on columns in a schema's auto-layout grid. The column count is otherwise chosen automatically so each schema's diagram comes out close to a 16:10 (width:height) box; this setting only caps how far that search is allowed to go. Lower it to force a narrower, taller layout. Takes effect next time the ERD is opened or refreshed. |

## Development

```
npm install
npm run compile      # bundles extension + webview into dist/
npm run watch        # same, in watch mode
npm run typecheck    # tsc --noEmit only
```

Press `F5` in VS Code (with this folder open) to launch an Extension Development Host with the
extension loaded.

## Architecture

- `src/` — the extension host (Node): connection persistence (`connectionManager.ts`), the sidebar
  tree (`connectionsTreeProvider.ts`), the add/edit connection input flow (`connectionForm.ts`),
  PostgreSQL introspection (`pgIntrospection.ts`), and the webview panel host (`erdPanel.ts`).
- `webview/` — the browser-side bundle: layout (`layout.ts`), orthogonal routing with fillets
  (`routing.ts`), SVG string rendering (`erdRenderer.ts`), theme resolution (`theme.ts`), pan/zoom
  (`panzoom.ts`), and the entry point wiring it all together (`main.ts`).
- `src/types.ts` — shared types and the webview↔host message protocol, imported by both sides
  unchanged.
- `esbuild.js` — bundles `src/extension.ts` (Node/CJS, `vscode` external) and `webview/main.ts`
  (browser/IIFE) separately, and copies `webview/style.css` into `dist/webview/`.

Two backend concerns intentionally live only in the extension host, never the webview: the actual
`pg` connection (webviews can't hold a raw DB connection or the plaintext password) and the SVG export
file write (webviews can't touch the filesystem directly — they post the finished SVG string back to
the host, which shows a native save dialog).

## Known limitations (v1)

- Connector routing is a direct Manhattan route between the two anchor points — it does not perform
  obstacle avoidance around unrelated tables. In dense diagrams a line can visually cross over an
  unrelated table.
- Auto-layout is a deterministic grid per schema, not a force-directed layout. The column count is
  chosen automatically by actually packing the grid at every candidate column count (1 up to
  `pgErd.maxSchemaColumns`) and picking whichever produces a width:height ratio closest to 16:10 —
  this is evaluated per schema, so multiple schemas side by side don't jointly target 16:10 as one
  diagram. It's intentionally simple and reproducible; drag tables manually for a cleaner arrangement,
  which then persists.
- One FK constraint draws one connector, anchored at its first column, even when the constraint is
  composite (spans multiple columns) — standard practice in most ER tools, but the diagram doesn't
  draw a separate line per column pair.
- "Export PNG (2x)" is capped by the browser's ~16384px-per-side canvas limit. An extremely large
  diagram (many schemas, `pgErd.maxSchemaColumns` set high) can still exceed that even at 2x; the
  export fails with an explicit error telling you to use "Export SVG" instead or collapse some
  schemas first, rather than silently producing a blank image.
