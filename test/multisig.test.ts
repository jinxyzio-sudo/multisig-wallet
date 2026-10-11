import { verifyTransactionSignature } from '@mysten/sui/verify';
import { describe, expect, it } from 'vitest';
import { validateMultisigConfig } from '../src/shared/config.js';
import { combineSignatures, loadMultisig, signingMember, verifyMemberSignature } from '../src/shared/multisig.js';
import { backupKey, desktopKey, multisigConfig, offlineTxBytes, outsiderKey, phoneKey } from './fixtures.js';

// Derived independently with:
// sui keytool multi-sig-address --pks <desktop> <phone> <backup> --weights 1 1 1 --threshold 2
const EXPECTED_ADDRESS = '0xc89be3da99a6d04b32f1d18490210046412411d185a4817d62bb49d60f3d4d9d';

describe('loadMultisig', () => {
  it('derives the same address as the sui CLI', () => {
    const ms = loadMultisig(multisigConfig);
    expect(ms.address).toBe(EXPECTED_ADDRESS);
    expect(ms.members.map((m) => m.address)).toEqual([
      '0x29dfbf688abce7ab43bb8e70cae158ae961196e721440f515482f8ba1684390f',
      '0x7799ea80594c35644321148485238c7a7a1c6549809e1795e6747c6d4da2504c',
      '0xd64fe64522169a8a26fed5ae2f9a3c76363a18650a580379f23ddf64c2587066',
    ]);
    expect(ms.memberByRole('phone').address).toBe(phoneKey.toSuiAddress());
  });

  it('changes the address when member order changes', () => {
    const swapped = { ...multisigConfig, members: [multisigConfig.members[1]!, multisigConfig.members[0]!, multisigConfig.members[2]!] };
    // sui keytool multi-sig-address --pks <phone> <desktop> <backup> --weights 1 1 1 --threshold 2
    expect(loadMultisig(swapped).address).toBe('0x3b2b40c36e612c3a7ee7a4a54439fdef475c1ab3d4283afafa0986f7305b0a93');
  });

  it('rejects a member that can sign alone', () => {
    const bad = { ...multisigConfig, members: multisigConfig.members.map((m, i) => (i === 0 ? { ...m, weight: 2 } : m)) };
    expect(() => validateMultisigConfig(bad)).toThrow('member "Desktop" alone reaches the threshold; that defeats the multisig');
  });

  it('rejects weights that can never reach the threshold', () => {
    expect(() => validateMultisigConfig({ ...multisigConfig, threshold: 4 })).toThrow(
      'sum of weights (3) is below threshold (4); the account could never sign',
    );
  });

  it('requires exactly one phone member', () => {
    const bad = { ...multisigConfig, members: multisigConfig.members.map((m) => (m.role === 'phone' ? { ...m, role: 'backup' as const } : m)) };
    expect(() => validateMultisigConfig(bad)).toThrow('exactly one "phone" member is required, found 0');
  });

  it('rejects duplicate keys', () => {
    const dup = { ...multisigConfig, members: multisigConfig.members.map((m, i) => (i === 2 ? { ...m, publicKey: multisigConfig.members[0]!.publicKey } : m)) };
    expect(() => loadMultisig(dup)).toThrow('duplicate member public key');
  });
});

describe('signatures', () => {
  const ms = loadMultisig(multisigConfig);

  it('combines desktop + phone into a signature that verifies as the multisig', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const desktop = (await desktopKey.signTransaction(bytes)).signature;
    const phone = (await phoneKey.signTransaction(bytes)).signature;
    await verifyMemberSignature(bytes, desktop, ms.memberByRole('desktop'));
    await verifyMemberSignature(bytes, phone, ms.memberByRole('phone'));
    const combined = await combineSignatures(ms, bytes, [desktop, phone]);
    const signer = await verifyTransactionSignature(bytes, combined);
    expect(signer.toSuiAddress()).toBe(EXPECTED_ADDRESS);
  });

  it('combines desktop + backup too (recovery path)', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const desktop = (await desktopKey.signTransaction(bytes)).signature;
    const backup = (await backupKey.signTransaction(bytes)).signature;
    const combined = await combineSignatures(ms, bytes, [desktop, backup]);
    expect((await verifyTransactionSignature(bytes, combined)).toSuiAddress()).toBe(EXPECTED_ADDRESS);
  });

  it('refuses a single signature (below threshold)', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const desktop = (await desktopKey.signTransaction(bytes)).signature;
    await expect(combineSignatures(ms, bytes, [desktop])).rejects.toThrow('Signature is not valid for the provided Transaction');
  });

  it('refuses a signature from the wrong member', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const backup = (await backupKey.signTransaction(bytes)).signature;
    await expect(verifyMemberSignature(bytes, backup, ms.memberByRole('phone'))).rejects.toThrow(
      `signature is from ${backupKey.toSuiAddress()}, expected Phone (${phoneKey.toSuiAddress()})`,
    );
  });

  it('refuses a signature over different bytes', async () => {
    const bytes = await offlineTxBytes(ms.address, 1000);
    const other = await offlineTxBytes(ms.address, 2000);
    const desktop = (await desktopKey.signTransaction(other)).signature;
    await expect(verifyMemberSignature(bytes, desktop, ms.memberByRole('desktop'))).rejects.toThrow(
      'signature from Desktop does not verify over these transaction bytes',
    );
  });

  it('refuses an outsider in combine', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const desktop = (await desktopKey.signTransaction(bytes)).signature;
    const outsider = (await outsiderKey.signTransaction(bytes)).signature;
    await expect(combineSignatures(ms, bytes, [desktop, outsider])).rejects.toThrow('Received signature from unknown public key');
  });
});

describe('signingMember', () => {
  const ms = loadMultisig(multisigConfig);

  it('identifies whichever member signed, regardless of role', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const fromBackup = await signingMember(ms, bytes, (await backupKey.signTransaction(bytes)).signature);
    expect(fromBackup.role).toBe('backup');
    expect(fromBackup.address).toBe(backupKey.toSuiAddress());
    const fromPhone = await signingMember(ms, bytes, (await phoneKey.signTransaction(bytes)).signature);
    expect(fromPhone.index).toBe(1);
  });

  it('rejects an outsider and a signature over other bytes', async () => {
    const bytes = await offlineTxBytes(ms.address, 1000);
    await expect(signingMember(ms, bytes, (await outsiderKey.signTransaction(bytes)).signature)).rejects.toThrow(
      `signature is from ${outsiderKey.toSuiAddress()}, which is not a member of this multisig`,
    );
    const other = await offlineTxBytes(ms.address, 2000);
    await expect(signingMember(ms, bytes, (await desktopKey.signTransaction(other)).signature)).rejects.toThrow(
      'signature does not verify over these transaction bytes',
    );
  });
});

describe('2-of-2', () => {
  const twoOfTwo = { threshold: 2, members: multisigConfig.members.filter((m) => m.role !== 'backup') };
  const ms = loadMultisig(twoOfTwo);

  it('derives the same address as the sui CLI', () => {
    // sui keytool multi-sig-address --pks <desktop> <phone> --weights 1 1 --threshold 2
    expect(ms.address).toBe('0xcad3f2fe48e2483003637a2363a375404372b637f94b0af6892667915c275a12');
  });

  it('needs both keys', async () => {
    const bytes = await offlineTxBytes(ms.address);
    const desktop = (await desktopKey.signTransaction(bytes)).signature;
    const phone = (await phoneKey.signTransaction(bytes)).signature;
    const combined = await combineSignatures(ms, bytes, [desktop, phone]);
    expect((await verifyTransactionSignature(bytes, combined)).toSuiAddress()).toBe(ms.address);
    await expect(combineSignatures(ms, bytes, [desktop])).rejects.toThrow('Signature is not valid for the provided Transaction');
  });
});
