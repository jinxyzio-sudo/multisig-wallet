export type Network = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

export type MemberRole = 'desktop' | 'phone' | 'backup';

export interface MemberConfig {
  /** Base64 Sui public key including the scheme flag byte (`sui keytool list` "publicBase64Key"). */
  publicKey: string;
  weight: number;
  role: MemberRole;
  label: string;
}

export interface MultisigConfig {
  threshold: number;
  /** Order matters: it is part of the multisig address derivation. */
  members: MemberConfig[];
}

export interface WalletConfig {
  network: Network;
  multisig: MultisigConfig;
  /** Base URL of the relay worker, e.g. https://sui-multisig-relay.<you>.workers.dev */
  relayUrl: string;
  /** Public URL of the phone signer page, e.g. https://<user>.github.io/multisig-wallet/ */
  phoneUrl: string;
  /** Package id -> label. Calls into packages not listed here are flagged. */
  knownPackages: Record<string, string>;
  /** Wallet Standard name of the browser wallet that holds the desktop key, e.g. "Slush" or "OKX Wallet". */
  desktopWallet: string;
  /** Which mobile wallet's in-app browser the QR code should open. */
  phoneWallet: PhoneWallet;
}

export type PhoneWallet = 'slush' | 'okx' | 'plain';

/**
 * Fullnode endpoints are fixed per network and never taken from a QR code or the relay:
 * a compromised computer must not be able to point the phone at an RPC that lies about simulation.
 */
export const GRPC_URLS: Record<Network, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

export const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'devnet', 'localnet'];

export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
}

export function chainOf(network: Network): `sui:${Network}` {
  return `sui:${network}`;
}

export const SYSTEM_PACKAGES: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000001': 'Move stdlib',
  '0x0000000000000000000000000000000000000000000000000000000000000002': 'Sui framework',
  '0x0000000000000000000000000000000000000000000000000000000000000003': 'Sui system',
};

export function validateMultisigConfig(config: MultisigConfig): void {
  const { threshold, members } = config;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 0xffff) {
    throw new Error(`threshold must be an integer in [1, 65535], got ${threshold}`);
  }
  if (members.length < 2 || members.length > 10) {
    throw new Error(`multisig needs 2..10 members, got ${members.length}`);
  }
  let total = 0;
  for (const m of members) {
    if (!Number.isInteger(m.weight) || m.weight < 1 || m.weight > 255) {
      throw new Error(`member "${m.label}" weight must be an integer in [1, 255], got ${m.weight}`);
    }
    total += m.weight;
  }
  if (total < threshold) {
    throw new Error(`sum of weights (${total}) is below threshold (${threshold}); the account could never sign`);
  }
  for (const m of members) {
    if (m.weight >= threshold) {
      throw new Error(`member "${m.label}" alone reaches the threshold; that defeats the multisig`);
    }
  }
  for (const role of ['desktop', 'phone'] as const) {
    const count = members.filter((m) => m.role === role).length;
    if (count !== 1) throw new Error(`exactly one "${role}" member is required, found ${count}`);
  }
}
