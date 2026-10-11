import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import { SYSTEM_PACKAGES } from './config.js';

export type Level = 'danger' | 'warn' | 'info';

export interface Finding {
  level: Level;
  text: string;
}

export interface CoinAmount {
  coinType: string;
  symbol: string;
  raw: bigint;
  formatted: string;
}

export interface Report {
  simulationOk: boolean;
  simulationError: string | null;
  sender: string;
  gasBudgetMist: bigint;
  gasCostMist: bigint | null;
  calls: { target: string; label: string | null }[];
  /** Net coin changes of the multisig itself. */
  selfChanges: CoinAmount[];
  /** Every other address whose balance goes up. On a normal DeFi call this list is empty. */
  externalReceipts: { address: string; amounts: CoinAmount[] }[];
  /** Non-coin objects owned by the multisig that end up owned by another address. */
  objectsOut: { objectId: string; type: string; to: string }[];
  findings: Finding[];
}

export interface CoinInfo {
  symbol: string;
  decimals: number;
}

export interface AnalyzeInput {
  txBytes: Uint8Array;
  multisigAddress: string;
  /** Addresses that belong to you (members). Receipts to these are reported as info, not danger. */
  ownAddresses: string[];
  simulation: SuiClientTypes.SimulateTransactionResult<{ balanceChanges: true; effects: true; objectTypes: true }>;
  knownPackages: Record<string, string>;
  /** Add a warning per call into a package missing from knownPackages. Default true. */
  flagUnknownPackages?: boolean;
  coinInfo: (coinType: string) => Promise<CoinInfo | null>;
}

const COIN_TYPE_PREFIX = normalizeStructTag('0x2::coin::Coin<0x2::sui::SUI>').split('<')[0] + '<';

export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let out = whole.toString();
  if (decimals > 0 && frac !== 0n) {
    out += '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  }
  return (negative ? '-' : '') + out;
}

function ownerAddress(owner: SuiClientTypes.ObjectOwner | null): string | null {
  if (!owner) return null;
  if (owner.$kind === 'AddressOwner') return normalizeSuiAddress(owner.AddressOwner);
  if (owner.$kind === 'ConsensusAddressOwner') return normalizeSuiAddress(owner.ConsensusAddressOwner.owner);
  return null;
}

function describeOwner(owner: SuiClientTypes.ObjectOwner | null): string {
  if (!owner) return 'deleted or wrapped';
  switch (owner.$kind) {
    case 'AddressOwner':
      return normalizeSuiAddress(owner.AddressOwner);
    case 'ConsensusAddressOwner':
      return normalizeSuiAddress(owner.ConsensusAddressOwner.owner);
    case 'ObjectOwner':
      return `object ${owner.ObjectOwner}`;
    case 'Shared':
      return 'shared';
    case 'Immutable':
      return 'immutable';
    default:
      return 'unknown owner';
  }
}

function packageLabel(pkg: string, knownPackages: Record<string, string>): string | null {
  const id = normalizeSuiAddress(pkg);
  return SYSTEM_PACKAGES[id] ?? knownPackages[id] ?? null;
}

async function toAmount(coinType: string, raw: bigint, coinInfo: AnalyzeInput['coinInfo']): Promise<CoinAmount> {
  const info = await coinInfo(coinType);
  if (!info) return { coinType, symbol: coinType.split('::').pop() ?? coinType, raw, formatted: `${raw} (raw units)` };
  return { coinType, symbol: info.symbol, raw, formatted: formatUnits(raw, info.decimals) };
}

export async function analyzeTransaction(input: AnalyzeInput): Promise<Report> {
  const multisig = normalizeSuiAddress(input.multisigAddress);
  const own = new Set(input.ownAddresses.map((a) => normalizeSuiAddress(a)));
  const knownPackages = Object.fromEntries(
    Object.entries(input.knownPackages).map(([k, v]) => [normalizeSuiAddress(k), v]),
  );
  const data = Transaction.from(input.txBytes).getData();
  const findings: Finding[] = [];

  const sender = data.sender ? normalizeSuiAddress(data.sender) : '';
  if (sender !== multisig) {
    findings.push({ level: 'danger', text: `Sender is ${sender || '(missing)'}, not the multisig ${multisig}` });
  }

  const calls: Report['calls'] = [];
  for (const command of data.commands) {
    switch (command.$kind) {
      case 'MoveCall': {
        const c = command.MoveCall;
        const label = packageLabel(c.package, knownPackages);
        calls.push({ target: `${normalizeSuiAddress(c.package)}::${c.module}::${c.function}`, label });
        if (!label && input.flagUnknownPackages !== false) {
          findings.push({ level: 'warn', text: `Calls a package not on your list: ${normalizeSuiAddress(c.package)}::${c.module}::${c.function}` });
        }
        break;
      }
      case 'TransferObjects': {
        const target = command.TransferObjects.address;
        if (target.$kind === 'Input') {
          const arg = data.inputs[target.Input];
          if (arg?.$kind === 'Pure') {
            const to = normalizeSuiAddress(bcs.Address.parse(fromBase64(arg.Pure.bytes)));
            if (to !== multisig && !own.has(to)) {
              findings.push({ level: 'danger', text: `Transfers objects to ${to}` });
            }
          }
        } else {
          findings.push({ level: 'warn', text: 'Transfers objects to an address computed on chain' });
        }
        break;
      }
      case 'Publish':
        findings.push({ level: 'danger', text: 'Publishes a Move package' });
        break;
      case 'Upgrade':
        findings.push({ level: 'danger', text: `Upgrades package ${command.Upgrade.package}` });
        break;
      default:
        break;
    }
  }

  const sim = input.simulation;
  const executed = sim.$kind === 'Transaction' ? sim.Transaction : sim.FailedTransaction;
  const simulationOk = sim.$kind === 'Transaction' && executed.status.success;
  const simulationError = executed.status.success ? null : executed.status.error.message;
  if (!simulationOk) {
    findings.push({ level: 'danger', text: `Simulation failed: ${simulationError ?? 'unknown error'}` });
  }

  const byAddress = new Map<string, Map<string, bigint>>();
  for (const change of executed.balanceChanges) {
    const address = normalizeSuiAddress(change.address);
    const coinType = normalizeStructTag(change.coinType);
    const coins = byAddress.get(address) ?? new Map<string, bigint>();
    coins.set(coinType, (coins.get(coinType) ?? 0n) + BigInt(change.amount));
    byAddress.set(address, coins);
  }

  const selfChanges: CoinAmount[] = [];
  for (const [coinType, raw] of byAddress.get(multisig) ?? []) {
    if (raw !== 0n) selfChanges.push(await toAmount(coinType, raw, input.coinInfo));
  }

  const externalReceipts: Report['externalReceipts'] = [];
  for (const [address, coins] of byAddress) {
    if (address === multisig) continue;
    const amounts: CoinAmount[] = [];
    for (const [coinType, raw] of coins) {
      if (raw > 0n) amounts.push(await toAmount(coinType, raw, input.coinInfo));
    }
    if (amounts.length === 0) continue;
    externalReceipts.push({ address, amounts });
    const list = amounts.map((a) => `${a.formatted} ${a.symbol}`).join(', ');
    if (own.has(address)) {
      findings.push({ level: 'info', text: `Your member address ${address} receives ${list}` });
    } else {
      findings.push({ level: 'danger', text: `${address} receives ${list}` });
    }
  }

  const objectsOut: Report['objectsOut'] = [];
  const types = executed.objectTypes;
  for (const obj of executed.effects.changedObjects) {
    if (ownerAddress(obj.inputOwner) !== multisig) continue;
    const type = types[obj.objectId] ?? 'unknown type';
    if (type.startsWith(COIN_TYPE_PREFIX)) continue;
    const outOwner = ownerAddress(obj.outputOwner);
    if (outOwner === multisig) continue;
    const to = describeOwner(obj.outputOwner);
    if (outOwner !== null && !own.has(outOwner)) {
      objectsOut.push({ objectId: obj.objectId, type, to });
      findings.push({ level: 'danger', text: `Object ${type} (${obj.objectId}) goes to ${to}` });
    } else {
      findings.push({ level: 'info', text: `Object ${type} (${obj.objectId}) becomes ${to}` });
    }
  }

  const gasUsed = executed.effects.gasUsed;
  const gasCostMist = simulationOk
    ? BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate)
    : null;

  return {
    simulationOk,
    simulationError,
    sender,
    gasBudgetMist: BigInt(data.gasData.budget ?? 0),
    gasCostMist,
    calls,
    selfChanges,
    externalReceipts,
    objectsOut,
    findings,
  };
}
