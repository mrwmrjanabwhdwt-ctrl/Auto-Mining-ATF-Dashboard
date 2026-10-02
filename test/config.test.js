import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSessionAccounts, loadProxies, validateHttpsUrl, validateProxy } from '../src/config.js';

test('validateHttpsUrl menerapkan HTTPS dan allowlist', () => {
  assert.equal(validateHttpsUrl('https://example.test/api', ['example.test']).hostname, 'example.test');
  assert.throws(() => validateHttpsUrl('http://example.test/api', ['example.test']), /HTTPS/);
  assert.throws(() => validateHttpsUrl('https://evil.test/api', ['example.test']), /tidak diizinkan/);
});

test('validateProxy hanya menerima HTTP(S) dengan port', () => {
  assert.match(validateProxy('http://user:pass@127.0.0.1:8080'), /^http:/);
  assert.throws(() => validateProxy('socks5://127.0.0.1:1080'), /tidak didukung/);
  assert.throws(() => validateProxy('http://127.0.0.1'), /port/);
});

test('proxy kosong memakai fallback dan session directory dipindai otomatis', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-config-'));
  fs.writeFileSync(path.join(root, 'proxy.txt'), '\n');
  fs.writeFileSync(path.join(root, 'proxies.txt'), 'http://127.0.0.1:8080\n');
  const sessionDirectory = path.join(root, 'session');
  fs.mkdirSync(sessionDirectory);
  fs.writeFileSync(path.join(sessionDirectory, 'akun2.session'), 'x');
  fs.writeFileSync(path.join(sessionDirectory, 'akun1.session'), 'x');
  fs.writeFileSync(path.join(root, 'account-overrides.json'), JSON.stringify({ 'akun2.session': { enabled: false } }));
  const accounts = discoverSessionAccounts(root, { session_directory: 'session', account_overrides_file: 'account-overrides.json' }, loadProxies(root));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].fileName, 'akun1.session');
  assert.match(accounts[0].proxy, /^http:/);
});
