import test from 'node:test';
import assert from 'node:assert/strict';
import { ATFClient, ATFRequestError, buildAccountUserAgent } from '../src/api.js';

function createClient(http) {
  return new ATFClient({ initData: 'query_id=x&user=x&auth_date=1&hash=x', userInfo: { id: '123', username: 'user' }, deviceId: 'dev-test', baseUrl: 'https://example.test/index.php', webappUrl: 'https://example.test/index.html', maxAttempts: 2, retryDelayMs: 0, maxRetryDelayMs: 1, http });
}

test('retry memakai request_id yang sama', async () => {
  const bodies = [];
  let attempts = 0;
  const http = { async post(_url, body) { bodies.push(body); attempts += 1; if (attempts === 1) throw new Error('socket reset'); return { status: 200, data: { status: 'success' }, headers: {} }; } };
  assert.equal((await createClient(http).startMine()).status, 'success');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].request_id, bodies[1].request_id);
});

test('User-Agent stabil per akun dan berbeda antar akun', () => {
  const first = buildAccountUserAgent('123');
  assert.equal(first, buildAccountUserAgent('123'));
  assert.notEqual(first, buildAccountUserAgent('456'));
  assert.match(first, /^Mozilla\/5\.0 .* Chrome\/\d+\.0\.\d+\.\d+ Safari\/537\.36$/);

  const client = createClient({ post() {} });
  assert.equal(client.getHeaders()['User-Agent'], first);
});

test('HTTP 401 tidak di-retry', async () => {
  let attempts = 0;
  const http = { async post() { attempts += 1; return { status: 401, data: { message: 'Unauthorized' }, headers: {} }; } };
  await assert.rejects(createClient(http).startMine(), (error) => error instanceof ATFRequestError && error.code === 'AUTH_FAILED');
  assert.equal(attempts, 1);
});

test('login mengirim ref_code yang valid', async () => {
  let body;
  const http = { async post(_url, requestBody) { body = requestBody; return { status: 200, data: { status: 'success', user: {} }, headers: {} }; } };
  await createClient(http).login('610911604');
  assert.equal(body.ref_code, '610911604');
  assert.equal(body.username, 'user');
});

test('login mempertahankan reason entry captcha untuk penanganan pendaftaran', async () => {
  const http = {
    async post() {
      return {
        status: 200,
        data: {
          status: 'error',
          reason: 'entry_captcha_required',
          message: 'Security check required before opening ATF Miner.'
        },
        headers: {}
      };
    }
  };
  await assert.rejects(
    createClient(http).login('610911604'),
    (error) => error instanceof ATFRequestError &&
      error.code === 'entry_captcha_required' &&
      error.responseData?.reason === 'entry_captcha_required'
  );
});

test('entry captcha memakai action status dan verify resmi ATF', async () => {
  const requests = [];
  const http = {
    async post(url, body) {
      requests.push({ url, body });
      if (url.includes('action=captcha_status')) {
        return { status: 200, data: { status: 'success', captcha_enabled: 1, captcha_required: 1, config_ready: 1, site_key: 'site-key-123' }, headers: {} };
      }
      return { status: 200, data: { status: 'success' }, headers: {} };
    }
  };
  const client = createClient(http);
  const status = await client.getEntryCaptchaStatus();
  await client.verifyEntryCaptcha('turnstile-token-123');

  assert.equal(status.site_key, 'site-key-123');
  assert.equal(status.captcha_required, true);
  assert.match(requests[0].url, /action=captcha_status/);
  assert.match(requests[1].url, /action=verify_entry_captcha/);
  assert.equal(requests[1].body.captcha_token, 'turnstile-token-123');
});

test('getMathChallenge membaca challenge resmi dan startMine mengirim jawabannya', async () => {
  const requests = [];
  const http = {
    async post(url, body) {
      requests.push({ url, body });
      if (url.includes('action=get_math_challenge')) {
        return {
          status: 200,
          data: { status: 'success', challenge_id: 'challenge-123', question: '7 × 8', expires_in: 180 },
          headers: {}
        };
      }
      return { status: 200, data: { status: 'success', start_time: 123 }, headers: {} };
    }
  };

  const client = createClient(http);
  const challenge = await client.getMathChallenge('start_mine');
  await client.startMine({ challengeId: challenge.challenge_id, answer: '56' });

  assert.equal(challenge.question, '7 × 8');
  assert.equal(requests[0].body.scope, 'start_mine');
  assert.equal(requests[1].body.math_challenge_id, 'challenge-123');
  assert.equal(requests[1].body.math_answer, '56');
});

test('startMine menolak jawaban security question non-angka', async () => {
  assert.throws(
    () => createClient({ post() {} }).startMine({ challengeId: 'challenge-123', answer: '7+8' }),
    /harus berupa angka/,
  );
});

test('wallet proof payload dan syncWallet mengikuti field frontend ATF', async () => {
  const requests = [];
  const now = Math.floor(Date.now() / 1000);
  const http = {
    async post(url, body) {
      requests.push({ url, body });
      if (url.includes('action=get_wallet_proof_payload')) {
        return { status: 200, data: { status: 'success', payload: 'nonce-123', expires_at: now + 180 }, headers: {} };
      }
      return { status: 200, data: { status: 'success', user: { wallet_verified: 1 } }, headers: {} };
    }
  };
  const client = createClient(http);
  const payload = await client.getWalletProofPayload();
  const proof = {
    timestamp: now,
    domain: { lengthBytes: 12, value: 'example.test' },
    signature: Buffer.alloc(64, 1).toString('base64'),
    payload: payload.payload
  };
  await client.syncWallet({
    wallet: `0:${'ab'.repeat(32)}`,
    publicKey: 'cd'.repeat(32),
    walletStateInit: Buffer.from('state-init').toString('base64'),
    proof
  });

  assert.equal(requests[0].body.force, 1);
  assert.equal(requests[1].body.wallet, `0:${'ab'.repeat(32)}`);
  assert.equal(requests[1].body.public_key, 'cd'.repeat(32));
  assert.equal(requests[1].body.proof.payload, 'nonce-123');
});

test('syncWalletStats membaca statistik wallet tanpa membuat proof baru', async () => {
  let request;
  const http = {
    async post(url, body) {
      request = { url, body };
      return { status: 200, data: { status: 'busy', user: { wallet_holding_atf: 123 } }, headers: {} };
    }
  };
  const wallet = `0:${'ef'.repeat(32)}`;
  const response = await createClient(http).syncWalletStats(wallet);

  assert.match(request.url, /action=sync_wallet/);
  assert.equal(request.body.wallet, wallet);
  assert.equal(request.body.public_key, '');
  assert.equal(request.body.wallet_state_init, '');
  assert.equal(request.body.proof, null);
  assert.equal(request.body.refresh_holding, 0);
  assert.equal(response.user.wallet_holding_atf, 123);
});

test('withdraw memakai puzzle gambar, jawaban captcha, dan membaca history', async () => {
  const requests = [];
  const http = {
    async post(url, body) {
      requests.push({ url, body });
      if (url.includes('action=get_withdraw_puzzle')) {
        return { status: 200, data: { status: 'success', challenge_id: 'a1e336bac11970e0422ac7e1ba71976f', captcha_image: 'data:image/png;base64,AA==' }, headers: {} };
      }
      if (url.includes('action=get_withdraw_history')) {
        return { status: 200, data: { status: 'success', items: [{ id: '99', status: 'pending' }] }, headers: {} };
      }
      return { status: 200, data: { status: 'success', withdraw_id: 99, review_status: 'pending' }, headers: {} };
    }
  };
  const client = createClient(http);
  await client.getWithdrawPuzzle(500);
  await client.withdraw({ amount: 500, captchaId: 'a1e336bac11970e0422ac7e1ba71976f', captchaAnswer: 'HJU24' });
  const history = await client.getWithdrawHistory();

  assert.match(requests[0].url, /action=get_withdraw_puzzle/);
  assert.equal(requests[0].body.amount, 500);
  assert.equal('username' in requests[0].body, false);
  assert.match(requests[1].url, /action=withdraw/);
  assert.equal(requests[1].body.withdraw_captcha_id, 'a1e336bac11970e0422ac7e1ba71976f');
  assert.equal(requests[1].body.withdraw_captcha_answer, 'HJU24');
  assert.match(requests[2].url, /action=get_withdraw_history/);
  assert.equal(history.items[0].status, 'pending');
});

test('claim dan withdraw menerima request_id stabil untuk rotasi proxy', async () => {
  const requests = [];
  const http = {
    async post(url, body) {
      requests.push({ url, body });
      return { status: 200, data: { status: 'success' }, headers: {} };
    }
  };
  const client = createClient(http);
  await client.claim(12.5, 'claim-request-id');
  await client.withdraw({
    amount: 500,
    captchaId: 'a1e336bac11970e0422ac7e1ba71976f',
    captchaAnswer: 'HJU24',
    requestId: 'withdraw-request-id'
  });

  assert.equal(requests[0].body.request_id, 'claim-request-id');
  assert.equal(requests[1].body.request_id, 'withdraw-request-id');
});

test('getFriends memakai action get_friends dan identitas client standar', async () => {
  let request;
  const http = {
    async post(url, body) {
      request = { url, body };
      return { status: 200, data: { status: 'success', total: 5, success: 1, friends: [] }, headers: {} };
    }
  };
  const response = await createClient(http).getFriends();
  assert.match(request.url, /action=get_friends/);
  assert.equal(request.body.tg_id, 123);
  assert.equal(response.total, 5);
  assert.equal(response.success, 1);
});
