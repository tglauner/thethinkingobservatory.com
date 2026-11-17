import { WORKER_CONFIG, WORKER_DOMAINS } from './public-assets.mjs';

// Non-secret deployment settings. Change TUTOR_ENABLED to 'false' to pause usage.
export const TUTOR_WORKER_CONFIG = {
  ...WORKER_CONFIG, compatibilityDate: '2026-11-17', domains: [...WORKER_DOMAINS],
  assets: { ...WORKER_CONFIG.assets, runWorkerFirst: true },
  env: {
    ASSETS: { type: 'assets' }, OPENAI_MODEL: { type: 'text', value: 'gpt-5-mini' },
    TUTOR_ENABLED: { type: 'text', value: 'true' },
    TUTOR_RATE: { type: 'rate-limit', namespace: '1001', simple: { limit: 6, period: 60 } },
    SITE_RATE: { type: 'rate-limit', namespace: '1002', simple: { limit: 30, period: 60 } },
  },
  observability: { enabled: true, traces: { enabled: true, headSamplingRate: 0.1 } },
};
