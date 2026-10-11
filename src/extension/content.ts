// Isolated-world bridge between the page script and the background service worker.
import { CHANNEL, type Envelope, type PageEvent, type PageRequest } from './messages.js';

let port: chrome.runtime.Port | null = null;

function getPort(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: 'page' });
  p.onMessage.addListener((message: PageEvent) => {
    const envelope: Envelope<PageEvent> = { channel: CHANNEL, direction: 'to-page', message };
    window.postMessage(envelope, '*');
  });
  p.onDisconnect.addListener(() => {
    port = null;
  });
  port = p;
  return p;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Envelope<PageRequest> | undefined;
  if (data?.channel !== CHANNEL || data.direction !== 'to-extension') return;
  getPort().postMessage(data.message);
});
