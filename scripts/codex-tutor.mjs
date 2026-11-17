import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const schemaPath = fileURLToPath(new URL('./tutor-schema.json', import.meta.url));
const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'skill_search', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'view_image', 'image_generation', 'code_mode', 'code_mode_host', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'tool_suggest', 'sleep_tool', 'memories'];

// No shell, no repository instructions, no user configuration or connected apps.
// Authentication stays with the installed CLI; this app never reads its secrets.
export function tutorArguments(workdir, output) {
  return ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--cd', workdir, '--color', 'never', '--json',
    '--output-schema', schemaPath, '--output-last-message', output,
    ...disabled.flatMap(name => ['--disable', name]), '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0',
    '-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false', '-c', 'tools.update_plan.enabled=false',
    '-c', 'tools.experimental_request_user_input.enabled=false', '-'];
}

export async function findCodex() {
  const paths = [process.env.TUTOR_CODEX_BIN, bundled,
    ...(process.env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'codex'))].filter(Boolean);
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try next installation. */ }
  }
  return null;
}

function environment() {
  const result = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'SYSTEMROOT']) {
    if (process.env[key]) result[key] = process.env[key];
  }
  return result;
}

export function runCli(binary, args, { input = '', signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lineBuffer = '', ended = false;
    const done = (error, value) => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { child.kill('SIGKILL'); done(new Error('The tutor request was cancelled.')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error('The tutor took too long to respond. Your answer is preserved; retry.')); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => done(new Error('The Codex CLI could not start. Check the local installation.')));
    const inspectLine = line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if ((event.item?.type && !['agent_message', 'reasoning', 'error'].includes(event.item.type)) || /tool_call/.test(event.type || '')) {
        child.kill('SIGKILL'); done(new Error(`The isolated tutor attempted an unsupported tool (${String(event.item?.type || event.type).replace(/[^a-z_]/gi, '').slice(0,60)}). Please retry.`));
      }
    };
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.length > 1_000_000) { child.kill('SIGKILL'); done(new Error('The tutor response exceeded the size limit.')); }
      // A tutor must never invoke a connected service or execute a command.
      lineBuffer += data;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) inspectLine(line);
    });
    child.stderr.on('data', data => { if (stderr.length < 16_000) stderr += data; });
    child.on('close', code => {
      if (lineBuffer) inspectLine(lineBuffer);
      if (code !== 0) {
        const auth = /login|authentication|unauthorized|401|sign in/i.test(stderr + stdout);
        done(new Error(auth ? 'Codex needs a ChatGPT sign-in. Run the sign-in command in README, then retry.' : 'Codex could not complete this turn. Retry; check the local terminal if the problem continues.'));
      } else done(null, stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function codexStatus() {
  const binary = await findCodex();
  if (!binary) return { available: false, provider: 'codex', message: 'Install Codex and sign in with ChatGPT to start the local tutor. See README.' };
  try {
    await runCli(binary, ['login', 'status'], { timeout: 10_000 });
    return { available: true, provider: 'codex', message: 'Local tutor connected through your Codex sign-in. Messages are sent to OpenAI.' };
  } catch (error) { return { available: false, provider: 'codex', message: error.message }; }
}

export async function askCodex(prompt, { signal } = {}) {
  const binary = await findCodex();
  if (!binary) throw new Error('Codex is unavailable. See README for local setup.');
  const workdir = await mkdtemp(join(tmpdir(), 'thinking-tutor-'));
  const output = join(workdir, 'response.json');
  try {
    await runCli(binary, tutorArguments(workdir, output), { input: prompt, signal });
    const text = await readFile(output, 'utf8');
    if (text.length > 100_000) throw new Error('The tutor response was too large. Please retry.');
    try { return JSON.parse(text); } catch { throw new Error('The tutor returned an unreadable response. Your session is preserved; retry.'); }
  } finally { await rm(workdir, { recursive: true, force: true }); }
}
