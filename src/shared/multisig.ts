import type { PublicKey } from '@mysten/sui/cryptography';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { publicKeyFromSuiBytes, verifyTransactionSignature } from '@mysten/sui/verify';
import { validateMultisigConfig, type MemberRole, type MultisigConfig } from './config.js';

export interface Member {
  index: number;
  role: MemberRole;
  label: string;
  weight: number;
  publicKey: PublicKey;
  address: string;
}

export interface Multisig {
  publicKey: MultiSigPublicKey;
  address: string;
  threshold: number;
  members: Member[];
  memberByRole(role: MemberRole): Member;
}

export function loadMultisig(config: MultisigConfig): Multisig {
  validateMultisigConfig(config);
  const members: Member[] = config.members.map((m, index) => {
    const publicKey = publicKeyFromSuiBytes(m.publicKey);
    return { index, role: m.role, label: m.label, weight: m.weight, publicKey, address: publicKey.toSuiAddress() };
  });
  const addresses = new Set(members.map((m) => m.address));
  if (addresses.size !== members.length) throw new Error('duplicate member public key');

  const publicKey = MultiSigPublicKey.fromPublicKeys({
    threshold: config.threshold,
    publicKeys: members.map((m) => ({ publicKey: m.publicKey, weight: m.weight })),
  });
  return {
    publicKey,
    address: publicKey.toSuiAddress(),
    threshold: config.threshold,
    members,
    memberByRole(role) {
      const found = members.find((m) => m.role === role);
      if (!found) throw new Error(`no member with role ${role}`);
      return found;
    },
  };
}

/**
 * Verifies that `signature` is a valid single-key signature over `txBytes` by `expected`.
 * Throws with a readable message otherwise.
 */
export async function verifyMemberSignature(txBytes: Uint8Array, signature: string, expected: Member): Promise<void> {
  let signer: PublicKey;
  try {
    signer = await verifyTransactionSignature(txBytes, signature);
  } catch (e) {
    throw new Error(`signature from ${expected.label} does not verify over these transaction bytes`);
  }
  if (normalizeSuiAddress(signer.toSuiAddress()) !== normalizeSuiAddress(expected.address)) {
    throw new Error(`signature is from ${signer.toSuiAddress()}, expected ${expected.label} (${expected.address})`);
  }
}

/**
 * Combines member signatures into a multisig signature and re-verifies the result against the
 * multisig address before returning it.
 */
export async function combineSignatures(ms: Multisig, txBytes: Uint8Array, signatures: string[]): Promise<string> {
  const combined = ms.publicKey.combinePartialSignatures(signatures);
  const signer = await verifyTransactionSignature(txBytes, combined, { address: ms.address });
  if (normalizeSuiAddress(signer.toSuiAddress()) !== normalizeSuiAddress(ms.address)) {
    throw new Error('combined signature does not resolve to the multisig address');
  }
  return combined;
}

/**
 * Returns the member whose key produced `signature` over `txBytes`. Signing is role-agnostic:
 * any member can sign on any device, as long as two different members sign.
 */
export async function signingMember(ms: Multisig, txBytes: Uint8Array, signature: string): Promise<Member> {
  let signer: PublicKey;
  try {
    signer = await verifyTransactionSignature(txBytes, signature);
  } catch {
    throw new Error('signature does not verify over these transaction bytes');
  }
  const address = normalizeSuiAddress(signer.toSuiAddress());
  const member = ms.members.find((m) => normalizeSuiAddress(m.address) === address);
  if (!member) throw new Error(`signature is from ${address}, which is not a member of this multisig`);
  return member;
}
