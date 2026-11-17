import { defineConfig, bindings } from 'cf/config';
import { WORKER_CONFIG, WORKER_DOMAINS } from './scripts/public-assets.mjs';

// scripts/build-worker.mjs creates the explicit server + assets Build Output.
// OPENAI_API_KEY is configured only as a Worker secret, never in source.
export default defineConfig({ worker: {
  ...WORKER_CONFIG, compatibilityDate: '2026-11-17', entrypoint: './server/worker.mjs',
  domains: [...WORKER_DOMAINS], assets: { ...WORKER_CONFIG.assets, runWorkerFirst: true },
  env: {
    ASSETS: bindings.assets(), OPENAI_MODEL: bindings.text('gpt-5-mini'),
    TUTOR_ENABLED: bindings.text('true'),
    TUTOR_RATE: bindings.rateLimit({ namespace: '1001', simple: { limit: 6, period: 60 } }),
    SITE_RATE: bindings.rateLimit({ namespace: '1002', simple: { limit: 30, period: 60 } }),
  },
  observability: { enabled: true, traces: { enabled: true, headSamplingRate: 0.1 } },
} });
