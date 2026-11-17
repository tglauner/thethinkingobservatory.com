import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPublicServer } from './serve.mjs';
import { askCodex, codexStatus } from './codex-tutor.mjs';
import { validateRequest, makeTutorPrompt, applyTutorTurn } from './tutor-session.mjs';

const MAX_BODY = 800_000;

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('This session is too large. Export it and start a focused new session.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}

export function createTutorServer(root = process.cwd(), { ask = askCodex, status = codexStatus, logger = console } = {}) {
  const assets = createPublicServer(root);
  let busy = false;
  const server = createServer(async (request, response) => {
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const reply = (code, body) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
      response.end(JSON.stringify(body));
    };
    if (!hosts.has(request.headers.host)) { reply(403, { error: 'Local preview accepts loopback hosts only.' }); return; }
    const path = request.url?.split('?')[0];
    if (!path?.startsWith('/api/')) { assets.emit('request', request, response); return; }
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { reply(403, { error: 'Tutor requests must come from this local page.' }); return; }
    if (path === '/api/tutor/status' && request.method === 'GET') {
      try { reply(200, await status()); } catch { reply(503, { available: false, provider: 'codex', message: 'The local tutor connection is unavailable.' }); }
      return;
    }
    if (path !== '/api/tutor') { reply(404, { error: 'Unknown tutor endpoint.' }); return; }
    if (request.method !== 'POST') { reply(405, { error: 'Use POST for a tutor turn.' }); return; }
    if (request.headers.origin !== `http://${request.headers.host}` || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) { reply(403, { error: 'Use the local website to send tutor messages.' }); return; }
    if (busy) { reply(409, { error: 'The tutor is answering another question. Wait a moment, then retry.' }); return; }
    busy = true;
    const requestId = randomUUID().slice(0, 8);
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      let input;
      try { input = validateRequest(await readBody(request)); }
      catch (error) { reply(error.status || 400, { error: error.message }); return; }
      logger.info(`[tutor ${requestId}] started`);
      const prompt = await makeTutorPrompt(input);
      const result = await ask(prompt, { signal: controller.signal });
      const session = applyTutorTurn(input, result);
      reply(200, { session });
      logger.info(`[tutor ${requestId}] completed (${session.phase})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The tutor could not complete this turn. Please retry.';
      logger.error(`[tutor ${requestId}] failed: ${message}`);
      reply(502, { error: message });
    } finally { busy = false; }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createTutorServer();
  server.on('error', error => {
    console.error(`[tutor preview] ${error.code === 'EADDRINUSE' ? 'Port 5173 is in use. Stop the earlier preview and run npm run dev again.' : error.message}`);
    process.exitCode = 1;
  });
  server.listen(5173, '127.0.0.1', () => console.log('[tutor preview] http://127.0.0.1:5173/ — local conversational tutor. Control-C stops the server.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
