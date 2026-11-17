import { readFile } from 'node:fs/promises';
import { makeTutorPrompt as prompt } from '../server/tutor-core.js';
export { validateRequest, earnedLevel, applyTutorTurn, isCommand } from '../server/tutor-core.js';
export async function makeTutorPrompt(request) {
  const skill = await readFile(new URL('../.agents/skills/socratic-tutor/SKILL.md', import.meta.url), 'utf8');
  return prompt(request, skill);
}
