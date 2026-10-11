import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import type { MultisigConfig } from '../src/shared/config.js';

/** Deterministic test-only keys. Never fund these on mainnet. */
export const desktopKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
export const phoneKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(2));
export const backupKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3));
export const outsiderKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(4));

export const multisigConfig: MultisigConfig = {
  threshold: 2,
  members: [
    { role: 'desktop', label: 'Desktop', weight: 1, publicKey: desktopKey.getPublicKey().toSuiPublicKey() },
    { role: 'phone', label: 'Phone', weight: 1, publicKey: phoneKey.getPublicKey().toSuiPublicKey() },
    { role: 'backup', label: 'Backup', weight: 1, publicKey: backupKey.getPublicKey().toSuiPublicKey() },
  ],
};

/** Fully specified transaction that builds without a network connection. */
export async function offlineTxBytes(sender: string, amount = 1000, recipient: string = sender): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([
    { objectId: '0x' + '11'.repeat(32), version: '7', digest: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' },
  ]);
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin!], recipient);
  return tx.build();
}

export const GAS_PAYMENT = { objectId: '0x' + '11'.repeat(32), version: '7', digest: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' };
