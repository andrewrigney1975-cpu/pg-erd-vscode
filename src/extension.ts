import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { promptConnectionInput } from './connectionForm';
import { ConnectionTreeItem, ConnectionsTreeProvider } from './connectionsTreeProvider';
import { ErdPanelManager } from './erdPanel';
import { testConnection } from './pgIntrospection';
import { ConnectionProfileInput } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const connectionManager = new ConnectionManager(context);
  const treeProvider = new ConnectionsTreeProvider(connectionManager);
  const erdPanelManager = new ErdPanelManager(context, connectionManager);

  vscode.window.registerTreeDataProvider('pgErdConnectionsView', treeProvider);

  async function testConnectionWithProgress(input: ConnectionProfileInput): Promise<boolean> {
    const timeoutMs = vscode.workspace.getConfiguration('pgErd').get<number>('connectionTimeoutMs', 10000);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Testing connection to "${input.name}"...` },
        () =>
          testConnection(
            {
              id: '',
              name: input.name,
              host: input.host,
              port: input.port,
              username: input.username,
              database: input.database,
              ssl: input.ssl,
            },
            input.password,
            timeoutMs
          )
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Connection test failed: ${message}`);
      return false;
    }
  }

  async function confirmSaveDespiteFailure(name: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `Could not connect to "${name}". Save the connection anyway?`,
      { modal: true },
      'Save Anyway'
    );
    return choice === 'Save Anyway';
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('pgErd.addConnection', async () => {
      const input = await promptConnectionInput();
      if (!input) {
        return;
      }
      const ok = await testConnectionWithProgress(input);
      if (!ok && !(await confirmSaveDespiteFailure(input.name))) {
        return;
      }
      const profile = await connectionManager.add(input);
      vscode.window.showInformationMessage(`Connection "${profile.name}" saved.`);
    }),

    vscode.commands.registerCommand('pgErd.editConnection', async (item?: ConnectionTreeItem) => {
      if (!item) {
        return;
      }
      const input = await promptConnectionInput(item.profile);
      if (!input) {
        return;
      }
      const passwordForTest = input.password || (await connectionManager.getPassword(item.profile.id)) || '';
      const ok = await testConnectionWithProgress({ ...input, password: passwordForTest });
      if (!ok && !(await confirmSaveDespiteFailure(input.name))) {
        return;
      }
      await connectionManager.update(item.profile.id, input);
      vscode.window.showInformationMessage(`Connection "${input.name}" updated.`);
    }),

    vscode.commands.registerCommand('pgErd.deleteConnection', async (item?: ConnectionTreeItem) => {
      if (!item) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete connection "${item.profile.name}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') {
        return;
      }
      await connectionManager.delete(item.profile.id);
    }),

    vscode.commands.registerCommand('pgErd.duplicateConnection', async (item?: ConnectionTreeItem) => {
      if (!item) {
        return;
      }
      const copy = await connectionManager.duplicate(item.profile.id);
      vscode.window.showInformationMessage(`Duplicated as "${copy.name}".`);
    }),

    vscode.commands.registerCommand('pgErd.openErd', async (item?: ConnectionTreeItem) => {
      let profile = item?.profile;
      if (!profile) {
        const all = connectionManager.list();
        if (all.length === 0) {
          const choice = await vscode.window.showInformationMessage(
            'No saved connections yet.',
            'Add Connection'
          );
          if (choice === 'Add Connection') {
            await vscode.commands.executeCommand('pgErd.addConnection');
          }
          return;
        }
        const pick = await vscode.window.showQuickPick(
          all.map((c) => ({
            label: c.name,
            description: `${c.username}@${c.host}:${c.port}/${c.database}`,
            profile: c,
          })),
          { placeHolder: 'Select a connection to open' }
        );
        if (!pick) {
          return;
        }
        profile = pick.profile;
      }
      await erdPanelManager.openForConnection(profile);
    }),

    vscode.commands.registerCommand('pgErd.refreshConnections', () => treeProvider.refresh())
  );
}

export function deactivate(): void {}
