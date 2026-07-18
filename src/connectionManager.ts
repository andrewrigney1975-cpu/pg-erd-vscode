import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ConnectionProfile, ConnectionProfileInput } from './types';

const CONNECTIONS_KEY = 'pgErd.connections';
const SECRET_PREFIX = 'pgErd.password.';

/**
 * Owns persistence for saved connection profiles. Non-secret fields live in
 * globalState (plain JSON, visible in state db); the password never touches
 * globalState and is stored only in VS Code's SecretStorage, keyed per connection id.
 */
export class ConnectionManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): ConnectionProfile[] {
    const raw = this.context.globalState.get<ConnectionProfile[]>(CONNECTIONS_KEY, []);
    return [...raw].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((c) => c.id === id);
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + id);
  }

  async add(input: ConnectionProfileInput): Promise<ConnectionProfile> {
    const profile: ConnectionProfile = {
      id: randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      database: input.database,
      ssl: input.ssl,
    };
    const all = this.readAll();
    all.push(profile);
    await this.writeAll(all);
    await this.context.secrets.store(SECRET_PREFIX + profile.id, input.password);
    this._onDidChange.fire();
    return profile;
  }

  async update(id: string, input: ConnectionProfileInput): Promise<ConnectionProfile> {
    const all = this.readAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) {
      throw new Error(`Connection ${id} not found`);
    }
    const updated: ConnectionProfile = {
      id,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      database: input.database,
      ssl: input.ssl,
    };
    all[idx] = updated;
    await this.writeAll(all);
    if (input.password) {
      await this.context.secrets.store(SECRET_PREFIX + id, input.password);
    }
    this._onDidChange.fire();
    return updated;
  }

  async delete(id: string): Promise<void> {
    const all = this.readAll().filter((c) => c.id !== id);
    await this.writeAll(all);
    await this.context.secrets.delete(SECRET_PREFIX + id);
    await this.context.globalState.update(layoutKey(id), undefined);
    this._onDidChange.fire();
  }

  async duplicate(id: string): Promise<ConnectionProfile> {
    const source = this.get(id);
    if (!source) {
      throw new Error(`Connection ${id} not found`);
    }
    const password = (await this.getPassword(id)) ?? '';
    const copy: ConnectionProfile = {
      ...source,
      id: randomUUID(),
      name: uniqueCopyName(source.name, this.list().map((c) => c.name)),
    };
    const all = this.readAll();
    all.push(copy);
    await this.writeAll(all);
    await this.context.secrets.store(SECRET_PREFIX + copy.id, password);
    this._onDidChange.fire();
    return copy;
  }

  private readAll(): ConnectionProfile[] {
    return this.context.globalState.get<ConnectionProfile[]>(CONNECTIONS_KEY, []);
  }

  private async writeAll(connections: ConnectionProfile[]): Promise<void> {
    await this.context.globalState.update(CONNECTIONS_KEY, connections);
  }
}

export function layoutKey(connectionId: string): string {
  return `pgErd.layout.${connectionId}`;
}

function uniqueCopyName(base: string, existing: string[]): string {
  let candidate = `${base} (copy)`;
  let n = 2;
  while (existing.includes(candidate)) {
    candidate = `${base} (copy ${n})`;
    n += 1;
  }
  return candidate;
}
