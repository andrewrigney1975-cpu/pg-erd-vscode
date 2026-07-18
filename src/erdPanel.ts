import * as vscode from 'vscode';
import { ConnectionManager, layoutKey } from './connectionManager';
import { IntrospectionOptions, introspectDatabase } from './pgIntrospection';
import {
  ConnectionProfile,
  DiagramLayout,
  ExportPngMessage,
  ExportSvgMessage,
  ManageGroupsRequestMessage,
  ThemeKind,
  WebviewToHostMessage,
  normalizeLayout,
  tableKey,
} from './types';

export class ErdPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager
  ) {}

  async openForConnection(profile: ConnectionProfile): Promise<void> {
    const existing = this.panels.get(profile.id);
    if (existing) {
      existing.reveal();
      // Re-fetch rather than just showing whatever was last loaded -- otherwise editing a
      // connection (e.g. fixing a wrong database name) and reopening it from the tree would
      // keep showing the stale/empty diagram from the first attempt.
      await this.sendInit(existing, profile);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'pgErdView',
      `ERD: ${profile.name}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
      }
    );
    panel.webview.html = this.buildHtml(panel.webview);
    this.panels.set(profile.id, panel);

    const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
      panel.webview.postMessage({ type: 'themeChanged', theme: themeKind() });
    });

    panel.onDidDispose(() => {
      this.panels.delete(profile.id);
      themeListener.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewToHostMessage) => {
      switch (msg.type) {
        case 'ready':
          await this.sendInit(panel, profile);
          break;
        case 'saveLayout':
          await this.saveLayout(profile.id, msg.layout);
          break;
        case 'exportSvg':
          await this.exportSvg(msg);
          break;
        case 'exportPng':
          await this.exportPng(msg);
          break;
        case 'requestRefresh':
          await this.refresh(panel, profile);
          break;
        case 'manageGroupsRequest':
          await this.manageGroups(panel, profile, msg);
          break;
      }
    });
  }

  private async sendInit(panel: vscode.WebviewPanel, profile: ConnectionProfile): Promise<void> {
    try {
      const password = (await this.connectionManager.getPassword(profile.id)) ?? '';
      const database = await introspectDatabase(profile, password, getIntrospectionOptions());
      const layout = this.loadLayout(profile.id);
      panel.webview.postMessage({
        type: 'init',
        connectionName: profile.name,
        theme: themeKind(),
        database,
        layout,
        maxSchemaColumns: getMaxSchemaColumns(),
      });
    } catch (err) {
      const message = friendlyError(err);
      panel.webview.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`Failed to connect to "${profile.name}": ${message}`);
    }
  }

  private async refresh(panel: vscode.WebviewPanel, profile: ConnectionProfile): Promise<void> {
    try {
      const password = (await this.connectionManager.getPassword(profile.id)) ?? '';
      const database = await introspectDatabase(profile, password, getIntrospectionOptions());
      panel.webview.postMessage({ type: 'refreshed', database, maxSchemaColumns: getMaxSchemaColumns() });
    } catch (err) {
      const message = friendlyError(err);
      panel.webview.postMessage({ type: 'error', message });
      vscode.window.showErrorMessage(`Failed to refresh "${profile.name}": ${message}`);
    }
  }

  /**
   * Bulk "assign tables to a group" flow: pick or create a group name, then a multi-select
   * QuickPick over every table (pre-checked by current membership) decides who's in it. This
   * is deliberately a bulk operation rather than one-table-at-a-time -- the whole point is to
   * bucket a schema's worth of tables (dozens, easily) into a handful of named groups without
   * touching the database, so it needs to be fast for that many tables at once.
   */
  private async manageGroups(
    panel: vscode.WebviewPanel,
    profile: ConnectionProfile,
    msg: ManageGroupsRequestMessage
  ): Promise<void> {
    const layout = this.loadLayout(profile.id);
    const existingGroups = [...new Set(Object.values(layout.tableGroupOverrides))].sort((a, b) =>
      a.localeCompare(b)
    );

    const NEW_GROUP_ITEM = '$(add) Create new group…';
    const groupPick = await vscode.window.showQuickPick(
      [...existingGroups, NEW_GROUP_ITEM],
      {
        title: 'Manage Table Groups (1/2)',
        placeHolder: 'Pick a group to edit, or create a new one',
        ignoreFocusOut: true,
      }
    );
    if (!groupPick) {
      return;
    }

    let groupName = groupPick;
    if (groupPick === NEW_GROUP_ITEM) {
      const name = await vscode.window.showInputBox({
        title: 'New group name',
        prompt: 'e.g. Operational, Governance, Administration',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
      });
      if (!name) {
        return;
      }
      groupName = name.trim();
    }

    const sortedTables = [...msg.tables].sort((a, b) =>
      `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)
    );
    const tableItems = sortedTables.map((t) => {
      const key = tableKey(t.schema, t.name);
      return {
        label: `${t.schema}.${t.name}`,
        picked: layout.tableGroupOverrides[key] === groupName,
        key,
      };
    });

    const picked = await vscode.window.showQuickPick(tableItems, {
      title: `Manage Table Groups (2/2) — "${groupName}"`,
      placeHolder: 'Check every table that belongs to this group',
      canPickMany: true,
      ignoreFocusOut: true,
    });
    if (picked === undefined) {
      return;
    }

    const pickedKeys = new Set(picked.map((p) => p.key));
    for (const item of tableItems) {
      if (pickedKeys.has(item.key)) {
        layout.tableGroupOverrides[item.key] = groupName;
      } else if (layout.tableGroupOverrides[item.key] === groupName) {
        delete layout.tableGroupOverrides[item.key];
      }
    }

    await this.saveLayout(profile.id, layout);
    panel.webview.postMessage({ type: 'layoutUpdated', layout });
  }

  private loadLayout(connectionId: string): DiagramLayout {
    return normalizeLayout(this.context.globalState.get(layoutKey(connectionId)));
  }

  private async saveLayout(connectionId: string, layout: DiagramLayout): Promise<void> {
    await this.context.globalState.update(layoutKey(connectionId), layout);
  }

  private async exportSvg(msg: ExportSvgMessage): Promise<void> {
    await this.saveWithDialog(Buffer.from(msg.svg, 'utf8'), msg.suggestedName, 'SVG image', ['svg']);
  }

  private async exportPng(msg: ExportPngMessage): Promise<void> {
    const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, '');
    await this.saveWithDialog(Buffer.from(base64, 'base64'), msg.suggestedName, 'PNG image', ['png']);
  }

  private async saveWithDialog(
    data: Buffer,
    suggestedName: string,
    filterLabel: string,
    extensions: string[]
  ): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      filters: { [filterLabel]: extensions },
      defaultUri: vscode.Uri.file(suggestedName),
    });
    if (!uri) {
      return;
    }
    await vscode.workspace.fs.writeFile(uri, data);
    const openIt = await vscode.window.showInformationMessage(
      `ERD exported to ${uri.fsPath}`,
      'Reveal in Explorer'
    );
    if (openIt) {
      await vscode.commands.executeCommand('revealFileInOS', uri);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'style.css')
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>PostgreSQL ERD</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <span id="connectionTitle" class="title"></span>
      <div class="spacer"></div>
      <button id="zoomOutBtn" title="Zoom out">&minus;</button>
      <button id="zoomInBtn" title="Zoom in">+</button>
      <button id="resetBtn" title="Reset view">Reset</button>
      <button id="refreshBtn" title="Re-read schema from the database">Refresh</button>
      <button id="groupsBtn" title="Bucket tables into custom named groups, independent of their real schema">Groups…</button>
      <button id="exportBtn" class="primary" title="Export as SVG">Export SVG</button>
      <button id="exportPngBtn" class="primary" title="Export as a 4x-resolution PNG">Export PNG (4x)</button>
    </div>
    <div id="errorBanner" class="hidden"></div>
    <div id="canvasWrap">
      <svg id="erdSvg" xmlns="http://www.w3.org/2000/svg"></svg>
      <div id="emptyState">
        <p>No tables found in this database.</p>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getIntrospectionOptions(): IntrospectionOptions {
  const config = vscode.workspace.getConfiguration('pgErd');
  return {
    includeSystemSchemas: config.get<boolean>('includeSystemSchemas', false),
    connectionTimeoutMs: config.get<number>('connectionTimeoutMs', 10000),
  };
}

function getMaxSchemaColumns(): number {
  return vscode.workspace.getConfiguration('pgErd').get<number>('maxSchemaColumns', 20);
}

function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast-light';
    default:
      return 'dark';
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
