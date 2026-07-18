import { HostToWebviewMessage, WebviewToHostMessage } from '../src/types';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

export function postToHost(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

export function onHostMessage(handler: (message: HostToWebviewMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
    handler(event.data);
  });
}
