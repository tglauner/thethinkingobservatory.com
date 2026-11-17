/** Portable learner-owned conversation state. No secrets or provider credentials. */
export const SESSION_STORAGE_KEY = 'thinking-observatory:tutor:v2';
export const SESSION_VERSION = 2;
export const MAX_IMPORT_BYTES = 2_000_000;
export const MAX_SESSION_BYTES = 750_000;
const nonAnswerCommands = new Set(['easier', 'harder', 'just tell me', 'show progress', 'save state']);
const phases = new Set(['diagnostic', 'learning', 'review', 'assessment', 'complete']);
const kinds = new Set(['independent', 'recall', 'edge', 'explanation', 'assisted']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max, allowEmpty = false) => typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
const id = value => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
function requireValue(condition, message) { if (!condition) throw new Error(message); }

export function validateSession(value) {
  requireValue(record(value) && value.version === SESSION_VERSION, 'Choose a version 2 tutor session exported by this site.');
  requireValue(id(value.id), 'The session ID is invalid.');
  requireValue(text(value.topic, 240) && text(value.goal, 800), 'The topic or learning goal is invalid.');
  requireValue(integer(value.createdAt) && integer(value.updatedAt) && value.updatedAt >= value.createdAt, 'The session dates are invalid.');
  requireValue(phases.has(value.phase) && integer(value.diagnosticCount, 0, 5), 'The learning phase is invalid.');
  requireValue(Array.isArray(value.skills) && value.skills.length >= 1 && value.skills.length <= 10, 'A session needs between one and ten subskills.');
  const seen = new Set();
  const skills = value.skills.map(skill => {
    requireValue(record(skill) && id(skill.id) && !seen.has(skill.id), 'Subskill IDs must be valid and unique.');
    seen.add(skill.id);
    requireValue(text(skill.name, 160) && integer(skill.level, 0, 5), 'A subskill name or level is invalid.');
    requireValue(Array.isArray(skill.evidence) && skill.evidence.length <= 100, 'A subskill has invalid evidence.');
    const evidence = skill.evidence.map(item => {
      requireValue(record(item) && integer(item.turn, 0, 400) && (item.turn > 0 || item.kind === 'assisted') && kinds.has(item.kind) && typeof item.correct === 'boolean' && text(item.note, 1000, true), 'A learning evidence entry is invalid.');
      return { turn: item.turn, kind: item.kind, correct: item.correct, note: item.note };
    });
    return { id: skill.id, name: skill.name, level: skill.level, evidence };
  });
  requireValue(value.focus === null || seen.has(value.focus), 'The current focus is not part of this skill map.');
  requireValue(Array.isArray(value.messages) && value.messages.length >= 1 && value.messages.length <= 400, 'The conversation is missing or too long.');
  const messages = value.messages.map((message, index) => {
    requireValue(record(message) && ['tutor', 'learner'].includes(message.role) && text(message.text, 12000) && integer(message.at), 'A conversation message is invalid.');
    requireValue(message.role === (index % 2 === 0 ? 'tutor' : 'learner'), 'Conversation messages must alternate, beginning with the tutor.');
    return { role: message.role, text: message.text, at: message.at };
  });
  requireValue(messages.at(-1).role === 'tutor', 'A saved session must end with the tutor’s next question or feedback.');
  const answerCount = messages.filter(message => {
    const normalized = message.text.trim().toLowerCase();
    return message.role === 'learner' && !nonAnswerCommands.has(normalized) && !normalized.startsWith('focus:');
  }).length;
  requireValue(skills.every(skill => skill.evidence.every(item => item.turn <= answerCount)), 'Learning evidence cannot refer to an answer that is not in the conversation.');
  requireValue(Array.isArray(value.notes) && value.notes.length <= 40 && value.notes.every(note => text(note, 2000, true)), 'The session notes are invalid.');
  const canonical = {
    version: SESSION_VERSION, id: value.id, topic: value.topic, goal: value.goal,
    createdAt: value.createdAt, updatedAt: value.updatedAt, phase: value.phase,
    diagnosticCount: value.diagnosticCount, focus: value.focus, skills, messages,
    notes: [...value.notes],
  };
  requireValue(new TextEncoder().encode(JSON.stringify(canonical)).length <= MAX_SESSION_BYTES, 'This conversation is too large to continue. Export it and start a new topic.');
  return canonical;
}

export function parseSessionImport(raw) {
  requireValue(typeof raw === 'string' && new TextEncoder().encode(raw).length <= MAX_IMPORT_BYTES, 'Choose a tutor session file smaller than 2 MB.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('This file is not valid JSON.'); }
  return validateSession(value);
}

export function loadSession(storage) {
  try {
    const raw = storage?.getItem(SESSION_STORAGE_KEY);
    return { session: raw ? parseSessionImport(raw) : null, error: null };
  } catch (error) {
    return { session: null, error: error.message || 'Browser storage is unavailable.' };
  }
}

export function saveSession(storage, session) {
  try {
    if (!storage) return false;
    if (session === null) storage.removeItem(SESSION_STORAGE_KEY);
    else storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(validateSession(session)));
    return true;
  } catch { return false; }
}

export function exportSession(session) {
  const canonical = validateSession(session);
  const pretty = JSON.stringify(canonical, null, 2);
  return new TextEncoder().encode(pretty).length <= MAX_IMPORT_BYTES ? pretty : JSON.stringify(canonical);
}
