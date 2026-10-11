// Runs the relay handler on Node with in-memory storage, for local testing only.
import { createServer, type Server } from 'node:http';
import { handle, MemoryStore } from './handler.js';

export interface LocalRelay {
  url: string;
  close(): Promise<void>;
}

export function startLocalRelay(port = 0, host = '127.0.0.1'): Promise<LocalRelay> {
  const store = new MemoryStore();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
    const request = new Request(`http://${host}${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await handle(request, store);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ url: `http://${host}:${actual}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
