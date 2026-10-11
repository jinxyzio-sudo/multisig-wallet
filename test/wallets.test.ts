import { toBase64 } from '@mysten/sui/utils';
import type { Wallet, WalletAccount } from '@mysten/wallet-standard';
import { describe, expect, it } from 'vitest';
import { accountPublicKey, isSuiAccount, isSuiWallet, publicKeyFromMessageSignature, schemeName } from '../src/shared/wallets.js';
import { desktopKey, phoneKey } from './fixtures.js';

const SUI_PK = desktopKey.getPublicKey();
const ADDRESS = desktopKey.toSuiAddress();
const EXPECTED = 'AIqI4910CfGV/VLbLTy6XXLKZwm/HZQSG/N0iAG0D29c';
const BASE58 = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';

function account(publicKey: Uint8Array, address = ADDRESS, chains: string[] = ['sui:mainnet']): WalletAccount {
  return { address, publicKey, chains: chains as WalletAccount['chains'], features: [] };
}

function wallet(chains: string[], features: string[]): Wallet {
  return {
    version: '1.0.0',
    name: 'OKX Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    chains: chains as Wallet['chains'],
    accounts: [],
    features: Object.fromEntries(features.map((f) => [f, {}])),
  };
}

describe('accountPublicKey', () => {
  it('accepts a raw 32-byte ed25519 key', () => {
    const pk = accountPublicKey(account(SUI_PK.toRawBytes()));
    expect(pk?.toSuiPublicKey()).toBe(EXPECTED);
    expect(schemeName(pk!)).toBe('ED25519');
  });

  it('accepts a flag-prefixed key', () => {
    expect(accountPublicKey(account(SUI_PK.toSuiBytes()))?.toSuiPublicKey()).toBe(EXPECTED);
  });

  it('accepts a key handed out as base64 text', () => {
    const text = new TextEncoder().encode(toBase64(SUI_PK.toRawBytes()));
    expect(accountPublicKey(account(text))?.toSuiPublicKey()).toBe(EXPECTED);
  });

  it('accepts a key handed out as base58 text', () => {
    expect(accountPublicKey(account(new TextEncoder().encode(BASE58)))?.toSuiPublicKey()).toBe(EXPECTED);
  });

  it('refuses a key that does not derive the address', () => {
    expect(accountPublicKey(account(phoneKey.getPublicKey().toRawBytes()))).toBe(null);
    expect(accountPublicKey(account(new Uint8Array()))).toBe(null);
  });
});

describe('Sui filters', () => {
  it('keeps only Sui entries of a multi-chain wallet', () => {
    expect(isSuiWallet(wallet(['solana:mainnet'], ['standard:connect', 'solana:signTransaction']))).toBe(false);
    expect(isSuiWallet(wallet(['sui:mainnet'], ['standard:connect', 'sui:signTransaction']))).toBe(true);
    expect(isSuiWallet(wallet(['sui:mainnet'], ['standard:connect', 'sui:signTransactionBlock']))).toBe(true);
    expect(isSuiWallet(wallet(['sui:mainnet'], ['sui:signTransaction']))).toBe(false);
  });

  it('keeps Sui accounts and accounts without chain info', () => {
    expect(isSuiAccount(account(SUI_PK.toRawBytes()))).toBe(true);
    expect(isSuiAccount(account(SUI_PK.toRawBytes(), ADDRESS, []))).toBe(true);
    expect(isSuiAccount(account(SUI_PK.toRawBytes(), 'C3FMZq', ['solana:mainnet']))).toBe(false);
  });
});

describe('publicKeyFromMessageSignature', () => {
  const message = new TextEncoder().encode('Reveal my public key for a multisig setup. This is not a transaction.');

  it('recovers the key from a personal-message signature', async () => {
    const { signature } = await desktopKey.signPersonalMessage(message);
    const pk = await publicKeyFromMessageSignature(message, signature, ADDRESS);
    expect(pk.toSuiPublicKey()).toBe(EXPECTED);
  });

  it('refuses a signature from another account', async () => {
    const { signature } = await phoneKey.signPersonalMessage(message);
    await expect(publicKeyFromMessageSignature(message, signature, ADDRESS)).rejects.toThrow('Public key bytes do not match the provided address');
  });
});
