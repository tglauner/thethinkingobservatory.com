import test from 'node:test';
import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { createTutorServer } from '../scripts/tutor-server.mjs';

const fresh = { session: null, topic: 'Probability', goal: 'Independent problem solving (level 4)', message: '' };
const modelTurn = () => ({ reply: 'We will start with a few diagnostic questions. What does independence mean?', phase: 'diagnostic', focus: 'events', skills: [{ id: 'events', name: 'Events', level: 0, evidence: null }], notes: [] });
async function preview(t, overrides = {}) {
  const logs = [];
  const server = createTutorServer(process.cwd(), { ask: async () => modelTurn(), status: async () => ({ available: true, provider: 'codex', message: 'Test connection.' }), logger: { info: text => logs.push(text), error: text => logs.push(text) }, ...overrides });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body = fresh, options = {}) => fetch(`${url}/api/tutor`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body), ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'headers')) });
  return { server, url, post, logs };
}

test('local tutor status exposes availability without provider secrets', async t => {
  const { url } = await preview(t);
  const response = await fetch(`${url}/api/tutor/status`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { available: true, provider: 'codex', message: 'Test connection.' });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('the API starts an actual tutor session through its injected model adapter', async t => {
  let prompt;
  const { post, logs } = await preview(t, { ask: async value => { prompt = value; return modelTurn(); } });
  const response = await post(); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.session.phase, 'diagnostic'); assert.equal(body.session.messages.length, 1);
  assert.match(prompt, /# Socratic Tutor/); assert.match(logs.join('\n'), /started/); assert.match(logs.join('\n'), /completed \(diagnostic\)/);
});

test('the local preview continues to serve only allowlisted public files', async t => {
  const { url } = await preview(t);
  assert.equal((await fetch(url)).status, 200);
  for (const path of ['/.env', '/confidential/private.txt', '/AGENTS.md', '/MEMORY.md', '/scripts/tutor-server.mjs', '/scripts/codex-tutor.mjs', '/scripts/tutor-schema.json', '/status/status_slides.pdf']) assert.equal((await fetch(`${url}${path}`)).status, 404, path);
});

test('unexpected Host values are rejected before model execution', async t => {
  let calls = 0;
  const { url } = await preview(t, { ask: async () => { calls++; return modelTurn(); } });
  for (const path of ['/', '/api/tutor/status', '/api/tutor']) {
    const code = await new Promise((resolve, reject) => { const req = rawRequest(`${url}${path}`, { headers: { host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); }); assert.equal(code, 403);
  }
  assert.equal(calls, 0);
});

test('cross-origin and missing-origin tutor submissions cannot spend model requests', async t => {
  let calls = 0; const { url, post } = await preview(t, { ask: async () => { calls++; return modelTurn(); } });
  assert.equal((await post(fresh, { headers: { origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(`${url}/api/tutor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fresh) })).status, 403);
  assert.equal(calls, 0);
});

test('form posts and non-JSON bodies are rejected', async t => {
  const { post } = await preview(t);
  assert.equal((await post('topic=Probability', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 403);
  const malformed = await post('{broken'); assert.equal(malformed.status, 400); assert.match((await malformed.json()).error, /valid JSON/);
});

test('wrong methods and unknown API routes return clear errors', async t => {
  const { url } = await preview(t);
  assert.equal((await fetch(`${url}/api/tutor`)).status, 405);
  assert.equal((await fetch(`${url}/api/unknown`)).status, 404);
  assert.equal((await fetch(`${url}/api/tutor`, { method: 'OPTIONS' })).status, 405);
});

test('invalid request schemas fail without calling the model', async t => {
  let calls = 0;
  const { post } = await preview(t, { ask: async () => { calls++; return modelTurn(); } });
  for (const body of [{}, [], { ...fresh, goal: '' }, { ...fresh, session: { version: 99 } }]) assert.equal((await post(body)).status, 400);
  assert.equal(calls, 0);
});

test('oversized tutor requests receive a bounded-body error', async t => {
  const { post } = await preview(t);
  const response = await post(JSON.stringify({ ...fresh, message: 'x'.repeat(810000) }));
  assert.equal(response.status, 413);
});

test('concurrent requests are rejected until the current tutor turn finishes', async t => {
  let release, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { post } = await preview(t, { ask: async () => { notify(); await pending; return modelTurn(); } });
  const first = post(); await started;
  const second = await post(); assert.equal(second.status, 409); assert.match((await second.json()).error, /another question/);
  release(); assert.equal((await first).status, 200);
  assert.equal((await post()).status, 200);
});

test('provider failure returns a recoverable error and releases the busy guard', async t => {
  let calls = 0;
  const { post } = await preview(t, { ask: async () => { if (++calls === 1) throw new Error('Connection unavailable; retry.'); return modelTurn(); } });
  const failure = await post(); assert.equal(failure.status, 502); assert.match((await failure.json()).error, /retry/);
  assert.equal((await post()).status, 200);
});

test('invalid model output does not publish a partial session', async t => {
  const { post } = await preview(t, { ask: async () => ({ reply: 'Bad incomplete response' }) });
  const response = await post(); assert.equal(response.status, 502);
  const body = await response.json(); assert.equal(body.session, undefined); assert.match(body.error, /preserved/);
});

test('status failures remain explicit rather than simulating a connected tutor', async t => {
  const { url } = await preview(t, { status: async () => { throw new Error('offline'); } });
  const response = await fetch(`${url}/api/tutor/status`); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.available, false); assert.match(body.message, /unavailable/);
});
