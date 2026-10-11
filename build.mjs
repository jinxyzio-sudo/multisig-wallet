// Builds the Chrome extension (extension/dist, load unpacked) and the phone page (docs/, served by
// GitHub Pages). Output is deterministic: rebuilding the same commit gives byte-identical files,
// so `npm run build && git diff --exit-code docs` proves the deployed page matches the source.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { GRPC_URLS } from './src/shared/config.ts';

const args = new Set(process.argv.slice(2));
const local = args.has('--local');
const only = args.has('--phone') ? 'phone' : args.has('--extension') ? 'extension' : args.has('--tools') ? 'tools' : 'all';
const configPath = process.env.WALLET_CONFIG ?? 'config/wallet.json';

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome111'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
};

async function buildExtension() {
  if (!existsSync(configPath)) {
    throw new Error(`${configPath} not found. Copy config/wallet.example.json and fill in your keys.`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const grpcUrl = GRPC_URLS[config.network];
  if (!grpcUrl) throw new Error(`unknown network ${config.network}`);
  const relayOrigin = new URL(config.relayUrl).origin;

  const out = process.env.EXT_OUT ?? 'extension/dist';
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const define = { __WALLET_CONFIG__: JSON.stringify(config) };
  await build({ ...common, entryPoints: { inject: 'src/extension/inject.ts', approve: 'src/extension/approve.ts' }, outdir: out, define });
  await build({ ...common, entryPoints: { content: 'src/extension/content.ts', background: 'src/extension/background.ts' }, outdir: out });

  // Extension pages may only talk to the configured fullnode and relay.
  const csp = `script-src 'self'; object-src 'none'; img-src 'self' data:; style-src 'self'; connect-src ${new URL(grpcUrl).origin} ${relayOrigin}; default-src 'none'; base-uri 'none'`;
  const manifest = readFileSync('extension/manifest.template.json', 'utf8').replace('__CSP__', csp);
  writeFileSync(`${out}/manifest.json`, manifest);
  copyFileSync('extension/approve.html', `${out}/approve.html`);
  copyFileSync('src/shared/ui.css', `${out}/ui.css`);
  console.log(`extension -> ${out} (multisig config from ${configPath})`);
}

async function buildPhone() {
  const out = local ? 'phone/dist-local' : 'docs';
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({ ...common, entryPoints: { app: 'src/phone/main.ts', setup: 'src/phone/setup.ts' }, outdir: out });
  for (const page of ['index.html', 'setup.html']) {
    let html = readFileSync(`phone/${page}`, 'utf8');
    if (local) html = html.replace('connect-src https:', 'connect-src https: http://127.0.0.1:*');
    writeFileSync(`${out}/${page}`, html);
  }
  copyFileSync('src/shared/ui.css', `${out}/ui.css`);
  writeFileSync(`${out}/.nojekyll`, '');
  console.log(`phone page -> ${out}`);
}

async function buildTools() {
  const out = 'tools/send/dist';
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({ ...common, entryPoints: { send: 'src/tools/send.ts' }, outdir: out });
  copyFileSync('tools/send/index.html', `${out}/index.html`);
  copyFileSync('src/shared/ui.css', `${out}/ui.css`);
  console.log(`send page -> ${out} (npm run send)`);
}

if (only === 'all' || only === 'extension') await buildExtension();
if (only === 'all' || only === 'tools') await buildTools();
if (only === 'all' || only === 'phone') await buildPhone();
