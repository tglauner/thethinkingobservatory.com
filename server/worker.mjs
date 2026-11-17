import { validateRequest, makeTutorPrompt, applyTutorTurn } from './tutor-core.js';

const CANONICAL = 'thethinkingobservatory.com';
const ALIASES = new Set(['thinkingobservatory.com', 'www.thinkingobservatory.com', 'www.thethinkingobservatory.com']);
const MAX_BODY = 80_000;
const MAX_PROMPT = 100_000;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
} });

export async function boundedText(body, limit) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('size-limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function createWorker({ skill, schema, fetchModel = fetch, logger = console }) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    if (ALIASES.has(url.hostname)) {
      url.hostname = CANONICAL; url.protocol = 'https:'; url.port = '';
      return new Response(null, { status: 308, headers: { Location: url.href, 'Cache-Control': 'public, max-age=3600' } });
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const enabled = env.TUTOR_ENABLED === 'true' && Boolean(env.OPENAI_API_KEY);
    if (url.pathname === '/api/tutor/status' && request.method === 'GET') return json(200, {
      available: enabled, provider: 'openai', model: env.OPENAI_MODEL || 'gpt-5-mini',
      message: enabled ? 'Tutor connected. Messages are sent to OpenAI; the site owner pays for responses.' : 'Paid tutoring is currently paused. Explore the fixed exercises at thequantobservatory.com.',
    });
    if (url.pathname !== '/api/tutor') return json(404, { error: 'Unknown tutor endpoint.' });
    if (request.method !== 'POST') return json(405, { error: 'Use POST for a tutor turn.' });
    if (request.headers.get('Origin') !== url.origin || !/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return json(403, { error: 'Send tutor messages from this website.' });
    if (!enabled) return json(503, { error: 'Paid tutoring is paused. Your saved session is preserved. Try the fixed exercises at thequantobservatory.com.' });
    // Fail closed if deployment is missing either spending/abuse limiter.
    if (!env.TUTOR_RATE || !env.SITE_RATE) return json(503, { error: 'The tutor is temporarily unavailable.' });
    let input;
    try {
      if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new Error('size-limit');
      input = validateRequest(JSON.parse(await boundedText(request.body, MAX_BODY)));
    } catch (error) {
      return json(error.message === 'size-limit' ? 413 : 400, { error: error.message === 'size-limit' ? 'This conversation is too large. Export it and start a focused new session.' : 'Send a valid topic, goal and tutor session.' });
    }
    const prompt = makeTutorPrompt(input, skill);
    if (prompt.length > MAX_PROMPT) return json(413, { error: 'This conversation has reached its context limit. Export it, then start a new focused session.' });
    try {
      const client = await env.TUTOR_RATE.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!client.success) return json(429, { error: 'Please wait a minute before sending another answer.' });
      const site = await env.SITE_RATE.limit({ key: 'paid-tutor' });
      if (!site.success) return json(429, { error: 'The tutor is busy. Please try again in a minute.' });
    } catch { return json(503, { error: 'The tutor rate limiter is unavailable. Please try again later.' }); }
    const requestId = crypto.randomUUID().slice(0, 8);
    try {
      logger.info(JSON.stringify({ requestId, event: 'tutor-started' }));
      const upstream = await fetchModel('https://api.openai.com/v1/responses', {
        method: 'POST', signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-5-mini', store: false,
          instructions: prompt, input: 'Continue the tutoring session using the required JSON response schema.',
          reasoning: { effort: 'low' }, max_output_tokens: 3000,
          text: { format: { type: 'json_schema', name: 'tutor_turn', strict: true, schema } },
        }),
      });
      if (!upstream.ok) {
        // Never forward provider errors, request bodies, or credentials to clients/logs.
        await upstream.body?.cancel();
        logger.error(JSON.stringify({ requestId, event: 'provider-error', status: upstream.status }));
        return json(upstream.status === 429 ? 429 : 502, { error: upstream.status === 429 ? 'OpenAI usage is temporarily limited. Please try again later.' : 'The model provider could not answer. Your session is preserved; please retry.' });
      }
      const result = JSON.parse(await boundedText(upstream.body, 120_000));
      if (result.status !== 'completed') throw new Error('incomplete');
      const text = (result.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
      const session = applyTutorTurn(input, JSON.parse(text));
      logger.info(JSON.stringify({ requestId, event: 'tutor-completed', phase: session.phase, usage: result.usage ? { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens } : undefined }));
      return json(200, { session });
    } catch {
      logger.error(JSON.stringify({ requestId, event: 'tutor-failed' }));
      return json(502, { error: 'The tutor could not complete this turn. Your session is preserved; please retry.' });
    }
  } };
}
