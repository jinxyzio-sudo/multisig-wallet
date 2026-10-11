// Serves the send page on http://127.0.0.1:8790, where the extension injects its wallet.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'tools', 'send', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
if (!existsSync(join(ROOT, 'index.html'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}
createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(8790, '127.0.0.1', () => console.log('Send page: http://127.0.0.1:8790'));
