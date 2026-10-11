// Browser end-to-end: loads the real extension into Chromium, drives a test dApp, the approval
// window and the real phone page, with mock wallets standing in for Slush on both devices.
// Needs a localnet: sui start --force-regenesis --with-faucet
// Run: node test/browser/run.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'test/browser/.build');
const EXT = join(ROOT, 'test/browser/.ext');
const MULTISIG = '0xc89be3da99a6d04b32f1d18490210046412411d185a4817d62bb49d60f3d4d9d';
const RECIPIENT = '0xa6ab0f1337bdb36bfd9733866e28f4aa0eec865a2bd8a4632f25456e5f02f0c7';
const AMOUNT = 100_000_000n;

function step(text) {
  console.log(`- ${text}`);
}

// 1. Build the extension with the test config, the local phone page, and the test fixtures.
execFileSync('node', ['build.mjs', '--extension'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, WALLET_CONFIG: 'test/browser/wallet.e2e.json', EXT_OUT: EXT },
});
execFileSync('node', ['build.mjs', '--phone', '--local'], { cwd: ROOT, stdio: 'inherit' });
const common = { bundle: true, format: 'iife', target: ['chrome111'], logLevel: 'warning' };
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/mock-wallet.ts')], outfile: join(OUT, 'mock-desktop-wallet.js'), define: { __MOCK_SEED__: '1', __MOCK_NAME__: '"Mock Slush"', __MOCK_BAD_PK__: 'false' } });
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/mock-wallet.ts')], outfile: join(OUT, 'mock-phone-wallet.js'), define: { __MOCK_SEED__: '2', __MOCK_NAME__: '"Mock Slush Mobile"', __MOCK_BAD_PK__: 'false' } });
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/mock-wallet.ts')], outfile: join(OUT, 'mock-same-key-wallet.js'), define: { __MOCK_SEED__: '1', __MOCK_NAME__: '"Mock Same Key"', __MOCK_BAD_PK__: 'false' } });
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/mock-wallet.ts')], outfile: join(OUT, 'mock-okx-wallet.js'), define: { __MOCK_SEED__: '2', __MOCK_NAME__: '"Mock OKX"', __MOCK_BAD_PK__: 'true' } });
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/decoy-wallet.ts')], outfile: join(OUT, 'decoy-desktop-wallet.js'), define: { __MOCK_NAME__: '"Mock Slush"' } });
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/decoy-wallet.ts')], outfile: join(OUT, 'decoy-phone-wallet.js'), define: { __MOCK_NAME__: '"Mock Slush Mobile"' } });
await build({ ...common, entryPoints: [join(ROOT, 'test/browser/dapp.ts')], outfile: join(OUT, 'dapp.js') });
await build({ bundle: true, format: 'esm', platform: 'node', logLevel: 'warning', entryPoints: [join(ROOT, 'relay/src/node-server.ts')], outfile: join(OUT, 'relay.mjs') });

// 2. Local relay on 8788 and a static server on 8790 for the dApp and the phone page.
const { startLocalRelay } = await import(join(OUT, 'relay.mjs'));
const relay = await startLocalRelay(8788);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const staticServer = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const candidates = path.startsWith('/phone/')
    ? [join(ROOT, 'phone/dist-local', path.slice('/phone/'.length) || 'index.html')]
    : [join(ROOT, 'test/browser/public', path), join(OUT, path)];
  const file = candidates.find((f) => existsSync(f) && statSync(f).isFile());
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => staticServer.listen(8790, '127.0.0.1', r));

const client = new SuiGrpcClient({ network: 'localnet', baseUrl: 'http://127.0.0.1:9000' });
const balance = async (owner) => BigInt((await client.core.getBalance({ owner, coinType: '0x2::sui::SUI' })).balance.balance);

const profile = mkdtempSync(join(tmpdir(), 'sui-multisig-e2e-'));
let context;
try {
  await requestSuiFromFaucetV2({ host: getFaucetHost('localnet'), recipient: MULTISIG });
  for (let i = 0; i < 40 && (await balance(MULTISIG)) === 0n; i++) await new Promise((r) => setTimeout(r, 500));

  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const approvalWindow = () => context.waitForEvent('page', { predicate: (p) => p.url().includes('/approve.html'), timeout: 15_000 });

  const dapp = await context.newPage();
  await dapp.goto('http://127.0.0.1:8790/dapp.html');
  await dapp.waitForFunction(() => window.dapp?.walletNames().some((n) => n.startsWith('Sui Multisig')), null, { timeout: 15_000 });
  assert.deepEqual(await dapp.evaluate(() => window.dapp.walletNames()), ['Sui Multisig 2/3', 'Mock Slush', 'Mock Slush', 'Mock Slush']);
  step('extension registered "Sui Multisig 2/3" next to the desktop wallet and two same-name decoys');

  // Connect
  let windowPromise = approvalWindow();
  const connectPromise = dapp.evaluate(() => window.dapp.connect());
  let win = await windowPromise;
  await win.getByRole('button', { name: 'Connect' }).click();
  assert.deepEqual(await connectPromise, [MULTISIG]);
  step('connect approved in the extension window');

  // Rejecting closes the request with an error the dApp sees
  windowPromise = approvalWindow();
  const rejected = dapp.evaluate(([r, a]) => window.dapp.send(r, a).then(() => 'resolved', (e) => e.message), [RECIPIENT, AMOUNT.toString()]);
  win = await windowPromise;
  await win.getByRole('button', { name: 'Reject' }).click();
  assert.equal(await rejected, 'User rejected the request');
  step('reject path returns "User rejected the request" to the dApp');

  // Full signing flow
  const multisigBefore = await balance(MULTISIG);
  const recipientBefore = await balance(RECIPIENT);
  windowPromise = approvalWindow();
  const sendPromise = dapp.evaluate(([r, a]) => window.dapp.send(r, a), [RECIPIENT, AMOUNT.toString()]);
  win = await windowPromise;
  await win.getByText(`${RECIPIENT} receives 0.1 SUI`).waitFor({ timeout: 15_000 });
  await win.getByRole('button', { name: 'I understand, sign with Mock Slush' }).click();
  const link = await win.locator('#phone-link').getAttribute('href', { timeout: 15_000 });
  assert.match(link, /^http:\/\/127\.0\.0\.1:8790\/phone\/#s=[0-9a-f]{32}&r=http%3A%2F%2F127\.0\.0\.1%3A8788&n=localnet$/);
  step('Desktop wallet signed; approval window shows the phone link');

  // A phone wallet holding the same key that signed on the computer must be refused.
  const sameKey = await context.newPage();
  await sameKey.addInitScript({ path: join(OUT, 'mock-same-key-wallet.js') });
  await sameKey.goto(link);
  await sameKey.getByRole('button', { name: 'This is my multisig, trust it' }).click();
  await sameKey.getByRole('button', { name: 'I understand, sign anyway' }).click();
  await sameKey.getByText('This phone wallet holds the key that already signed on the computer').waitFor({ timeout: 15_000 });
  step('phone wallet with the same key as the computer is refused');

  const phone = await context.newPage();
  await phone.addInitScript({ path: join(OUT, 'decoy-phone-wallet.js') });
  await phone.addInitScript({ path: join(OUT, 'mock-phone-wallet.js') });
  await phone.goto(link);
  await phone.getByText(MULTISIG).waitFor({ timeout: 15_000 });
  await phone.getByText(`${RECIPIENT} receives 0.1 SUI`).waitFor({ timeout: 15_000 });
  await phone.getByText('✓ Key A (0x29dfbf…84390f) already signed exactly these bytes').waitFor();
  await phone.getByRole('button', { name: 'I understand, sign anyway' }).click();
  await phone.getByText('Signed. Your computer will finish the transaction.').waitFor({ timeout: 15_000 });
  step('phone page verified the desktop signature, simulated on its own, signed');

  const result = await sendPromise;
  assert.equal(typeof result.digest, 'string');
  assert.equal(typeof result.effects, 'string');
  const executed = await client.core.waitForTransaction({ digest: result.digest, include: { effects: true } });
  assert.equal(executed.$kind, 'Transaction');
  assert.equal(executed.Transaction.status.success, true);
  const gas = executed.Transaction.effects.gasUsed;
  const gasCost = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
  assert.equal(await balance(RECIPIENT), recipientBefore + AMOUNT);
  assert.equal(await balance(MULTISIG), multisigBefore - AMOUNT - gasCost);
  step(`executed ${result.digest}: recipient +${AMOUNT} MIST, multisig -${AMOUNT + gasCost} MIST (incl. gas)`);

  // Second visit: the phone remembers the multisig and does not ask again
  const phone2 = await context.newPage();
  await phone2.addInitScript({ path: join(OUT, 'mock-phone-wallet.js') });
  await phone2.goto(link);
  await phone2.getByText('no such session').waitFor({ timeout: 15_000 });
  assert.equal(await phone2.getByRole('button', { name: 'This is my multisig, trust it' }).count(), 0);
  step('finished session is gone from the relay');

  // Setup page: only the Sui entry is offered, and it shows the real public key.
  const setup = await context.newPage();
  await setup.addInitScript({ path: join(OUT, 'decoy-phone-wallet.js') });
  await setup.addInitScript({ path: join(OUT, 'mock-phone-wallet.js') });
  await setup.goto('http://127.0.0.1:8790/phone/setup.html');
  await setup.getByRole('button', { name: 'Connect Mock Slush Mobile' }).waitFor({ timeout: 15_000 });
  assert.equal(await setup.getByRole('button', { name: 'Connect Mock Slush Mobile' }).count(), 1);
  await setup.getByRole('button', { name: 'Connect Mock Slush Mobile' }).click();
  await setup.getByText('Public key (ED25519)').waitFor({ timeout: 15_000 });
  await setup.getByText('AIE5dw6ofRdfVqNUZsNMfszLjYqRtO43ol32D1uPybOU').waitFor();
  step('setup page offers only the Sui wallet entry and shows its public key');

  // A wallet whose account.publicKey does not match its address: read the key from a signed message.
  const okx = await context.newPage();
  await okx.addInitScript({ path: join(OUT, 'mock-okx-wallet.js') });
  await okx.goto('http://127.0.0.1:8790/phone/setup.html');
  await okx.getByRole('button', { name: 'Connect Mock OKX' }).click();
  await okx.getByText('This wallet did not hand out a public key that matches this address.').waitFor({ timeout: 15_000 });
  await okx.getByRole('button', { name: 'Sign a message to read the key' }).click();
  await okx.getByText('AIE5dw6ofRdfVqNUZsNMfszLjYqRtO43ol32D1uPybOU').waitFor({ timeout: 15_000 });
  await okx.getByText('Read from a signed message: the wallet did not expose a matching key.').waitFor();
  step('wallet with a mismatching public key: key recovered from a signed message');

  console.log('\nBROWSER E2E PASSED');
} finally {
  await context?.close();
  await relay.close();
  staticServer.close();
  rmSync(profile, { recursive: true, force: true });
}
