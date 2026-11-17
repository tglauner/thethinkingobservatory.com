import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSite } from './build.mjs';
import { TUTOR_WORKER_CONFIG } from './worker-settings.mjs';

export async function buildWorker(root = process.cwd()) {
  await buildSite(root);
  const output = join(root, '.cloudflare/output/v0/workers/default');
  const files = ['server/worker.mjs', 'server/tutor-core.js', 'src/tutor-state.js', 'src/curriculum.js'];
  const modules = { 'entrypoint.mjs': { type: 'esm' } };
  for (const path of files) {
    await mkdir(join(output, 'bundle', path, '..'), { recursive: true });
    await writeFile(join(output, 'bundle', path), await readFile(join(root, path)));
    modules[path] = { type: 'esm' };
  }
  const skill = await readFile(join(root, '.agents/skills/socratic-tutor/SKILL.md'), 'utf8');
  const schema = JSON.parse(await readFile(join(root, 'scripts/tutor-schema.json'), 'utf8'));
  await writeFile(join(output, 'bundle/entrypoint.mjs'), `import { createWorker } from './server/worker.mjs';\nexport default createWorker(${JSON.stringify({ skill, schema })});\n`);
  const config = { ...TUTOR_WORKER_CONFIG,
    manifest: { type: 'complete', mainModule: 'entrypoint.mjs', modules },
  };
  await writeFile(join(output, 'worker.config.json'), JSON.stringify(config, null, 2) + '\n');
  console.log('[worker build] Server modules and runtime skill assembled separately from public dist/.');
}
if (process.argv[1]?.endsWith('/build-worker.mjs')) await buildWorker();
