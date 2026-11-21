# The Thinking Observatory

An independent conversational Socratic tutor for probability, decision making, markets, quantitative research and programming. Teaching follows [Jane Street’s Socratic Tutor skill](https://github.com/janestreet/agent_skills/blob/7c6715c29548a3b39d4a9545c698ee4fd17a7213/socratic-tutor/SKILL.md), with its [MIT notice](public/licenses/jane-street-socratic-tutor.txt). No affiliation or endorsement is implied. The application and original curriculum are not licensed by that notice.

Primary address: https://thethinkingobservatory.com/. https://thinkingobservatory.com/ and both www forms redirect to it, preserving paths and query strings. The fixed exercises and quiz companion lives at https://thequantobservatory.com/. Courses and further learning: https://tglauner.com/#courses.

The hosted tutor uses the OpenAI Responses API, default `gpt-5-mini`, low reasoning effort, structured replies, no model tools and `store: false`. The licensed skill is supplied on every turn. Written reasoning receives fallible AI feedback, one question at a time. Evidence rules validate skill maps and gate progress. Conversations are saved in the learner’s browser with export/import; there is no shared learner database. Topic, goal and conversation are sent to OpenAI, and the site owner pays for responses. Do not submit secrets or sensitive information.

## Run and verify

```bash
npm ci
npm run check
npm run dev
```

The local preview at http://127.0.0.1:5173 retains the isolated Codex ChatGPT sign-in bridge for owner testing. It is not the production API and never exposes that account to visitors. Stop it with Control-C. `npm run preview:static` serves browser files without a tutor connection.

## Deploy to Cloudflare

```bash
npm run deploy
```

This runs checks, builds the explicit browser allowlist plus separate server modules, and deploys Build Output using the pinned `cf` CLI. Authenticate with `npx cf auth login` if necessary. Cloudflare Worker: `jane-street-learning` (the existing identity is retained). Custom domains are declared in the source and production artifact.

Set `OPENAI_API_KEY` as a **Secret** in this Worker’s Cloudflare dashboard → Settings → Variables and Secrets. Never enter it in chat, browser code, GitHub or a public environment variable. Deployments inherit the existing key binding by name without reading its value. Set it before deploying a fresh Worker. Existing code does not read credential files. Without this secret the site loads and clearly reports tutoring paused; no paid request is made. Adding the secret activates tutoring while `TUTOR_ENABLED=true`.

The environment settings are `OPENAI_MODEL=gpt-5-mini` and `TUTOR_ENABLED=true`. Set `TUTOR_ENABLED=false` in the dashboard to pause paid requests immediately. To persist that choice across future source deployments, change it in `scripts/worker-settings.mjs`, then deploy. Model changes should be verified for low-effort reasoning and structured-output compatibility before deployment.

Request bounds: 80 KB body, 100,000 prompt characters and 3,000 output tokens; 60-second timeout; six requests per minute per IP and 30 per minute per Cloudflare location for the shared site limiter. Cloudflare rate limits are best-effort and location-scoped, **not a hard dollar or daily spending cap**. Long sessions must be exported and restarted. Logs contain request IDs, phase, provider HTTP status and token counts, never prompts or keys. Review actual usage in OpenAI and Cloudflare dashboards. API cancellation or a network retry can still incur provider usage; there is no automatic retry.

Only allowlisted browser assets enter `dist/`. The deployment bundle contains server code, schema and skill; none is served as public static files. Private workspace material, credentials, operational notes and development artifacts are excluded from public source publication.

## Smoke checks and rollback

```bash
curl -I https://thinkingobservatory.com/
curl -I https://thethinkingobservatory.com/
curl https://thethinkingobservatory.com/api/tutor/status
```

Check a new diagnostic, written answer, narrower follow-up, reload persistence, export/import, narrow layout and course links. In the Cloudflare Worker’s Deployments page, restore the preceding successful version to roll back a release. Domains and secrets are separate configuration: check them after rollback. Preserve the fixed quiz companion independently.

## Session progress and backups

Export downloads the conversation, skill map and notes as a private JSON backup; import restores it in another browser or after clearing local data. Response speed is not scored. Timestamps remain in the local backup for bookkeeping, but are excluded from the model’s session context; the model is instructed to evaluate reasoning only.

A session starts with 3–5 diagnostic answers and then has no fixed lesson duration: it continues toward the selected goal and a mixed assessment, and can be paused at any time. The map shows recorded checks and independent successes separately from earned levels. The current evidence rule keeps a skill at0 until two independent successes include a later recall check; this can make early learning look stalled. Short study rounds and a clearer pedagogical stopping point remain a recommended product improvement, not an implemented session limit.

The active tutor reply is presented as a highlighted exploration card, with phase-based accents and a gentle arrival transition. Evidence dots represent up to six recorded observations, not earned levels or correctness. Effects are browser-only, respect reduced-motion preferences, and do not add model calls. Existing version2 session exports remain importable.

## A visible finish line

The learning map now counts named completion milestones, not accumulated attempts: starting diagnostic, each skill’s independent problem, delayed recall and tutor confirmation, then a final check for each skill and one combined problem. Level5 adds an edge case and teach-back. The map shows completed/total/remaining requirements and each unfinished box. Existing version2 sessions are read directly; no reset or reimport is required. Earned levels are preserved. A failed review can reopen a requirement. There is no promised exact number of questions: retries may be needed. The same computed checklist is included in tutor instructions, which direct it to address remaining gaps and stop after the final assessment.
