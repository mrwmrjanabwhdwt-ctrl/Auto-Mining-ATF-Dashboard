import crypto from 'node:crypto';
import fs from 'node:fs';
import { Address, beginCell, storeStateInit } from '@ton/core';
import { mnemonicNew, mnemonicToWalletKey, sha256_sync, sign } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { readJsonFile, writeJsonAtomic } from './utils.js';

const KEYSTORE_VERSION = 1;
const NETWORK_MAINNET = '-239';
const WALLET_VERSION = 'v4r2';
const KDF_PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32 });

function requirePassword(password) {
  const normalized = String(password || '');
  if (normalized.length < 12) {
    throw new Error('WALLET_KEYSTORE_PASSWORD wajib diisi minimal 12 karakter pada .env');
  }
  if (normalized.length > 1024) throw new Error('WALLET_KEYSTORE_PASSWORD terlalu panjang');
  return normalized;
}

function deriveEncryptionKey(password, salt) {
  return crypto.scryptSync(requirePassword(password), salt, KDF_PARAMETERS.keyLength, {
    N: KDF_PARAMETERS.N,
    r: KDF_PARAMETERS.r,
    p: KDF_PARAMETERS.p,
    maxmem: 64 * 1024 * 1024
  });
}

function decryptSecrets(encrypted, password) {
  if (!encrypted || encrypted.algorithm !== 'aes-256-gcm' || encrypted.kdf !== 'scrypt') {
    throw new Error('Format encrypted wallet secrets tidak didukung');
  }
  try {
    const salt = Buffer.from(encrypted.salt || '', 'base64');
    const iv = Buffer.from(encrypted.iv || '', 'base64');
    const authTag = Buffer.from(encrypted.auth_tag || '', 'base64');
    const ciphertext = Buffer.from(encrypted.ciphertext || '', 'base64');
    if (salt.length !== 16 || iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
      throw new Error('Data encrypted wallet tidak lengkap');
    }
    const key = deriveEncryptionKey(password, salt);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return JSON.parse(plaintext.toString('utf8'));
      } finally {
        plaintext.fill(0);
      }
    } finally {
      key.fill(0);
    }
  } catch (error) {
    if (/WALLET_KEYSTORE_PASSWORD/.test(error.message)) throw error;
    throw new Error('Wallet tidak dapat dibuka; password salah atau file rusak');
  }
}

function normalizeMnemonic(value) {
  const words = Array.isArray(value)
    ? value.map(String)
    : String(value || '').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 24) throw new Error('Mnemonic wallet harus berisi 24 kata');
  return words;
}

function readRecordSecrets(record, password) {
  if (record?.mnemonic && record?.private_key) {
    return {
      mnemonic: normalizeMnemonic(record.mnemonic),
      privateKey: String(record.private_key)
    };
  }
  if (record?.encrypted_secrets) {
    const legacy = decryptSecrets(record.encrypted_secrets, password);
    return {
      mnemonic: normalizeMnemonic(legacy.mnemonic),
      privateKey: String(legacy.private_key || '')
    };
  }
  throw new Error('Wallet managed tidak memiliki mnemonic/private key lokal');
}

function buildWalletMetadata(publicKey) {
  const contract = WalletContractV4.create({ workchain: 0, publicKey });
  const stateInit = beginCell().store(storeStateInit(contract.init)).endCell().toBoc().toString('base64');
  return {
    address: contract.address.toRawString(),
    friendlyAddress: contract.address.toString({ bounceable: false, testOnly: false, urlSafe: true }),
    publicKey: publicKey.toString('hex'),
    walletStateInit: stateInit,
    network: NETWORK_MAINNET,
    walletVersion: WALLET_VERSION
  };
}

function validateAccountId(accountId) {
  const value = String(accountId || '').trim();
  if (!/^\d{4,20}$/.test(value)) throw new Error('Telegram account ID untuk wallet tidak valid');
  return value;
}

export class WalletAccountStore {
  constructor(filePath, password = '') {
    this.filePath = filePath;
    this.password = password;
    this.state = { version: KEYSTORE_VERSION, accounts: {} };
    if (fs.existsSync(filePath)) {
      const parsed = readJsonFile(filePath, 'wallets-accounts.json');
      if (parsed?.version !== KEYSTORE_VERSION || !parsed.accounts || Array.isArray(parsed.accounts) || typeof parsed.accounts !== 'object') {
        throw new Error('Format wallets-accounts.json tidak valid');
      }
      this.state = parsed;
      let migrated = false;
      for (const record of Object.values(this.state.accounts)) {
        if (record?.encrypted_secrets) {
          const secrets = readRecordSecrets(record, this.password);
          if (!/^[a-f0-9]{128}$/i.test(secrets.privateKey)) throw new Error('Private key wallet lama tidak valid');
          record.mnemonic = secrets.mnemonic.join(' ');
          record.private_key = secrets.privateKey;
          delete record.encrypted_secrets;
          record.managed = true;
          migrated = true;
          continue;
        }

        // Format export plaintext lama tidak memiliki field `managed`,
        // public_key, atau wallet_state_init. Mnemonic + private key yang
        // lengkap tetap merupakan bukti bahwa wallet dikelola secara lokal.
        if (record?.mnemonic && record?.private_key) {
          try {
            const secrets = readRecordSecrets(record, this.password);
            if (secrets.mnemonic.length === 24 && /^[a-f0-9]{128}$/i.test(secrets.privateKey) && record.managed !== true) {
              record.managed = true;
              migrated = true;
            }
          } catch {
            // Record invalid tidak ditandai managed dan akan ditangani aman
            // oleh pemeriksaan akun tanpa mencetak isi secret.
          }
        }
      }
      if (migrated) this.save();
    }
  }

  save() {
    writeJsonAtomic(this.filePath, this.state);
  }

  get(accountId) {
    return this.state.accounts[validateAccountId(accountId)] || null;
  }

  hasManagedSecrets(accountId) {
    const record = this.get(accountId);
    if (record?.managed !== true) return false;
    try {
      const secrets = readRecordSecrets(record, this.password);
      return secrets.mnemonic.length === 24 && /^[a-f0-9]{128}$/i.test(secrets.privateKey);
    } catch {
      return false;
    }
  }

  recordServerWallet(accountId, user) {
    const key = validateAccountId(accountId);
    const address = String(user?.wallet_address || '').trim();
    if (!address) return null;
    const previous = this.state.accounts[key] || {};
    const sameManagedWallet = previous.managed === true && previous.address === address;
    if (previous.managed === true && this.hasManagedSecrets(key) && !sameManagedWallet) {
      // Jangan pernah menghapus mnemonic lokal hanya karena login masih
      // melaporkan wallet lama. Ini dapat terjadi saat replacement sedang
      // pending/busy atau setelah proses dihentikan di tengah jalan.
      previous.server_wallet_address = address;
      previous.server_wallet_verified = Number(user.wallet_verified) === 1 || user.wallet_verified === true;
      previous.server_wallet_observed_at = new Date().toISOString();
      this.save();
      return previous;
    }
    this.state.accounts[key] = {
      ...(sameManagedWallet ? previous : {}),
      managed: sameManagedWallet,
      address,
      friendly_address: sameManagedWallet ? previous.friendly_address : '',
      public_key: sameManagedWallet ? previous.public_key : '',
      wallet_state_init: sameManagedWallet ? previous.wallet_state_init : '',
      network: sameManagedWallet ? previous.network : NETWORK_MAINNET,
      wallet_version: sameManagedWallet ? previous.wallet_version : 'external',
      wallet_verified: Number(user.wallet_verified) === 1 || user.wallet_verified === true,
      observed_at: new Date().toISOString(),
      ...(sameManagedWallet ? {} : { mnemonic: '', private_key: '' })
    };
    this.save();
    return this.state.accounts[key];
  }

  async getOrCreateManaged(accountId) {
    const key = validateAccountId(accountId);
    const existing = this.state.accounts[key];
    if (existing?.managed === true) {
      const secrets = readRecordSecrets(existing, this.password);
      const mnemonic = secrets.mnemonic;
      const storedPrivateKey = secrets.privateKey;
      if (mnemonic.length !== 24 || !/^[a-f0-9]{128}$/i.test(storedPrivateKey)) {
        throw new Error('Isi wallet secrets tidak valid');
      }
      const keyPair = await mnemonicToWalletKey(mnemonic);
      if (keyPair.secretKey.toString('hex') !== storedPrivateKey) {
        keyPair.secretKey.fill(0);
        throw new Error('Mnemonic dan private key wallet tidak cocok');
      }
      const metadata = buildWalletMetadata(keyPair.publicKey);
      if (metadata.address !== existing.address || (existing.public_key && metadata.publicKey !== existing.public_key)) {
        keyPair.secretKey.fill(0);
        throw new Error('Wallet secrets tidak cocok dengan metadata publik');
      }
      const metadataIncomplete = existing.public_key !== metadata.publicKey ||
        existing.wallet_state_init !== metadata.walletStateInit ||
        existing.friendly_address !== metadata.friendlyAddress ||
        existing.wallet_version !== metadata.walletVersion ||
        existing.network !== metadata.network;
      if (metadataIncomplete) {
        existing.managed = true;
        existing.friendly_address = metadata.friendlyAddress;
        existing.public_key = metadata.publicKey;
        existing.wallet_state_init = metadata.walletStateInit;
        existing.network = metadata.network;
        existing.wallet_version = metadata.walletVersion;
        this.save();
      }
      return { ...metadata, secretKey: keyPair.secretKey, created: false };
    }

    const mnemonic = await mnemonicNew(24);
    const keyPair = await mnemonicToWalletKey(mnemonic);
    const metadata = buildWalletMetadata(keyPair.publicKey);

    this.state.accounts[key] = {
      managed: true,
      address: metadata.address,
      friendly_address: metadata.friendlyAddress,
      public_key: metadata.publicKey,
      wallet_state_init: metadata.walletStateInit,
      network: metadata.network,
      wallet_version: metadata.walletVersion,
      wallet_verified: false,
      created_at: new Date().toISOString(),
      mnemonic: mnemonic.join(' '),
      private_key: keyPair.secretKey.toString('hex')
    };
    this.save();
    return { ...metadata, secretKey: keyPair.secretKey, created: true };
  }

  async getOrCreateReplacementManaged(accountId, previousServerAddress = '') {
    const key = validateAccountId(accountId);
    const existing = this.state.accounts[key];
    if (existing?.managed === true && this.hasManagedSecrets(key)) {
      if (existing.replacement_pending !== true) {
        throw new Error('Akun sudah memiliki mnemonic/private key wallet yang valid');
      }
      const wallet = await this.getOrCreateManaged(key);
      return { ...wallet, replacementCreated: false, replacementResumed: true };
    }

    const mnemonic = await mnemonicNew(24);
    const keyPair = await mnemonicToWalletKey(mnemonic);
    const metadata = buildWalletMetadata(keyPair.publicKey);
    const oldAddress = String(previousServerAddress || existing?.address || '').trim();

    this.state.accounts[key] = {
      managed: true,
      address: metadata.address,
      friendly_address: metadata.friendlyAddress,
      public_key: metadata.publicKey,
      wallet_state_init: metadata.walletStateInit,
      network: metadata.network,
      wallet_version: metadata.walletVersion,
      wallet_verified: false,
      replacement_pending: true,
      previous_wallet_address: oldAddress,
      created_at: new Date().toISOString(),
      mnemonic: mnemonic.join(' '),
      private_key: keyPair.secretKey.toString('hex')
    };
    // Commit secret terlebih dahulu. Kegagalan/busy pada API setelah titik ini
    // tidak boleh membuat mnemonic replacement hilang.
    this.save();
    return {
      ...metadata,
      secretKey: keyPair.secretKey,
      created: true,
      replacementCreated: true,
      replacementResumed: false
    };
  }

  exportManagedSecrets(accountId) {
    const key = validateAccountId(accountId);
    const record = this.state.accounts[key];
    if (!record?.managed) {
      throw new Error('Akun ini tidak memiliki wallet yang dibuat dan dikelola oleh bot');
    }
    const secrets = readRecordSecrets(record, this.password);
    const mnemonic = secrets.mnemonic;
    const privateKey = secrets.privateKey;
    if (mnemonic.length !== 24 || !/^[a-f0-9]{128}$/i.test(privateKey)) {
      throw new Error('Isi wallet secrets tidak valid');
    }
    return {
      address: record.address,
      friendlyAddress: record.friendly_address,
      mnemonic,
      privateKey
    };
  }

  exportAllManagedSecrets() {
    const accounts = {};
    for (const [accountId, record] of Object.entries(this.state.accounts)) {
      if (!record?.managed) continue;
      const secrets = this.exportManagedSecrets(accountId);
      accounts[accountId] = {
        address: secrets.address,
        friendly_address: secrets.friendlyAddress,
        wallet_version: record.wallet_version,
        network: record.network,
        mnemonic: secrets.mnemonic.join(' '),
        private_key: secrets.privateKey
      };
    }
    return accounts;
  }

  markVerified(accountId, address) {
    const key = validateAccountId(accountId);
    const record = this.state.accounts[key];
    if (!record || record.address !== String(address)) throw new Error('Wallet terverifikasi tidak cocok dengan record lokal');
    record.wallet_verified = true;
    record.verified_at = new Date().toISOString();
    record.replacement_pending = false;
    delete record.server_wallet_address;
    delete record.server_wallet_verified;
    delete record.server_wallet_observed_at;
    this.save();
  }
}

export function buildTonProof({ address, payload, domain, timestamp = Math.floor(Date.now() / 1000), secretKey }) {
  const walletAddress = Address.parse(String(address));
  const nonce = String(payload || '');
  const hostname = String(domain || '').trim().toLowerCase();
  if (!nonce || nonce.length > 4096) throw new Error('Payload TON Proof tidak valid');
  if (!/^[a-z0-9.-]{1,253}$/.test(hostname)) throw new Error('Domain TON Proof tidak valid');
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error('Timestamp TON Proof tidak valid');
  if (!Buffer.isBuffer(secretKey) || secretKey.length !== 64) throw new Error('Private key TON tidak valid');

  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(walletAddress.workChain, 0);
  const domainBytes = Buffer.from(hostname, 'utf8');
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(domainBytes.length, 0);
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigUInt64LE(BigInt(timestamp), 0);
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    workchain,
    walletAddress.hash,
    domainLength,
    domainBytes,
    timestampBytes,
    Buffer.from(nonce, 'utf8')
  ]);
  const messageHash = sha256_sync(message);
  const digest = sha256_sync(Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from('ton-connect', 'utf8'),
    messageHash
  ]));

  return {
    timestamp,
    domain: { lengthBytes: domainBytes.length, value: hostname },
    signature: sign(digest, secretKey).toString('base64'),
    payload: nonce
  };
}
