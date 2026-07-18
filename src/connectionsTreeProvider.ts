import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ConnectionProfile } from './types';

export class ConnectionTreeItem extends vscode.TreeItem {
  constructor(public readonly profile: ConnectionProfile) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    this.description = `${profile.username}@${profile.host}:${profile.port}/${profile.database}`;
    this.tooltip = new vscode.MarkdownString(
      `**${profile.name}**\n\n` +
        `Host: \`${profile.host}:${profile.port}\`\n\n` +
        `Database: \`${profile.database}\`\n\n` +
        `User: \`${profile.username}\`\n\n` +
        `SSL: ${profile.ssl ? 'enabled' : 'disabled'}`
    );
    this.iconPath = new vscode.ThemeIcon('database');
    this.contextValue = 'pgErdConnection';
    this.command = {
      command: 'pgErd.openErd',
      title: 'Open ERD',
      arguments: [this],
    };
  }
}

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly connectionManager: ConnectionManager) {
    connectionManager.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConnectionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConnectionTreeItem): ConnectionTreeItem[] {
    if (element) {
      return [];
    }
    return this.connectionManager.list().map((profile) => new ConnectionTreeItem(profile));
  }
}
