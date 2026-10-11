/** Tag on every window.postMessage between the page script and the content script. */
export const CHANNEL = 'multisig-wallet/v1';

export type Mode = 'sign' | 'execute';

export interface SignResult {
  bytes: string;
  signature: string;
  digest?: string;
  effects?: string;
}

/** Page script -> extension. */
export type PageRequest =
  | { type: 'connect'; requestId: string; silent: boolean }
  | { type: 'transaction'; requestId: string; mode: Mode; txJson: string }
  | { type: 'desktop-signed'; requestId: string; bytes: string; signature: string }
  | { type: 'desktop-failed'; requestId: string; message: string };

/** Extension -> page script. */
export type PageEvent =
  | { type: 'connect-result'; requestId: string; approved: boolean }
  | { type: 'desktop-sign'; requestId: string; txBytes: string; desktopAddress: string }
  | { type: 'transaction-result'; requestId: string; ok: true; result: SignResult }
  | { type: 'transaction-result'; requestId: string; ok: false; message: string };

/** Approval window <-> background. */
export type WindowToBackground =
  | { type: 'hello'; requestId: string }
  | { type: 'connect-decision'; requestId: string; approved: boolean }
  | { type: 'desktop-sign'; requestId: string; txBytes: string; desktopAddress: string }
  | { type: 'done'; requestId: string; ok: true; result: SignResult }
  | { type: 'done'; requestId: string; ok: false; message: string };

export type BackgroundToWindow =
  | { type: 'connect-request'; origin: string }
  | { type: 'transaction-request'; origin: string; mode: Mode; txJson: string }
  | { type: 'desktop-signed'; bytes: string; signature: string }
  | { type: 'desktop-failed'; message: string };

export interface Envelope<T> {
  channel: typeof CHANNEL;
  direction: 'to-extension' | 'to-page';
  message: T;
}
