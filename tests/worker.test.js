import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorker, boundedText } from '../server/worker.mjs';
import { buildWorker } from '../scripts/build-worker.mjs';
import { readBuildOutput } from '@cloudflare/build-output-utils';

const schema = JSON.parse(await readFile(new URL('../scripts/tutor-schema.json', import.meta.url)));
const skill = await readFile(new URL('../.agents/skills/socratic-tutor/SKILL.md', import.meta.url), 'utf8');
const origin = 'https://thethinkingobservatory.com';
const input = { session: null, topic: 'Probability', goal: 'Learn fundamentals', message: '' };
const lesson = { reply: 'Let us begin with a diagnostic. What is the probability of heads on a fair coin?', phase: 'diagnostic', focus: 'coins', skills: [{ id: 'coins', name: 'Coins', level: 0, evidence: null }], notes: [] };
const env = () => ({ TUTOR_ENABLED: 'true', OPENAI_API_KEY: 'test-only-secret', ASSETS: { fetch: () => new Response('asset') }, TUTOR_RATE: { limit: async () => ({ success: true }) }, SITE_RATE: { limit: async () => ({ success: true }) } });
const req = (body = input, headers = {}) => new Request(origin + '/api/tutor', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const upstream = (result = lesson) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 100, output_tokens: 50 } });
const worker = (fetchModel = async () => upstream(), logger = { info() {}, error() {} }) => createWorker({ skill, schema, fetchModel, logger });

test('legacy and www domains redirect to canonical preserving path and query', async () => {
 for (const host of ['thinkingobservatory.com', 'www.thinkingobservatory.com', 'www.thethinkingobservatory.com']) {
 const r = await worker().fetch(new Request(`https://${host}/study?x=1`), env()); assert.equal(r.status, 308); assert.equal(r.headers.get('location'), origin + '/study?x=1'); }
});
test('static assets use the isolated assets binding', async () => assert.equal(await (await worker().fetch(new Request(origin), env())).text(), 'asset'));
test('status is unavailable without API key', async () => { const e = env(); delete e.OPENAI_API_KEY; const r = await worker().fetch(new Request(origin + '/api/tutor/status'), e); assert.equal((await r.json()).available, false); });
test('status identifies model without revealing secret', async () => { const r = await worker().fetch(new Request(origin + '/api/tutor/status'), env()); const s = await r.text(); assert.match(s, /gpt-5-mini/); assert.ok(!s.includes('test-only-secret')); });
test('explicit kill switch prevents model calls', async () => { let calls = 0; const e = env(); e.TUTOR_ENABLED = 'false'; assert.equal((await worker(async () => { calls++; }).fetch(req(), e)).status, 503); assert.equal(calls, 0); });
test('unknown API route returns 404', async () => assert.equal((await worker().fetch(new Request(origin + '/api/other'), env())).status, 404));
test('wrong method returns 405', async () => assert.equal((await worker().fetch(new Request(origin + '/api/tutor'), env())).status, 405));
test('cross-origin requests are rejected', async () => assert.equal((await worker().fetch(req(input, { Origin: 'https://evil.example' }), env())).status, 403));
test('missing origin is rejected', async () => { const r = req(); r.headers.delete('Origin'); assert.equal((await worker().fetch(r, env())).status, 403); });
test('wrong content type is rejected', async () => assert.equal((await worker().fetch(req(input, { 'Content-Type': 'text/plain' }), env())).status, 403));
test('missing limiter fails closed', async () => { const e = env(); delete e.SITE_RATE; assert.equal((await worker().fetch(req(), e)).status, 503); });
test('invalid request is rejected before paid inference', async () => assert.equal((await worker().fetch(req({}), env())).status, 400));
test('oversize body returns 413', async () => assert.equal((await worker().fetch(req({ extra: 'x'.repeat(80001) }), env())).status, 413));
test('stream reader bounds bodies without content length', async () => { const r = new Response('x'.repeat(100)); await assert.rejects(boundedText(r.body, 20), /size-limit/); });
test('IP rate limit prevents model calls', async () => { const e = env(); e.TUTOR_RATE.limit = async () => ({ success: false }); assert.equal((await worker().fetch(req(), e)).status, 429); });
test('site rate limit prevents model calls', async () => { const e = env(); e.SITE_RATE.limit = async () => ({ success: false }); assert.equal((await worker().fetch(req(), e)).status, 429); });
test('limiter failure fails closed', async () => { const e = env(); e.SITE_RATE.limit = async () => { throw Error('down'); }; assert.equal((await worker().fetch(req(), e)).status, 503); });
test('valid model response becomes validated browser session', async () => { const r = await worker().fetch(req(), env()); assert.equal(r.status, 200); const { session } = await r.json(); assert.equal(session.phase, 'diagnostic'); assert.equal(session.messages.length, 1); assert.equal(r.headers.get('cache-control'), 'no-store'); });
test('request uses bounded output, low reasoning, no storage, skill and schema', async () => { const w = worker(async (url, options) => { assert.equal(url, 'https://api.openai.com/v1/responses'); const body = JSON.parse(options.body); assert.equal(body.model, 'gpt-5-mini'); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 3000); assert.equal(body.reasoning.effort, 'low'); assert.ok(body.instructions.includes(skill)); assert.deepEqual(body.text.format.schema, schema); assert.equal(body.text.format.strict, true); return upstream(); }); assert.equal((await w.fetch(req(), env())).status, 200); });
test('provider errors do not expose response content or secret', async () => { const r = await worker(async () => new Response('test-only-secret internal', { status: 401 })).fetch(req(), env()); assert.equal(r.status, 502); assert.ok(!(await r.text()).includes('test-only-secret')); });
test('provider rate limit maps to useful 429', async () => assert.equal((await worker(async () => new Response('', { status: 429 })).fetch(req(), env())).status, 429));
test('incomplete model output is never applied', async () => assert.equal((await worker(async () => Response.json({ status: 'incomplete' })).fetch(req(), env())).status, 502));
test('invalid teaching response is never applied', async () => assert.equal((await worker(async () => upstream({ ...lesson, reply: 'Two? Questions?' })).fetch(req(), env())).status, 502));
test('network failure preserves session and returns retryable error', async () => assert.equal((await worker(async () => { throw Error('network'); }).fetch(req(), env())).status, 502));
test('production build has server-only skill, domains, limits and no secret value', async () => { await buildWorker(); const result = await readBuildOutput(process.cwd()); const w = result.workers.default; assert.ok(w.bundleDir); assert.equal(w.config.assets.runWorkerFirst, true); assert.ok(w.config.domains.includes('thethinkingobservatory.com')); assert.equal(w.config.env.TUTOR_RATE.simple.limit, 6); assert.ok(!JSON.stringify(w.config).includes('test-only-secret')); });

test('failure diagnostics contain safe stage and reason, never thrown content', async () => {
 const logs = []; const w = worker(async () => { throw Error('test-only-secret private provider detail'); }, { info() {}, error(line) { logs.push(JSON.parse(line)); } });
 assert.equal((await w.fetch(req(), env())).status, 502);
 assert.equal(logs.at(-1).stage, 'provider-request');
 assert.equal(logs.at(-1).reason, 'invalid-or-unavailable');
 assert.ok(!JSON.stringify(logs).includes('test-only-secret'));
});
test('question-policy rejection is distinguishable without logging the reply', async () => {
 const logs = []; const w = worker(async () => upstream({ ...lesson, reply: 'First? Second?' }), { info() {}, error(line) { logs.push(JSON.parse(line)); } });
 assert.equal((await w.fetch(req(), env())).status, 502);
 assert.equal(logs.at(-1).stage, 'session-validation');
 assert.equal(logs.at(-1).reason, 'question-policy');
 assert.ok(!JSON.stringify(logs).includes('First?'));
});
test('provider requests never follow redirects with API credentials', async () => {
 const w = worker(async (url, options) => { assert.equal(options.redirect, 'manual'); return upstream(); });
 assert.equal((await w.fetch(req(), env())).status, 200);
});

test('production preserves the existing credential binding without embedding a value', async () => {
 const { TUTOR_WORKER_CONFIG } = await import('../scripts/worker-settings.mjs');
 assert.deepEqual(TUTOR_WORKER_CONFIG.env.OPENAI_API_KEY, { type: 'unsafe:inherit' });
});
test('opening instructions request an actual diagnostic problem instead of readiness', async () => {
 const { makeTutorPrompt } = await import('../server/tutor-core.js');
 assert.match(makeTutorPrompt(input, skill), /topic-specific diagnostic problem immediately/);
});
