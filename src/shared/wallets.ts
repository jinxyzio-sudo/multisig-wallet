import { SIGNATURE_FLAG_TO_SCHEME, type PublicKey, type SignatureScheme } from '@mysten/sui/cryptography';
import { fromBase64, fromHex, normalizeSuiAddress } from '@mysten/sui/utils';
import { publicKeyFromRawBytes, publicKeyFromSuiBytes, verifyPersonalMessageSignature } from '@mysten/sui/verify';
import type { Wallet, WalletAccount } from '@mysten/wallet-standard';

/**
 * Multi-chain wallets (OKX) register one Wallet Standard entry per chain under the same name.
 * Only entries that declare a Sui chain and a Sui signing feature are usable here.
 */
export function isSuiWallet(wallet: Wallet): boolean {
  const features = wallet.features as Record<string, unknown>;
  return (
    'standard:connect' in features &&
    ('sui:signTransaction' in features || 'sui:signTransactionBlock' in features) &&
    wallet.chains.some((c) => c.startsWith('sui:'))
  );
}

export function isSuiAccount(account: WalletAccount): boolean {
  return account.chains.length === 0 || account.chains.some((c) => c.startsWith('sui:'));
}

const SCHEMES: SignatureScheme[] = ['ED25519', 'Secp256k1', 'Secp256r1'];
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fromBase58(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const i = BASE58.indexOf(ch);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/** Wallets disagree on the format of account.publicKey: raw, flag-prefixed, or even text. */
function byteCandidates(raw: Uint8Array): Uint8Array[] {
  const out = [raw];
  const text = new TextDecoder().decode(raw).trim();
  if (text.length > 0 && /^[\x21-\x7e]+$/.test(text)) {
    for (const decode of [fromBase64, (t: string) => fromHex(t.replace(/^0x/, '')), fromBase58]) {
      try {
        out.push(decode(text));
      } catch {
        // not this encoding
      }
    }
  }
  return out;
}

/** Returns the account's public key only if it provably derives the account's address. */
export function accountPublicKey(account: WalletAccount): PublicKey | null {
  const wanted = normalizeSuiAddress(account.address);
  for (const bytes of byteCandidates(new Uint8Array(account.publicKey))) {
    const attempts: (() => PublicKey)[] = [
      () => publicKeyFromSuiBytes(bytes),
      ...SCHEMES.map((s) => () => publicKeyFromRawBytes(s, bytes)),
    ];
    for (const attempt of attempts) {
      try {
        const pk = attempt();
        if (normalizeSuiAddress(pk.toSuiAddress()) === wanted) return pk;
      } catch {
        // wrong length or format for this attempt
      }
    }
  }
  return null;
}

export function schemeName(pk: PublicKey): string {
  return SIGNATURE_FLAG_TO_SCHEME[pk.flag() as keyof typeof SIGNATURE_FLAG_TO_SCHEME] ?? 'unknown';
}

export const KEY_PROBE_MESSAGE = 'Reveal my public key for a multisig setup. This is not a transaction.';

/**
 * Recovers the public key from a personal-message signature, which carries the key. Used when a
 * wallet does not expose a usable account.publicKey. Only plain keys qualify as multisig members.
 */
export async function publicKeyFromMessageSignature(message: Uint8Array, signature: string, address: string): Promise<PublicKey> {
  const pk = await verifyPersonalMessageSignature(message, signature, { address });
  if (normalizeSuiAddress(pk.toSuiAddress()) !== normalizeSuiAddress(address)) {
    throw new Error('signature does not belong to this address');
  }
  const scheme = schemeName(pk);
  if (!SCHEMES.includes(scheme as SignatureScheme)) {
    throw new Error(`account uses ${scheme}, which cannot be a plain multisig member`);
  }
  return pk;
}
