import * as vscode from 'vscode';
import { ConnectionProfile, ConnectionProfileInput } from './types';

const TOTAL_STEPS = 7;

/**
 * Sequential input-box flow for adding/editing a connection profile.
 * Returns undefined if the user cancels at any step.
 */
export async function promptConnectionInput(
  existing?: ConnectionProfile
): Promise<ConnectionProfileInput | undefined> {
  const isEdit = !!existing;

  const name = await vscode.window.showInputBox({
    title: `${isEdit ? 'Edit' : 'Add'} Connection (1/${TOTAL_STEPS})`,
    prompt: 'A name for this connection',
    value: existing?.name ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
  });
  if (name === undefined) {
    return undefined;
  }

  const host = await vscode.window.showInputBox({
    title: `${isEdit ? 'Edit' : 'Add'} Connection (2/${TOTAL_STEPS})`,
    prompt: 'Database host',
    value: existing?.host ?? 'localhost',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Host cannot be empty' : undefined),
  });
  if (host === undefined) {
    return undefined;
  }

  const portStr = await vscode.window.showInputBox({
    title: `${isEdit ? 'Edit' : 'Add'} Connection (3/${TOTAL_STEPS})`,
    prompt: 'Database port',
    value: String(existing?.port ?? 5432),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 && n <= 65535 ? undefined : 'Port must be a number between 1 and 65535';
    },
  });
  if (portStr === undefined) {
    return undefined;
  }

  const username = await vscode.window.showInputBox({
    title: `${isEdit ? 'Edit' : 'Add'} Connection (4/${TOTAL_STEPS})`,
    prompt: 'Database username',
    value: existing?.username ?? 'postgres',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Username cannot be empty' : undefined),
  });
  if (username === undefined) {
    return undefined;
  }

  const password = await vscode.window.showInputBox({
    title: `${isEdit ? 'Edit' : 'Add'} Connection (5/${TOTAL_STEPS})`,
    prompt: isEdit
      ? 'Password (leave blank to keep the currently saved password)'
      : 'Password',
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    return undefined;
  }
  if (!isEdit && password.length === 0) {
    const proceed = await vscode.window.showWarningMessage(
      'No password entered. Continue with an empty password?',
      { modal: true },
      'Continue'
    );
    if (proceed !== 'Continue') {
      return undefined;
    }
  }

  const database = await vscode.window.showInputBox({
    title: `${isEdit ? 'Edit' : 'Add'} Connection (6/${TOTAL_STEPS})`,
    prompt: 'Database name',
    value: existing?.database ?? 'postgres',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Database name cannot be empty' : undefined),
  });
  if (database === undefined) {
    return undefined;
  }

  const sslPick = await vscode.window.showQuickPick(
    [
      { label: 'Disabled', picked: !(existing?.ssl ?? false) },
      { label: 'Enabled', picked: existing?.ssl ?? false },
    ],
    {
      title: `${isEdit ? 'Edit' : 'Add'} Connection (7/${TOTAL_STEPS})`,
      placeHolder: 'Use SSL for this connection?',
      ignoreFocusOut: true,
    }
  );
  if (sslPick === undefined) {
    return undefined;
  }

  return {
    name: name.trim(),
    host: host.trim(),
    port: Number(portStr),
    username: username.trim(),
    password,
    database: database.trim(),
    ssl: sslPick.label === 'Enabled',
  };
}
