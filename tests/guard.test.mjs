// tests/guard.test.mjs — the site's rate limiter, on the anon key only.
// Plain node, no dependencies. Supabase and Anthropic are a stubbed fetch;
// the stub plays public.site_hit() (the CRM's SITE-HIT-MIGRATION.sql).
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guard, siteHit, bucketPart, ipOf } from '../api/_guard.js';
import { limiterMissing } from '../api/_env.js';

const ENV_KEYS = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY'];
const ON = { SUPABASE_URL: 'https://db.example.org/', SUPABASE_ANON_KEY: 'anon-public' };
const BUCKET = /^site:[A-Za-z0-9:._-]{1,195}$/;
const realFetch = globalThis.fetch;

/** Run `fn` with exactly `env` set and fetch replaced by a fake site_hit.
 *  limiter: 'up' | 'down' (500) | 'throw' | 'weird' (a 200 that is not a boolean). */
async function world(env, fn, { counts = {}, limiter = 'up' } = {}) {
  const old = {}; for (const k of ENV_KEYS) { old[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const calls = [], errors = [], origErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (call.url.includes('/rest/v1/')) {
      if (limiter === 'throw') throw new Error('ECONNRESET');
      if (limiter === 'down') return { ok: false, status: 500, json: async () => ({}) };
      if (limiter === 'weird') return { ok: true, status: 200, json: async () => ({ hint: 'not a boolean' }) };
      const b = call.body, n = counts[b.p_bucket] || 0;
      if (!BUCKET.test(b.p_bucket)) return { ok: false, status: 400, json: async () => ({ message: 'site_hit: the bucket must start with "site:"' }) };
      if (n >= b.p_limit) return { ok: true, status: 200, json: async () => true };
      if (b.p_record) counts[b.p_bucket] = n + 1;
      return { ok: true, status: 200, json: async () => false };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }] }) };
  };
  try { await fn(calls, errors, counts); }
  finally { globalThis.fetch = realFetch; console.error = origErr; for (const k of ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
  return calls;
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

test('the service key is never read: set alone, the limiter counts as missing, and it is never sent', async () => {
  const calls = await world({ SUPABASE_URL: 'https://db.example.org', SUPABASE_SERVICE_KEY: 'svc-secret', SUPABASE_SERVICE_ROLE_KEY: 'svc-secret' }, async (c, errors) => {
    assert.deepEqual(limiterMissing(), ['SUPABASE_ANON_KEY']);
    const r = await call(gated(AI));
    assert.equal(r.status, 503);
    assert.match(errors.join('\n'), /not set on this project: SUPABASE_ANON_KEY/);
  });
  assert.equal(calls.length, 0);
  for (const f of fs.readdirSync('api').filter(f => f.endsWith('.js'))) {
    assert.ok(!/SUPABASE_SERVICE(_ROLE)?_KEY/.test(fs.readFileSync(`api/${f}`, 'utf8').replace(/\/\/[^\n]*/g, '')), `${f} reads a service key`);
  }
});

test('NOT CONFIGURED: a form lets the request through and names what is missing; an AI route refuses', async () => {
  let calls = await world({}, async (c, errors) => {
    const r = await call(gated(FORM));
    assert.deepEqual([r.status, r.body.passed, r.body.limiter], [200, true, 'off']);
    assert.match(errors.join('\n'), /onboard: running WITHOUT a rate limit, not set on this project: SUPABASE_URL, SUPABASE_ANON_KEY/);
  });
  assert.equal(calls.length, 0);
  calls = await world({ SUPABASE_URL: 'https://db.example.org' }, async (c, errors) => {
    const r = await call(gated(AI));
    assert.equal(r.status, 503); assert.equal(r.gate, undefined);
    assert.match(r.body.error, /unavailable/);
    assert.match(errors.join('\n'), /chat: REFUSING, the rate limiter is not set on this project: SUPABASE_ANON_KEY/);
  });
  assert.equal(calls.length, 0);
});

test('DOWN: a 500, a dropped connection and a non-boolean answer each let a form through and make an AI route refuse', async () => {
  for (const limiter of ['down', 'throw', 'weird']) {
    await world(ON, async () => { const r = await call(gated(FORM)); assert.deepEqual([r.status, r.body.limiter], [200, 'down'], limiter); }, { limiter });
    await world(ON, async (c, errors) => { const r = await call(gated(AI)); assert.equal(r.status, 503, limiter); assert.match(errors.join('\n'), /REFUSING, the rate limiter cannot be reached/); }, { limiter });
  }
});

test('ON: exactly one kind of call — POST rpc/site_hit, the key on apikey only, global first then per IP', async () => {
  const calls = await world(ON, async () => {
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
    assert.match(c.body.p_bucket, BUCKET);
  }
  assert.deepEqual(calls.map(c => [c.body.p_bucket, c.body.p_window_sec, c.body.p_limit, c.body.p_record]), [
    ['site:chat:global', 86400, 3000, true],
    ['site:chat:ip:203.0.113.9', 600, 30, true],
  ]);
});

test('ON: the limits — the daily cap answers busy, the per-IP limit answers 429 with retry-after', async () => {
  await world(ON, async (c, errors) => {
    const r = await call(gated(AI));
    assert.equal(r.status, 429); assert.match(r.body.error, /busy/);
    assert.match(errors.join('\n'), /DAILY CAP HIT on chat/);
  }, { counts: { 'site:chat:global': 3000 } });
  await world(ON, async () => {
    const r = await call(gated(FORM));
    assert.equal(r.status, 429); assert.equal(r.headers['retry-after'], '600');
  }, { counts: { 'site:onboard:ip:203.0.113.9': 10 } });
  // a loop: the 31st request from one IP in the window is refused, and the counter holds 30
  await world(ON, async (c, e, counts) => {
    const seen = [];
    for (let i = 0; i < 31; i++) seen.push((await call(gated(AI))).status);
    assert.deepEqual(seen.slice(0, 30), Array(30).fill(200));
    assert.equal(seen[30], 429);
    assert.equal(counts['site:chat:ip:203.0.113.9'], 30);
  });
});

test('the size check and the method check run before the limiter is called', async () => {
  const calls = await world(ON, async () => {
    assert.equal((await call(gated(AI), { x: 'y'.repeat(30001) })).status, 413);
    assert.equal((await call(gated(AI), {}, { method: 'GET' })).status, 405);
  });
  assert.equal(calls.length, 0);
});

test('a header the database would refuse is folded into allowed characters, so it never looks like an outage', async () => {
  assert.equal(bucketPart('fe80::1%eth0'), 'fe80::1_eth0');
  assert.equal(bucketPart("1.2.3.4'; drop"), '1.2.3.4___drop');
  assert.equal(bucketPart(''), '_');
  assert.equal(bucketPart('x'.repeat(500)).length, 90);
  assert.equal(ipOf({ headers: { 'x-forwarded-for': ' 198.51.100.7 , 10.0.0.1' } }), '198.51.100.7');
  const calls = await world(ON, async () => {
    const r = await call(gated(AI), { messages: [] }, { ip: 'fe80::1%eth0 junk/../' });
    assert.equal(r.status, 200, 'not refused as "down"');
  });
  assert.match(calls[1].body.p_bucket, BUCKET);
});

test('siteHit: count-only asks without recording', async () => {
  await world(ON, async (c, e, counts) => {
    assert.equal(await siteHit('site:t:x', 1, 60, { record: false }), 'ok');
    assert.equal(counts['site:t:x'], undefined);
    assert.equal(await siteHit('site:t:x', 1, 60), 'ok');
    assert.equal(await siteHit('site:t:x', 1, 60, { record: false }), 'limit');
  });
  await world({}, async () => { assert.equal(await siteHit('site:t:x', 1, 60), 'off'); });
});

test('the real AI routes refuse before Anthropic when the limiter is missing; the forms do not opt in', async () => {
  for (const f of ['chat', 'chris-chat']) {
    const { default: handler } = await import(`../api/${f}.js`);
    const calls = await world({ ANTHROPIC_API_KEY: 'sk-test' }, async () => {
      const r = await call(handler, { messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(r.status, 503, f);
    });
    assert.equal(calls.length, 0, `${f} reached nothing at all`);
    assert.match(fs.readFileSync(`api/${f}.js`, 'utf8'), /guard\(req, res, \{[^}]*failClosed: true \}\)/, f);
  }
  for (const f of ['chris-lead', 'crm-onboard', 'landing-onboard', 'onboard']) {
    assert.ok(!/failClosed/.test(fs.readFileSync(`api/${f}.js`, 'utf8')), `${f} is a form: it lets requests through`);
  }
});
