import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Address } from '@ton/core';
import { sha256_sync, signVerify } from '@ton/crypto';
import { WalletAccountStore, buildTonProof } from '../src/wallets.js';

function encryptLegacySecrets(secrets, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      kdf_parameters: { N: 32768, r: 8, p: 1 },
      contains: ['mnemonic', 'private_key'],
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      auth_tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    };
  } finally {
    key.fill(0);
  }
}

function proofDigest(address, proof) {
  const parsed = Address.parse(address);
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(parsed.workChain, 0);
  const domain = Buffer.from(proof.domain.value, 'utf8');
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(domain.length, 0);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE(BigInt(proof.timestamp), 0);
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'),
    workchain,
    parsed.hash,
    domainLength,
    domain,
    timestamp,
    Buffer.from(proof.payload)
  ]);
  return sha256_sync(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256_sync(message)]));
}

test('wallet account langsung disimpan plaintext dan dapat dibuka kembali tanpa password', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-wallet-'));
  const filePath = path.join(root, 'wallets-accounts.json');
  const store = new WalletAccountStore(filePath);
  const created = await store.getOrCreateManaged('27617462616');
  const fileText = fs.readFileSync(filePath, 'utf8');

  assert.equal(created.created, true);
  assert.match(fileText, /"mnemonic"\s*:/);
  assert.match(fileText, /"private_key"\s*:/);
  assert.doesNotMatch(fileText, /"encrypted_secrets"\s*:/);

  const reopened = await new WalletAccountStore(filePath).getOrCreateManaged('27617462616');
  assert.equal(reopened.created, false);
  assert.equal(reopened.address, created.address);
  assert.equal(reopened.publicKey, created.publicKey);
  reopened.secretKey.fill(0);
  created.secretKey.fill(0);

  const exported = new WalletAccountStore(filePath).exportManagedSecrets('27617462616');
  assert.equal(exported.mnemonic.length, 24);
  assert.match(exported.privateKey, /^[a-f0-9]{128}$/);

  const allExported = new WalletAccountStore(filePath).exportAllManagedSecrets();
  assert.equal(allExported['27617462616'].mnemonic.split(' ').length, 24);
  assert.match(allExported['27617462616'].private_key, /^[a-f0-9]{128}$/);
});

test('format export plaintext lama dikenali dan metadata wallet direkonstruksi', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-wallet-export-'));
  const filePath = path.join(root, 'wallets-accounts.json');
  const initialStore = new WalletAccountStore(filePath);
  const created = await initialStore.getOrCreateManaged('7573191204');
  const expectedAddress = created.address;
  created.secretKey.fill(0);

  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const record = state.accounts['7573191204'];
  delete record.managed;
  delete record.public_key;
  delete record.wallet_state_init;
  state.warning = 'PLAINTEXT WALLET SECRETS - DO NOT SHARE';
  state.exported_at = new Date().toISOString();
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);

  const reopened = new WalletAccountStore(filePath);
  assert.equal(reopened.hasManagedSecrets('7573191204'), true);
  assert.equal(reopened.get('7573191204').managed, true);

  const restored = await reopened.getOrCreateManaged('7573191204');
  assert.equal(restored.created, false);
  assert.equal(restored.address, expectedAddress);
  restored.secretKey.fill(0);
  assert.match(reopened.get('7573191204').public_key, /^[a-f0-9]{64}$/);
  assert.ok(reopened.get('7573191204').wallet_state_init.length > 0);
});

test('record encrypted_secrets lama dimigrasikan otomatis ke plaintext', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-wallet-'));
  const filePath = path.join(root, 'wallets-accounts.json');
  const password = 'password-benar-12345';
  const created = await new WalletAccountStore(filePath).getOrCreateManaged('27617462616');
  created.secretKey.fill(0);
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const record = state.accounts['27617462616'];
  record.encrypted_secrets = encryptLegacySecrets({
    mnemonic: record.mnemonic.split(' '),
    private_key: record.private_key
  }, password);
  delete record.mnemonic;
  delete record.private_key;
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);

  const migrated = new WalletAccountStore(filePath, password);
  const migratedText = fs.readFileSync(filePath, 'utf8');
  assert.match(migratedText, /"mnemonic"\s*:/);
  assert.match(migratedText, /"private_key"\s*:/);
  assert.doesNotMatch(migratedText, /"encrypted_secrets"\s*:/);
  assert.equal(migrated.exportManagedSecrets('27617462616').mnemonic.length, 24);
});

test('TON Proof yang dibuat dapat diverifikasi dengan public key wallet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-wallet-'));
  const wallet = await new WalletAccountStore(path.join(root, 'wallets-accounts.json'), 'password-ku-yang-kuat-123')
    .getOrCreateManaged('27617462616');
  const proof = buildTonProof({
    address: wallet.address,
    payload: 'server-issued-nonce',
    domain: 'atfminers.asloni.online',
    timestamp: 1787650000,
    secretKey: wallet.secretKey
  });

  assert.equal(proof.domain.lengthBytes, Buffer.byteLength('atfminers.asloni.online'));
  assert.equal(
    signVerify(proofDigest(wallet.address, proof), Buffer.from(proof.signature, 'base64'), Buffer.from(wallet.publicKey, 'hex')),
    true,
  );
  wallet.secretKey.fill(0);
});
