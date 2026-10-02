import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractInitDataFromWebViewUrl, inspectTelethonSession } from '../src/telegram.js';

test('inspectTelethonSession membaca metadata tanpa mengubah file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atf-session-'));
  const sessionPath = path.join(root, 'test.session');
  const database = new DatabaseSync(sessionPath);
  database.exec('CREATE TABLE sessions (dc_id INTEGER PRIMARY KEY, server_address TEXT, port INTEGER, auth_key BLOB, takeout_id INTEGER)');
  database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(4, '149.154.167.92', 443, Buffer.alloc(256, 7), null);
  database.close();
  const before = fs.statSync(sessionPath).size;
  const metadata = inspectTelethonSession(sessionPath);
  assert.equal(metadata.dcId, 4);
  assert.equal(metadata.authKey.length, 256);
  assert.equal(before, fs.statSync(sessionPath).size);
});

test('extractInitDataFromWebViewUrl membaca tgWebAppData dari query', () => {
  const initData = 'query_id=AAE123&user=%7B%22id%22%3A123%7D&hash=abc';
  const webViewUrl = `https://example.test/?tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0`;

  assert.equal(extractInitDataFromWebViewUrl(webViewUrl), initData);
});

test('extractInitDataFromWebViewUrl membaca tgWebAppData dari fragment', () => {
  const initData = 'query_id=AAE456&user=%7B%22id%22%3A456%7D&hash=def';
  const webViewUrl = `https://example.test/app#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0`;

  assert.equal(extractInitDataFromWebViewUrl(webViewUrl), initData);
});

test('extractInitDataFromWebViewUrl menolak URL tanpa tgWebAppData', () => {
  assert.throws(
    () => extractInitDataFromWebViewUrl('https://example.test/#tgWebAppVersion=8.0'),
    /tgWebAppData tidak ditemukan/,
  );
});
