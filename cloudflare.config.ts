import { defineConfig } from 'cf/config';
import { TUTOR_WORKER_CONFIG } from './scripts/worker-settings.mjs';

// npm run build:production assembles this explicit server entrypoint and assets.
// OPENAI_API_KEY belongs only in the Cloudflare Worker secret store.
export default defineConfig({ worker: {
  ...TUTOR_WORKER_CONFIG,
  entrypoint: './.cloudflare/output/v0/workers/default/bundle/entrypoint.mjs',
} });
