import type { SuiClientTypes } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';
import { analyzeTransaction, formatUnits, type CoinInfo } from '../src/shared/analyze.js';
import { loadMultisig } from '../src/shared/multisig.js';
import { GAS_PAYMENT, desktopKey, multisigConfig, offlineTxBytes, outsiderKey } from './fixtures.js';

const ms = loadMultisig(multisigConfig);
const MS = ms.address;
const ATTACKER = outsiderKey.toSuiAddress();
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const LENDING = '0x' + 'ab'.repeat(32);

const COINS: Record<string, CoinInfo> = { [SUI]: { symbol: 'SUI', decimals: 9 }, [USDC]: { symbol: 'USDC', decimals: 6 } };
const coinInfo = async (t: string) => COINS[t] ?? null;

type Sim = SuiClientTypes.SimulateTransactionResult<{ balanceChanges: true; effects: true; objectTypes: true }>;

function sim(opts: {
  balanceChanges?: SuiClientTypes.BalanceChange[];
  changedObjects?: SuiClientTypes.ChangedObject[];
  objectTypes?: Record<string, string>;
  error?: string;
}): Sim {
  const status: SuiClientTypes.ExecutionStatus = opts.error
    ? { success: false, error: { message: opts.error, $kind: 'Unknown', Unknown: null } as SuiClientTypes.ExecutionError }
    : { success: true, error: null };
  const transaction: SuiClientTypes.Transaction<{ balanceChanges: true; effects: true; objectTypes: true }> = {
    digest: 'D1gest',
    signatures: [],
    epoch: null,
    timestampMs: null,
    checkpoint: null,
    status,
    balanceChanges: opts.balanceChanges ?? [],
    effects: {
      bcs: null,
      version: 2,
      status,
      gasUsed: { computationCost: '1000000', storageCost: '2000000', storageRebate: '978120', nonRefundableStorageFee: '9880' },
      transactionDigest: 'D1gest',
      gasObject: null,
      eventsDigest: null,
      dependencies: [],
      lamportVersion: null,
      changedObjects: opts.changedObjects ?? [],
      unchangedConsensusObjects: [],
      auxiliaryDataDigest: null,
    },
    events: undefined,
    objectTypes: opts.objectTypes ?? {},
    transaction: undefined,
    bcs: undefined,
  };
  return opts.error
    ? { $kind: 'FailedTransaction', FailedTransaction: transaction, commandResults: undefined }
    : { $kind: 'Transaction', Transaction: transaction, commandResults: undefined };
}

function owned(objectId: string, from: string, to: SuiClientTypes.ObjectOwner | null): SuiClientTypes.ChangedObject {
  return {
    objectId,
    inputState: 'Exists',
    inputVersion: '5',
    inputDigest: 'x',
    inputOwner: { $kind: 'AddressOwner', AddressOwner: from },
    outputState: to ? 'ObjectWrite' : 'DoesNotExist',
    outputVersion: to ? '6' : null,
    outputDigest: to ? 'y' : null,
    outputOwner: to,
    idOperation: 'None',
  };
}

async function lendingCallBytes(): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(MS);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([GAS_PAYMENT]);
  tx.moveCall({ target: `${LENDING}::lending::withdraw`, arguments: [tx.pure.u64(500_000_000)] });
  return tx.build();
}

const base = { multisigAddress: MS, ownAddresses: ms.members.map((m) => m.address), coinInfo };

describe('formatUnits', () => {
  it('formats with decimals and trims trailing zeros', () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5');
    expect(formatUnits(-2_077_000n, 9)).toBe('-0.002077');
    expect(formatUnits(500_000_000n, 6)).toBe('500');
    expect(formatUnits(7n, 0)).toBe('7');
  });
});

describe('analyzeTransaction', () => {
  it('a plain self transfer has no findings', async () => {
    const txBytes = await offlineTxBytes(MS);
    const report = await analyzeTransaction({
      ...base,
      txBytes,
      knownPackages: {},
      simulation: sim({ balanceChanges: [{ coinType: SUI, address: MS, amount: '-2021880' }] }),
    });
    expect(report.findings).toEqual([]);
    expect(report.simulationOk).toBe(true);
    expect(report.sender).toBe(MS);
    expect(report.selfChanges).toEqual([{ coinType: SUI, symbol: 'SUI', raw: -2021880n, formatted: '-0.00202188' }]);
    expect(report.externalReceipts).toEqual([]);
    expect(report.gasBudgetMist).toBe(10_000_000n);
    expect(report.gasCostMist).toBe(2_021_880n);
  });

  it('flags a lending withdraw that pays an outsider even though the multisig balance does not move', async () => {
    const report = await analyzeTransaction({
      ...base,
      txBytes: await lendingCallBytes(),
      knownPackages: { [LENDING]: 'Lending' },
      simulation: sim({
        balanceChanges: [
          { coinType: SUI, address: MS, amount: '-2021880' },
          { coinType: USDC, address: ATTACKER, amount: '500000000' },
        ],
      }),
    });
    expect(report.calls).toEqual([{ target: `${LENDING}::lending::withdraw`, label: 'Lending' }]);
    expect(report.externalReceipts).toEqual([
      { address: ATTACKER, amounts: [{ coinType: USDC, symbol: 'USDC', raw: 500_000_000n, formatted: '500' }] },
    ]);
    expect(report.findings).toEqual([{ level: 'danger', text: `${ATTACKER} receives 500 USDC` }]);
  });

  it('warns about unknown packages only when asked to', async () => {
    const txBytes = await lendingCallBytes();
    const simulation = sim({ balanceChanges: [{ coinType: SUI, address: MS, amount: '-2021880' }] });
    const flagged = await analyzeTransaction({ ...base, txBytes, knownPackages: {}, simulation });
    expect(flagged.findings).toEqual([
      { level: 'warn', text: `Calls a package not on your list: ${LENDING}::lending::withdraw` },
    ]);
    const quiet = await analyzeTransaction({ ...base, txBytes, knownPackages: {}, simulation, flagUnknownPackages: false });
    expect(quiet.findings).toEqual([]);
    expect(quiet.calls).toEqual([{ target: `${LENDING}::lending::withdraw`, label: null }]);
  });

  it('flags a TransferObjects command to an outside address', async () => {
    const report = await analyzeTransaction({
      ...base,
      txBytes: await offlineTxBytes(MS, 1000, ATTACKER),
      knownPackages: {},
      simulation: sim({
        balanceChanges: [
          { coinType: SUI, address: MS, amount: '-2022880' },
          { coinType: SUI, address: ATTACKER, amount: '1000' },
        ],
      }),
    });
    expect(report.findings).toEqual([
      { level: 'danger', text: `Transfers objects to ${ATTACKER}` },
      { level: 'danger', text: `${ATTACKER} receives 0.000001 SUI` },
    ]);
  });

  it('reports a receipt by a member address as info', async () => {
    const desktop = desktopKey.toSuiAddress();
    const report = await analyzeTransaction({
      ...base,
      txBytes: await offlineTxBytes(MS, 1000, desktop),
      knownPackages: {},
      simulation: sim({ balanceChanges: [{ coinType: SUI, address: desktop, amount: '1000' }] }),
    });
    expect(report.findings).toEqual([{ level: 'info', text: `Your member address ${desktop} receives 0.000001 SUI` }]);
  });

  it('flags a non-coin object leaving the multisig, ignores coins and objects that stay', async () => {
    const cap = '0x' + 'c1'.repeat(32);
    const coin = '0x' + 'c2'.repeat(32);
    const kept = '0x' + 'c3'.repeat(32);
    const wrapped = '0x' + 'c4'.repeat(32);
    const report = await analyzeTransaction({
      ...base,
      txBytes: await offlineTxBytes(MS),
      knownPackages: {},
      simulation: sim({
        changedObjects: [
          owned(cap, MS, { $kind: 'AddressOwner', AddressOwner: ATTACKER }),
          owned(coin, MS, { $kind: 'AddressOwner', AddressOwner: ATTACKER }),
          owned(kept, MS, { $kind: 'AddressOwner', AddressOwner: MS }),
          owned(wrapped, MS, null),
        ],
        objectTypes: {
          [cap]: '0x2::kiosk::KioskOwnerCap',
          [coin]: `0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<${SUI}>`,
          [kept]: '0x2::kiosk::KioskOwnerCap',
          [wrapped]: `${LENDING}::account::AccountCap`,
        },
      }),
    });
    expect(report.objectsOut).toEqual([{ objectId: cap, type: '0x2::kiosk::KioskOwnerCap', to: ATTACKER }]);
    expect(report.findings).toEqual([
      { level: 'danger', text: `Object 0x2::kiosk::KioskOwnerCap (${cap}) goes to ${ATTACKER}` },
      { level: 'info', text: `Object ${LENDING}::account::AccountCap (${wrapped}) becomes deleted or wrapped` },
    ]);
  });

  it('flags a failed simulation and reports no gas cost', async () => {
    const report = await analyzeTransaction({
      ...base,
      txBytes: await offlineTxBytes(MS),
      knownPackages: {},
      simulation: sim({ error: 'MoveAbort in 1st command, abort code: 1502' }),
    });
    expect(report.simulationOk).toBe(false);
    expect(report.simulationError).toBe('MoveAbort in 1st command, abort code: 1502');
    expect(report.gasCostMist).toBe(null);
    expect(report.findings).toEqual([
      { level: 'danger', text: 'Simulation failed: MoveAbort in 1st command, abort code: 1502' },
    ]);
  });

  it('flags a sender that is not the multisig', async () => {
    const report = await analyzeTransaction({
      ...base,
      txBytes: await offlineTxBytes(ATTACKER, 1000, MS),
      knownPackages: {},
      simulation: sim({}),
    });
    expect(report.findings).toEqual([{ level: 'danger', text: `Sender is ${ATTACKER}, not the multisig ${MS}` }]);
  });
});
