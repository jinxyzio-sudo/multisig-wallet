// Routes messages between pages and approval windows. All decisions happen in the approval
// window; this worker only remembers which page and which window belong to a request.
import type { BackgroundToWindow, Mode, PageEvent, PageRequest, WindowToBackground } from './messages.js';

interface Pending {
  kind: 'connect' | 'transaction';
  origin: string;
  page: chrome.runtime.Port;
  window?: chrome.runtime.Port;
  windowId?: number;
  mode?: Mode;
  txJson?: string;
  settled: boolean;
}

const pending = new Map<string, Pending>();
const APPROVED_KEY = 'approvedOrigins';

async function approvedOrigins(): Promise<string[]> {
  const stored = await chrome.storage.local.get(APPROVED_KEY);
  const list = stored[APPROVED_KEY];
  return Array.isArray(list) ? (list as string[]) : [];
}

async function approveOrigin(origin: string): Promise<void> {
  const list = await approvedOrigins();
  if (!list.includes(origin)) await chrome.storage.local.set({ [APPROVED_KEY]: [...list, origin] });
}

function toPage(entry: Pending, event: PageEvent): void {
  try {
    entry.page.postMessage(event);
  } catch {
    // page navigated away
  }
}

function toWindow(entry: Pending, message: BackgroundToWindow): void {
  try {
    entry.window?.postMessage(message);
  } catch {
    // window closed
  }
}

async function openWindow(requestId: string, entry: Pending): Promise<void> {
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`approve.html?r=${encodeURIComponent(requestId)}`),
    type: 'popup',
    width: 460,
    height: 820,
    focused: true,
  });
  entry.windowId = created?.id;
}

function reject(requestId: string, entry: Pending, message: string): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.kind === 'connect') toPage(entry, { type: 'connect-result', requestId, approved: false });
  else toPage(entry, { type: 'transaction-result', requestId, ok: false, message });
  pending.delete(requestId);
}

async function onPage(page: chrome.runtime.Port, origin: string, message: PageRequest): Promise<void> {
  const { requestId } = message;
  switch (message.type) {
    case 'connect': {
      if ((await approvedOrigins()).includes(origin)) {
        page.postMessage({ type: 'connect-result', requestId, approved: true } satisfies PageEvent);
        return;
      }
      if (message.silent) {
        page.postMessage({ type: 'connect-result', requestId, approved: false } satisfies PageEvent);
        return;
      }
      const entry: Pending = { kind: 'connect', origin, page, settled: false };
      pending.set(requestId, entry);
      await openWindow(requestId, entry);
      return;
    }
    case 'transaction': {
      if (!(await approvedOrigins()).includes(origin)) {
        page.postMessage({ type: 'transaction-result', requestId, ok: false, message: 'Site is not connected' } satisfies PageEvent);
        return;
      }
      const entry: Pending = { kind: 'transaction', origin, page, mode: message.mode, txJson: message.txJson, settled: false };
      pending.set(requestId, entry);
      await openWindow(requestId, entry);
      return;
    }
    case 'desktop-signed': {
      const entry = pending.get(requestId);
      if (entry?.page === page) toWindow(entry, { type: 'desktop-signed', bytes: message.bytes, signature: message.signature });
      return;
    }
    case 'desktop-failed': {
      const entry = pending.get(requestId);
      if (entry?.page === page) toWindow(entry, { type: 'desktop-failed', message: message.message });
      return;
    }
  }
}

async function onWindow(win: chrome.runtime.Port, message: WindowToBackground): Promise<void> {
  const entry = pending.get(message.requestId);
  if (!entry) {
    win.disconnect();
    return;
  }
  switch (message.type) {
    case 'hello':
      entry.window = win;
      if (entry.kind === 'connect') toWindow(entry, { type: 'connect-request', origin: entry.origin });
      else toWindow(entry, { type: 'transaction-request', origin: entry.origin, mode: entry.mode!, txJson: entry.txJson! });
      return;
    case 'connect-decision':
      if (entry.window !== win || entry.kind !== 'connect' || entry.settled) return;
      // Settle before awaiting: the window closes right after sending this, and its disconnect
      // handler must not turn the approval into a rejection.
      entry.settled = true;
      pending.delete(message.requestId);
      if (message.approved) await approveOrigin(entry.origin);
      toPage(entry, { type: 'connect-result', requestId: message.requestId, approved: message.approved });
      return;
    case 'desktop-sign':
      if (entry.window !== win) return;
      toPage(entry, { type: 'desktop-sign', requestId: message.requestId, txBytes: message.txBytes, desktopAddress: message.desktopAddress });
      return;
    case 'done':
      if (entry.window !== win || entry.settled) return;
      entry.settled = true;
      toPage(
        entry,
        message.ok
          ? { type: 'transaction-result', requestId: message.requestId, ok: true, result: message.result }
          : { type: 'transaction-result', requestId: message.requestId, ok: false, message: message.message },
      );
      pending.delete(message.requestId);
      return;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'page') {
    const sender = port.sender;
    const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : '');
    if (!origin || sender?.tab === undefined) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((m: PageRequest) => void onPage(port, origin, m));
    port.onDisconnect.addListener(() => {
      for (const [id, entry] of pending) {
        if (entry.page !== port) continue;
        entry.settled = true;
        pending.delete(id);
        if (entry.windowId !== undefined) void chrome.windows.remove(entry.windowId).catch(() => undefined);
      }
    });
    return;
  }
  if (port.name === 'approve') {
    if (port.sender?.id !== chrome.runtime.id || !port.sender.url?.startsWith(chrome.runtime.getURL('approve.html'))) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((m: WindowToBackground) => void onWindow(port, m));
    port.onDisconnect.addListener(() => {
      for (const [id, entry] of pending) {
        if (entry.window === port) reject(id, entry, 'User rejected the request');
      }
    });
  }
});

// Closing the window before it connected still has to reject the request.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, entry] of pending) {
    if (entry.windowId === windowId) reject(id, entry, 'User rejected the request');
  }
});
