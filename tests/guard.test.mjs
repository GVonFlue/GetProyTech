// tests/guard.test.mjs — the site's rate limiter, on the anon key only, with
// keyed counter names. Plain node, no dependencies. Supabase and Anthropic are
// a stubbed fetch; the stub plays public.site_hit() (the CRM's
// SITE-HIT-MIGRATION.sql). The salts below are test values, not secrets.
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guard, siteHit, ipOf } from '../api/_guard.js';
import { limiterMissing } from '../api/_env.js';
import { keyedBucket, SALT_MIN } from '../api/_bucket.js';

const SALT = 'test-salt-test-salt-test-salt-0001';
const ENV_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SITE_LIMIT_SALT', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY'];
const ON = { SUPABASE_URL: 'https://db.example.org/', SUPABASE_ANON_KEY: 'anon-public', SITE_LIMIT_SALT: SALT };
const KEYED = /^site:[0-9a-f]{40}$/;
const K = name => keyedBucket(name, SALT);
const realFetch = globalThis.fetch;

/** Run `fn` with exactly `env` set and fetch replaced by a fake site_hit.
 *  `counts` is by READABLE name; the stub only ever sees keyed ones.
 *  limiter: 'up' | 'down' (500) | 'throw' | 'weird' (a 200 that is not a
 *  boolean) | 'full' (the table ceiling: NULL). */
async function world(env, fn, { counts = {}, limiter = 'up' } = {}) {
  const old = {}; for (const k of ENV_KEYS) { old[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const byKey = {}; for (const [n, v] of Object.entries(counts)) byKey[K(n)] = v;
  const calls = [], errors = [], origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.url.includes('/rest/v1/')) {
      if (limiter === 'throw') throw new Error('ECONNRESET');
      if (limiter === 'down') return { ok: false, status: 500, json: async () => ({}) };
      if (limiter === 'weird') return { ok: true, status: 200, json: async () => ({ hint: 'not a boolean' }) };
      if (limiter === 'full') return { ok: true, status: 200, json: async () => null };
      const b = call.body, n = byKey[b.p_bucket] || 0;
      if (!/^site:[A-Za-z0-9:._-]{1,195}$/.test(b.p_bucket)) return { ok: false, status: 400, json: async () => ({}) };
      if (n >= b.p_limit) return { ok: true, status: 200, json: async () => true };
      if (b.p_record) byKey[b.p_bucket] = n + 1;
      return { ok: true, status: 200, json: async () => false };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) };
  };
  try { await fn(calls, errors, name => byKey[K(name)]); }
  finally { globalThis.fetch = realFetch; console.error = origErr; for (const k of ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  return { calls, errors };
}
function call(handler, body = { messages: [] }, { method = 'POST', ip = '203.0.113.9' } = {}) {
  return new Promise(resolve => {
    const out = { status: 0, headers: {}, body: undefined };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; resolve(out); return res; }, end() { resolve(out); return res; }, setHeader(k, v) { out.headers[k.toLowerCase()] = v; } };
    Promise.resolve(handler({ method, body, headers: { 'x-forwarded-for': ip } }, res)).then(r => { if (!out.status) resolve({ ...out, gate: r }); }).catch(e => resolve({ status: 599, body: { thrown: String(e) } }));
  });
}
/** The guard alone, behind a handler that answers 200 when the gate opens. */
const gated = opts => async (req, res) => { const g = await guard(req, res, opts); if (g.ok) res.status(200).json({ passed: true, limiter: g.limiter }); };
const FORM = { name: 'onboard', perIp: 10, windowMin: 10, perDay: 1000, maxChars: 40000 };
const AI = { name: 'chat', perIp: 30, windowMin: 10, perDay: 3000, maxChars: 30000, failClosed: true };

test('KEYED: the same readable name under two salts is two different buckets; each is site: + 40 hex', () => {
  const a = keyedBucket('site:onboard:global', SALT), b = keyedBucket('site:onboard:global', SALT.replace('0001', '0002'));
  assert.match(a, KEYED); assert.match(b, KEYED);
  assert.notEqual(a, b, 'a different salt gives a different bucket');
  assert.equal(a, keyedBucket('site:onboard:global', SALT), 'the same salt gives the same bucket every time');
  assert.notEqual(a, keyedBucket('site:onboard:ip:203.0.113.9', SALT));
  assert.throws(() => keyedBucket('site:x', ''), /SITE_LIMIT_SALT/);
  assert.throws(() => keyedBucket('site:x', 'x'.repeat(SALT_MIN - 1)), /SITE_LIMIT_SALT/);
});

test('KEYED: no readable name and no salt ever leaves; the readable name is in the log', async () => {
  const { calls, errors } = await world(ON, async () => {
    for (let i = 0; i < 2; i++) await call(gated(AI));
  }, { counts: { 'site:chat:global': 3000 } });
  const sent = JSON.stringify(calls);
  for (const readable of ['chat', 'global', '203.0.113.9', SALT]) assert.ok(!sent.includes(readable), `${readable} was sent`);
  for (const c of calls) assert.match(c.body.p_bucket, KEYED);
  assert.match(errors.join('\n'), /DAILY CAP HIT on chat/);
  assert.ok(!errors.join('\n').includes(SALT), 'the salt is never logged');
});

test('MISSING SALT counts as not configured: named, forms pass, AI refuses, nothing is sent', async () => {
  for (const salt of [undefined, '', 'too-short']) {
    const env = { ...ON }; if (salt === undefined) delete env.SITE_LIMIT_SALT; else env.SITE_LIMIT_SALT = salt;
    let w = await world(env, async () => {
      assert.deepEqual(limiterMissing(), ['SITE_LIMIT_SALT'], String(salt));
      const r = await call(gated(FORM));
      assert.deepEqual([r.status, r.body.limiter], [200, 'off']);
    });
    assert.equal(w.calls.length, 0); assert.match(w.errors.join('\n'), /onboard: running WITHOUT a rate limit, not set on this project: SITE_LIMIT_SALT/);
    w = await world(env, async () => { assert.equal((await call(gated(AI))).status, 503); });
    assert.equal(w.calls.length, 0); assert.match(w.errors.join('\n'), /chat: REFUSING, the rate limiter is not set on this project: SITE_LIMIT_SALT/);
    w = await world(env, async () => { assert.equal(await siteHit('site:t:x', 1, 60), 'off'); });
    assert.equal(w.calls.length, 0, 'siteHit itself never sends a readable name');
  }
});

test('the service key is never read: set alone, the limiter counts as missing, and it is never sent', async () => {
  const { calls, errors } = await world({ SUPABASE_URL: 'https://db.example.org', SITE_LIMIT_SALT: SALT, SUPABASE_SERVICE_KEY: 'svc-secret', SUPABASE_SERVICE_ROLE_KEY: 'svc-secret' }, async () => {
    assert.deepEqual(limiterMissing(), ['SUPABASE_ANON_KEY']);
    assert.equal((await call(gated(AI))).status, 503);
  });
  assert.equal(calls.length, 0);
  assert.match(errors.join('\n'), /not set on this project: SUPABASE_ANON_KEY/);
  for (const f of fs.readdirSync('api').filter(f => f.endsWith('.js'))) {
    assert.ok(!/SUPABASE_SERVICE(_ROLE)?_KEY/.test(fs.readFileSync(`api/${f}`, 'utf8').replace(/\/\/[^\n]*/g, '')), `${f} reads a service key`);
  }
});

test('NOT CONFIGURED: all three named, in order; a form passes, an AI route refuses', async () => {
  let w = await world({}, async () => {
    const r = await call(gated(FORM));
    assert.deepEqual([r.status, r.body.passed, r.body.limiter], [200, true, 'off']);
  });
  assert.equal(w.calls.length, 0);
  assert.match(w.errors.join('\n'), /onboard: running WITHOUT a rate limit, not set on this project: SUPABASE_URL, SUPABASE_ANON_KEY, SITE_LIMIT_SALT/);
  w = await world({ SUPABASE_URL: 'https://db.example.org', SITE_LIMIT_SALT: SALT }, async () => {
    const r = await call(gated(AI));
    assert.equal(r.status, 503); assert.match(r.body.error, /unavailable/);
  });
  assert.equal(w.calls.length, 0);
  assert.match(w.errors.join('\n'), /chat: REFUSING, the rate limiter is not set on this project: SUPABASE_ANON_KEY/);
});

test('DOWN: a 500, a dropped connection, a non-boolean and a full table (NULL) each let a form through and make an AI route refuse', async () => {
  for (const limiter of ['down', 'throw', 'weird', 'full']) {
    await world(ON, async () => { const r = await call(gated(FORM)); assert.deepEqual([r.status, r.body.limiter], [200, 'down'], limiter); }, { limiter });
    const w = await world(ON, async () => { const r = await call(gated(AI)); assert.equal(r.status, 503, limiter); }, { limiter });
    assert.match(w.errors.join('\n'), /REFUSING, the rate limiter cannot be reached/);
  }
  const w = await world(ON, async () => { await call(gated(FORM)); }, { limiter: 'full' });
  assert.match(w.errors.join('\n'), /table is full; treating site:onboard:global as down/);
});

test('ON: exactly one kind of call — POST rpc/site_hit, the key on apikey only, global first then per IP', async () => {
  const { calls } = await world(ON, async () => {
    const r = await call(gated(AI));
    assert.deepEqual([r.status, r.body.limiter], [200, 'on']);
  });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, 'https://db.example.org/rest/v1/rpc/site_hit', 'never the api_hits table, and the trailing slash is folded');
    assert.equal(c.method, 'POST');
    assert.deepEqual(Object.keys(c.headers).sort(), ['apikey', 'content-type']);
    assert.equal(c.headers.apikey, 'anon-public');
    assert.deepEqual(Object.keys(c.body), ['p_bucket', 'p_window_sec', 'p_limit', 'p_record']);
  }
  assert.deepEqual(calls.map(c => [c.body.p_bucket, c.body.p_window_sec, c.body.p_limit, c.body.p_record]), [
    [K('site:chat:global'), 86400, 3000, true],
    [K('site:chat:ip:203.0.113.9'), 600, 30, true],
  ]);
});

test('ON: the limits — the daily cap answers busy, the per-IP limit answers 429 with retry-after', async () => {
  let w = await world(ON, async () => {
    const r = await call(gated(AI));
    assert.equal(r.status, 429); assert.match(r.body.error, /busy/);
  }, { counts: { 'site:chat:global': 3000 } });
  assert.match(w.errors.join('\n'), /DAILY CAP HIT on chat/);
  await world(ON, async () => {
    const r = await call(gated(FORM));
    assert.equal(r.status, 429); assert.equal(r.headers['retry-after'], '600');
  }, { counts: { 'site:onboard:ip:203.0.113.9': 10 } });
  // a loop: the 31st request from one IP in the window is refused, and the counter holds 30
  await world(ON, async (c, e, count) => {
    const seen = [];
    for (let i = 0; i < 31; i++) seen.push((await call(gated(AI))).status);
    assert.deepEqual(seen.slice(0, 30), Array(30).fill(200));
    assert.equal(seen[30], 429);
    assert.equal(count('site:chat:ip:203.0.113.9'), 30);
  });
});

test('the size check and the method check run before the limiter is called', async () => {
  const { calls } = await world(ON, async () => {
    assert.equal((await call(gated(AI), { x: 'y'.repeat(30001) })).status, 413);
    assert.equal((await call(gated(AI), {}, { method: 'GET' })).status, 405);
  });
  assert.equal(calls.length, 0);
});

test('any header is safe: the keyed name is always one site_hit accepts', async () => {
  assert.equal(ipOf({ headers: { 'x-forwarded-for': ' 198.51.100.7 , 10.0.0.1' } }), '198.51.100.7');
  const { calls } = await world(ON, async () => {
    const r = await call(gated(AI), { messages: [] }, { ip: "fe80::1%eth0 junk/../'; drop" });
    assert.equal(r.status, 200, 'not refused as "down"');
  });
  assert.match(calls[1].body.p_bucket, KEYED);
});

test('siteHit: count-only asks without recording', async () => {
  await world(ON, async (c, e, count) => {
    assert.equal(await siteHit('site:t:x', 1, 60, { record: false }), 'ok');
    assert.equal(count('site:t:x'), undefined);
    assert.equal(await siteHit('site:t:x', 1, 60), 'ok');
    assert.equal(await siteHit('site:t:x', 1, 60, { record: false }), 'limit');
  });
});

test('the real AI routes refuse before Anthropic when the limiter is missing; the forms do not opt in', async () => {
  for (const f of ['chat', 'chris-chat']) {
    const { default: handler } = await import(`../api/${f}.js`);
    const { calls } = await world({ ANTHROPIC_API_KEY: 'sk-test', SUPABASE_URL: 'https://db.example.org', SUPABASE_ANON_KEY: 'anon-public' }, async () => {
      const r = await call(handler, { messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 503, f + ': no salt, so no limiter');
    });
    assert.equal(calls.length, 0, `${f} reached nothing at all`);
    assert.match(fs.readFileSync(`api/${f}.js`, 'utf8'), /guard\(req, res, \{[^}]*failClosed: true \}\)/, f);
  }
  for (const f of ['chris-lead', 'crm-onboard', 'landing-onboard', 'onboard']) {
    assert.ok(!/failClosed/.test(fs.readFileSync(`api/${f}.js`, 'utf8')), `${f} is a form: it lets requests through`);
  }
});
