// End-to-end on a throwaway localnet: real chain, real gRPC, real HTTP relay.
// Run with: sui start --force-regenesis --with-faucet   (in another terminal)
//           E2E_LOCALNET=1 npx vitest run test/e2e-localnet.test.ts
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from '../relay/src/node-server.js';
import { analyzeTransaction } from '../src/shared/analyze.js';
import { combineSignatures, loadMultisig, verifyMemberSignature } from '../src/shared/multisig.js';
import { createSession, getPhoneSignature, getSession, newSessionId, putPhoneSignature } from '../src/shared/relay-client.js';
import { coinInfoLookup, createClient, simulate } from '../src/shared/rpc.js';
import { backupKey, desktopKey, multisigConfig, outsiderKey, phoneKey } from './fixtures.js';

const ms = loadMultisig(multisigConfig);
const client = createClient('localnet');
const RECIPIENT = outsiderKey.toSuiAddress();
const SEND = 250_000_000n;

async function suiBalance(owner: string): Promise<bigint> {
  const { balance } = await client.core.getBalance({ owner, coinType: '0x2::sui::SUI' });
  return BigInt(balance.balance);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function buildSend(): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(ms.address);
  const [coin] = tx.splitCoins(tx.gas, [SEND]);
  tx.transferObjects([coin!], RECIPIENT);
  return tx.build({ client });
}

describe.skipIf(!process.env.E2E_LOCALNET)('localnet end to end', () => {
  let relay: LocalRelay;

  beforeAll(async () => {
    relay = await startLocalRelay();
    await requestSuiFromFaucetV2({ host: getFaucetHost('localnet'), recipient: ms.address });
    await waitFor(async () => ((await suiBalance(ms.address)) > 0n ? true : null));
  }, 60_000);

  afterAll(async () => {
    await relay?.close();
  });

  it('desktop signs, phone signs through the relay, desktop combines and executes', async () => {
    const before = await suiBalance(ms.address);
    const recipientBefore = await suiBalance(RECIPIENT);

    // Desktop side
    const txBytes = await buildSend();
    const desktopReport = await analyzeTransaction({
      txBytes,
      multisigAddress: ms.address,
      ownAddresses: ms.members.map((m) => m.address),
      simulation: await simulate(client, txBytes),
      knownPackages: {},
      coinInfo: coinInfoLookup(client),
    });
    expect(desktopReport.simulationOk).toBe(true);
    expect(desktopReport.findings).toEqual([
      { level: 'danger', text: `Transfers objects to ${RECIPIENT}` },
      { level: 'danger', text: `${RECIPIENT} receives 0.25 SUI` },
    ]);
    const desktopSignature = (await desktopKey.signTransaction(txBytes)).signature;
    const sessionId = newSessionId();
    await createSession(relay.url, sessionId, {
      network: 'localnet',
      mode: 'execute',
      txBytes: toBase64(txBytes),
      desktopSignature,
      multisig: multisigConfig,
    });

    // Phone side: only the session id and relay url come from the QR code.
    const session = await getSession(relay.url, sessionId);
    const phoneMs = loadMultisig(session.multisig);
    expect(phoneMs.address).toBe(ms.address);
    const phoneBytes = fromBase64(session.txBytes);
    await verifyMemberSignature(phoneBytes, session.desktopSignature, phoneMs.memberByRole('desktop'));
    const phoneReport = await analyzeTransaction({
      txBytes: phoneBytes,
      multisigAddress: phoneMs.address,
      ownAddresses: phoneMs.members.map((m) => m.address),
      simulation: await simulate(createClient('localnet'), phoneBytes),
      knownPackages: {},
      flagUnknownPackages: false,
      coinInfo: coinInfoLookup(client),
    });
    expect(phoneReport.findings).toEqual(desktopReport.findings);
    await putPhoneSignature(relay.url, sessionId, (await phoneKey.signTransaction(phoneBytes)).signature);

    // Desktop side again
    const phoneSignature = await waitFor(() => getPhoneSignature(relay.url, sessionId));
    await verifyMemberSignature(txBytes, phoneSignature, ms.memberByRole('phone'));
    const signature = await combineSignatures(ms, txBytes, [desktopSignature, phoneSignature]);
    const executed = await client.core.executeTransaction({ transaction: txBytes, signatures: [signature], include: { effects: true } });
    expect(executed.$kind).toBe('Transaction');
    const t = executed.Transaction!;
    expect(t.status.success).toBe(true);
    expect(t.effects.bcs).toBeInstanceOf(Uint8Array);
    await client.core.waitForTransaction({ digest: t.digest });

    const gas = t.effects.gasUsed;
    const gasCost = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
    expect(await suiBalance(RECIPIENT)).toBe(recipientBefore + SEND);
    expect(await suiBalance(ms.address)).toBe(before - SEND - gasCost);
    expect(desktopReport.gasCostMist).toBe(gasCost);
  }, 60_000);

  it('desktop + paper backup can still move funds (recovery path)', async () => {
    const txBytes = await buildSend();
    const signature = await combineSignatures(ms, txBytes, [
      (await desktopKey.signTransaction(txBytes)).signature,
      (await backupKey.signTransaction(txBytes)).signature,
    ]);
    const executed = await client.core.executeTransaction({ transaction: txBytes, signatures: [signature] });
    expect(executed.$kind).toBe('Transaction');
    expect(executed.Transaction!.status.success).toBe(true);
  }, 60_000);

  it('one key alone is rejected by the network', async () => {
    const txBytes = await buildSend();
    const desktopOnly = ms.publicKey.combinePartialSignatures([(await desktopKey.signTransaction(txBytes)).signature]);
    const error = await client.core.executeTransaction({ transaction: txBytes, signatures: [desktopOnly] }).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toBe('Invalid user signature: Signature is not valid: Insufficient weight=1 threshold=2');
  }, 60_000);
});
