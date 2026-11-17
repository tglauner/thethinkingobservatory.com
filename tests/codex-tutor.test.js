import test from 'node:test';
import assert from 'node:assert/strict';
import { tutorArguments, runCli } from '../scripts/codex-tutor.mjs';

const node = (script, options) => runCli(process.execPath, ['-e', script], { timeout: 3000, ...options });

test('local model invocation isolates configuration, instructions and executable tools', () => {
  const args = tutorArguments('/tmp/tutor-test', '/tmp/tutor-test/response.json');
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--output-schema']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--cd') + 1], '/tmp/tutor-test');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'computer_use', 'browser_use', 'view_image', 'image_generation', 'skill_search']) assert.ok(args.some((arg, i) => arg === '--disable' && args[i + 1] === feature), feature);
  for (const setting of ['approval_policy="never"', 'project_doc_max_bytes=0', 'web_search="disabled"', 'skills.include_instructions=false']) assert.ok(args.includes(setting), setting);
  assert.equal(args.at(-1), '-');
});

test('learner input reaches the child as literal stdin without shell interpretation', async () => {
  const input = 'reasoning with $(printf injected) and `printf injected`\nline two';
  const output = await node("process.stdin.setEncoding('utf8'); process.stdin.on('data', x => process.stdout.write(x));", { input });
  assert.equal(output, input);
});

test('the adapter does not forward unrelated parent environment variables', async () => {
  process.env.THINKING_TUTOR_TEST_PRIVATE = 'test-only-value';
  try {
    const output = await node("process.stdout.write(String(process.env.THINKING_TUTOR_TEST_PRIVATE))");
    assert.equal(output, 'undefined');
  } finally { delete process.env.THINKING_TUTOR_TEST_PRIVATE; }
});

test('model message and reasoning events are accepted', async () => {
  const output = await node("console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'A question?'}})); console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'reason'}}));");
  assert.match(output, /A question/);
});

test('unsupported tool events are rejected even when JSONL is split across chunks', async () => {
  await assert.rejects(node("process.stdout.write('{\"type\":\"item.started\",\"item\":{\"type\":\"command_'); setTimeout(() => process.stdout.write('execution\"}}\\n'), 30); setTimeout(() => {}, 2000);"), /unsupported tool/);
});

test('unsupported final tool events are rejected without a trailing newline', async () => {
  await assert.rejects(node("process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call'}}))"), /unsupported tool/);
});

test('future unknown tool-item types fail closed', async () => {
  await assert.rejects(node("console.log(JSON.stringify({type:'item.started',item:{type:'future_file_reader'}}))"), /unsupported tool/);
});

test('stdout size limits terminate an oversized model response', async () => {
  await assert.rejects(node("process.stdout.write('x'.repeat(1000100)); setTimeout(() => {}, 2000);"), /size limit/);
});

test('model timeout is recoverable and kills the owned child', async () => {
  await assert.rejects(node("setTimeout(() => {}, 5000)", { timeout: 30 }), /too long/);
});

test('aborting a tutor request terminates its child', async () => {
  const controller = new AbortController();
  const task = node("setTimeout(() => {}, 5000)", { signal: controller.signal });
  controller.abort(); await assert.rejects(task, /cancelled/);
});

test('missing local executable produces a clear installation error', async () => {
  await assert.rejects(runCli('/missing-test-codex-executable', [], { timeout: 1000 }), /could not start/);
});

test('authentication failures are sanitized into a sign-in instruction', async () => {
  await assert.rejects(node("process.stderr.write('401 unauthorized test-only diagnostic'); process.exitCode=1;"), error => /sign-in/.test(error.message) && !error.message.includes('test-only diagnostic'));
});

test('other CLI errors do not leak raw process output into the website', async () => {
  await assert.rejects(node("process.stderr.write('test-only private diagnostic'); process.exitCode=1;"), error => /could not complete/.test(error.message) && !error.message.includes('private diagnostic'));
});
