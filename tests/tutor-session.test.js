import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, earnedLevel, applyTutorTurn, makeTutorPrompt, isCommand } from '../scripts/tutor-session.mjs';

const evidence = (turn, kind = 'independent', correct = true) => ({ turn, kind, correct, note: 'Observed learner reasoning.' });
const result = (overrides = {}) => ({ reply: 'What follows from that assumption?', phase: 'learning', focus: 'events', skills: [{ id: 'events', name: 'Events', level: 4, evidence: null }], notes: [], ...overrides });
function session(overrides = {}) {
  return { version: 2, id: 'test-session', topic: 'Probability', goal: 'Independent problem solving (level 4)', createdAt: 1, updatedAt: 1, phase: 'learning', diagnosticCount: 3, focus: 'events', skills: [{ id: 'events', name: 'Events', level: 0, evidence: [] }], messages: messagesWithAnswers(overrides.diagnosticCount ?? 3), notes: [], ...overrides };
}
function request(state, message = 'My reasoning uses equally likely outcomes.') { return validateRequest({ session: state, message }); }
function turnEvidence(state, item, message) {
  return applyTutorTurn(request(state, message), result({ skills: [{ id: 'events', name: 'Events', level: 5, evidence: item }] }), 10);
}
function messagesWithAnswers(n) {
  return [{ role: 'tutor', text: 'Initial question?', at: 1 }, ...Array.from({ length: n }, (_, i) => [{ role: 'learner', text: `Independent answer ${i + 1}`, at: 1 }, { role: 'tutor', text: 'Next question?', at: 1 }]).flat()];
}

test('new tutor request requires a bounded topic, goal and message', () => {
  assert.equal(validateRequest({ session: null, topic: ' Probability ', goal: ' Level 4 ', message: '' }).topic, 'Probability');
  for (const body of [null, [], {}, { session: null, topic: '', goal: '4', message: '' }, { session: null, topic: 'x', goal: '4', message: 'x'.repeat(12001) }]) assert.throws(() => validateRequest(body));
});

test('continuing tutor request uses the saved topic and rejects blank answers', () => {
  assert.equal(validateRequest({ session: session(), topic: 'Injected replacement', goal: '5', message: ' Answer ' }).topic, 'Probability');
  assert.throws(() => request(session(), '  '));
});

test('invalid session and invalid tutor output leave existing progress untouched', () => {
  const state = session(); const snapshot = JSON.stringify(state);
  assert.throws(() => validateRequest({ session: { ...state, diagnosticCount: 99 }, message: 'Answer' }));
  assert.throws(() => applyTutorTurn(request(state), result({ skills: [] })));
  assert.equal(JSON.stringify(state), snapshot);
});

test('initial diagnostic earns no evidence or levels even when a model proposes them', () => {
  const start = validateRequest({ session: null, topic: 'Probability', goal: 'Level 4', message: '' });
  const next = applyTutorTurn(start, result({ phase: 'complete', skills: [{ id: 'events', name: 'Events', level: 5, evidence: { kind: 'independent', correct: true, note: 'Unsupported startup credit.' } }] }), 10);
  assert.equal(next.phase, 'diagnostic'); assert.equal(next.diagnosticCount, 0);
  assert.equal(next.skills[0].level, 0); assert.deepEqual(next.skills[0].evidence, []);
  assert.equal(next.messages.length, 1);
});

test('diagnostic cannot finish before three substantive learner answers', () => {
  let state = session({ phase: 'diagnostic', diagnosticCount: 0 });
  for (let count = 1; count <= 3; count++) {
    state = applyTutorTurn(request(state), result({ phase: 'learning' }), 10);
    assert.equal(state.diagnosticCount, count); assert.equal(state.phase, count < 3 ? 'diagnostic' : 'learning');
  }
});

test('diagnostic ends after at most five answers despite a model requesting more', () => {
  const next = applyTutorTurn(request(session({ phase: 'diagnostic', diagnosticCount: 4 })), result({ phase: 'diagnostic' }), 10);
  assert.equal(next.diagnosticCount, 5); assert.equal(next.phase, 'learning');
});

test('commands do not count as diagnostic answers or create model-proposed evidence', () => {
  for (const message of ['easier', 'HARDER', 'show progress', 'save state', 'focus:events']) {
    assert.ok(isCommand(message));
    const next = turnEvidence(session({ phase: 'diagnostic', diagnosticCount: 1 }), { kind: 'independent', correct: true, note: 'Should be ignored.' }, message);
    assert.equal(next.diagnosticCount, 1); assert.deepEqual(next.skills[0].evidence, []); assert.equal(next.skills[0].level, 0);
  }
});

test('direct explanation records assistance and preserves earned level', () => {
  const state = session({ skills: [{ id: 'events', name: 'Events', level: 4, evidence: [evidence(1), evidence(4, 'recall')] }], messages: messagesWithAnswers(4) });
  const next = turnEvidence(state, { kind: 'edge', correct: true, note: 'Commands cannot earn evidence.' }, 'just tell me');
  assert.equal(next.skills[0].level, 4); assert.equal(next.skills[0].evidence.at(-1).kind, 'assisted'); assert.equal(next.skills[0].evidence.at(-1).correct, false);
});

test('immediate retests following assistance cannot earn independent evidence', () => {
  const state = session({ skills: [{ id: 'events', name: 'Events', level: 0, evidence: [evidence(1, 'assisted')] }], messages: messagesWithAnswers(1) });
  const next = turnEvidence(state, { kind: 'independent', correct: true, note: 'Immediate retest.' });
  assert.equal(next.skills[0].evidence.at(-1).kind, 'assisted'); assert.equal(next.skills[0].level, 0);
});

test('premature recall is treated as assisted rather than independent proof', () => {
  const state = session({ skills: [{ id: 'events', name: 'Events', level: 0, evidence: [evidence(1)] }], messages: messagesWithAnswers(1) });
  const next = turnEvidence(state, { kind: 'recall', correct: true, note: 'Too soon.' });
  assert.equal(next.skills[0].evidence.at(-1).kind, 'assisted'); assert.equal(next.skills[0].level, 0);
});

test('earned levels require two distinct successful checks and delayed recall', () => {
  assert.equal(earnedLevel(4, [evidence(1)]), 0);
  assert.equal(earnedLevel(4, [evidence(1), evidence(4)]), 0);
  assert.equal(earnedLevel(4, [evidence(1), evidence(1, 'recall')]), 0);
  assert.equal(earnedLevel(4, [evidence(1), evidence(3, 'recall')]), 0);
  assert.equal(earnedLevel(4, [evidence(1), evidence(4, 'recall')]), 4);
});

test('level five requires an edge case plus a separate teach-back', () => {
  const base = [evidence(1), evidence(4, 'recall')];
  assert.equal(earnedLevel(5, base), 4);
  assert.equal(earnedLevel(5, [...base, evidence(5, 'edge')]), 4);
  assert.equal(earnedLevel(5, [...base, evidence(5, 'explanation')]), 4);
  assert.equal(earnedLevel(5, [...base, evidence(5, 'edge'), evidence(6, 'explanation')]), 5);
});

test('a failed review lowers demonstrated level and invalidates earlier successes for promotion', () => {
  const state = session({ phase: 'review', skills: [{ id: 'events', name: 'Events', level: 4, evidence: [evidence(1), evidence(4, 'recall')] }], messages: messagesWithAnswers(4) });
  const next = turnEvidence(state, { kind: 'recall', correct: false, note: 'Could not recall the denominator.' });
  assert.ok(next.skills[0].level < 4);
  assert.equal(earnedLevel(4, [...state.skills[0].evidence, evidence(5, 'recall', false), evidence(6)]), 0);
});

test('the model cannot rename, replace or remove established subskills', () => {
  for (const skills of [[{ id: 'other', name: 'Events', level: 0, evidence: null }], [{ id: 'events', name: 'Changed name', level: 0, evidence: null }], [{ id: 'events', name: 'Events', level: 0, evidence: null }, { id: 'events', name: 'Events', level: 0, evidence: null }]]) assert.throws(() => applyTutorTurn(request(session()), result({ skills })));
});

test('a teaching turn must end with a question and a valid focus', () => {
  assert.throws(() => applyTutorTurn(request(session()), result({ reply: 'Here is the final answer.' })), /question/);
  assert.throws(() => applyTutorTurn(request(session()), result({ focus: 'unknown' })), /unknown/);
});

test('assessment cannot begin before every skill meets the chosen target', () => {
  const next = applyTutorTurn(request(session()), result({ phase: 'assessment' }), 10);
  assert.equal(next.phase, 'learning');
});

test('completion is withheld without an independent integrative assessment pass', () => {
  const state = session({ phase: 'assessment', skills: [{ id: 'events', name: 'Events', level: 4, evidence: [evidence(1), evidence(4, 'recall'), evidence(5)] }], messages: [...messagesWithAnswers(4).slice(0, -1), { role: 'tutor', text: '[Mixed assessment]\nWhat is an event?', at: 1 }, { role: 'learner', text: 'A subset of the sample space.', at: 1 }, { role: 'tutor', text: 'Can you apply it?', at: 1 }] });
  const next = applyTutorTurn(request(state), result({ phase: 'complete', reply: 'Can you combine the ideas in a fresh case?' }), 10);
  assert.notEqual(next.phase, 'complete');
});

test('the model prompt includes the actual skill and separates learner input as data', async () => {
  const input = validateRequest({ session: null, topic: 'Probability', goal: 'Level 4', message: '' });
  const prompt = await makeTutorPrompt(input);
  assert.match(prompt, /# Socratic Tutor/); assert.match(prompt, /2\+ independent checks/);
  assert.match(prompt, /LEARNER INPUT:/); assert.match(prompt, /Never attempt any tool/);
  assert.match(prompt, /3-5 diagnostic questions/);
});


test('an independent integrative pass permits completion only after target and assessment coverage', () => {
  const state = session({ phase: 'assessment', skills: [{ id: 'events', name: 'Events', level: 4, evidence: [evidence(1), evidence(4, 'recall')] }], messages: [...messagesWithAnswers(4).slice(0, -1), { role: 'tutor', text: '[Mixed assessment]\n[Integrative problem]\nHow does this connect?', at: 1 }] });
  const next = applyTutorTurn(request(state), result({ phase: 'complete', reply: 'You passed this focused assessment.', skills: [{ id: 'events', name: 'Events', level: 4, evidence: { kind: 'independent', correct: true, note: 'Connected the assessed concepts independently.' } }] }), 10);
  assert.equal(next.phase, 'complete');
});

test('a failed check makes its immediate follow-up assisted even if the model overstates independence', () => {
  const state = session({ skills: [{ id: 'events', name: 'Events', level: 0, evidence: [evidence(1, 'independent', false)] }], messages: messagesWithAnswers(1) });
  const next = turnEvidence(state, { kind: 'independent', correct: true, note: 'Answer after narrowing prompt.' });
  assert.equal(next.skills[0].evidence.at(-1).kind, 'assisted');
});

test('integrative work cannot complete a course while an assessed subskill lacks coverage', () => {
  const skills = ['events', 'conditioning', 'expectation'].map(id => ({ id, name: id, level: 4, evidence: [evidence(1), evidence(4, 'recall')] }));
  const state = session({ phase: 'assessment', skills, messages: [...messagesWithAnswers(4).slice(0, -1), { role: 'tutor', text: '[Mixed assessment]\n[Integrative problem]\nHow do these ideas combine?', at: 1 }] });
  const output = result({ phase: 'complete', reply: 'Can you now apply the untested idea?', skills: skills.map((skill, index) => ({ id: skill.id, name: skill.name, level: 4, evidence: index < 2 ? { kind: 'independent', correct: true, note: 'Independent integrative reasoning.' } : null })) });
  const next = applyTutorTurn(request(state), output, 10);
  assert.equal(next.phase, 'assessment');
});

test('full-mastery sessions cannot enter final assessment at level four', () => {
  const state = session({ goal: 'Full mastery (level 5)', skills: [{ id: 'events', name: 'Events', level: 4, evidence: [evidence(1), evidence(4, 'recall')] }], messages: messagesWithAnswers(4) });
  const next = applyTutorTurn(request(state), result({ phase: 'assessment' }), 10);
  assert.equal(next.phase, 'learning');
});


test('automatic cooldown does not indefinitely reset after correct focused follow-ups', () => {
  let state = session({ skills: [{ id: 'events', name: 'Events', level: 0, evidence: [evidence(4, 'independent', false)] }], messages: messagesWithAnswers(4) });
  for (let turn = 5; turn <= 7; turn++) {
    state = turnEvidence(state, { kind: 'independent', correct: true, note: 'Fresh successful focused check.' });
    assert.equal(state.skills[0].evidence.at(-1).kind, turn < 7 ? 'assisted' : 'independent');
  }
  for (let turn = 8; turn <= 9; turn++) state = turnEvidence(state, { kind: 'independent', correct: true, note: 'Fresh independent check.' });
  state = turnEvidence(state, { kind: 'recall', correct: true, note: 'Delayed unprompted recall.' });
  assert.equal(state.skills[0].level, 4);
});

test('a first-question direct explanation is usable before any substantive learner answer', () => {
  const state = session({ phase: 'diagnostic', diagnosticCount: 0, messages: messagesWithAnswers(0) });
  const next = turnEvidence(state, null, 'just tell me');
  assert.equal(next.diagnosticCount, 0);
  assert.equal(next.skills[0].evidence.at(-1).kind, 'assisted');
  assert.equal(next.skills[0].level, 0);
});

test('model evaluation receives conversation order without response timestamps', async () => {
 const state = session({ createdAt: 1723456789012, updatedAt: 1723456799012,
   messages: messagesWithAnswers(3).map(item => ({ ...item, at: 1723456799012 })) });
 const before = JSON.stringify(state);
 const prompt = await makeTutorPrompt(request(state));
 assert.ok(!prompt.includes('1723456789012'));
 assert.ok(!prompt.includes('1723456799012'));
 assert.ok(!prompt.includes('"createdAt"'));
 assert.ok(!prompt.includes('"updatedAt"'));
 assert.ok(!prompt.includes('"at":'));
 assert.ok(prompt.includes('Independent answer 1'));
 assert.match(prompt, /Never infer competence, effort, or credit from response speed/);
 assert.equal(JSON.stringify(state), before);
});
