import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STORAGE_KEY, validateSession, parseSessionImport, loadSession, saveSession, exportSession } from '../src/tutor-state.js';

function fixture() {
  return { version: 2, id: 'test-session', topic: 'Probability', goal: 'Independent problem solving (level 4)', createdAt: 100, updatedAt: 200, phase: 'diagnostic', diagnosticCount: 1, focus: 'sample-spaces', skills: [{ id: 'sample-spaces', name: 'Sample spaces', level: 0, evidence: [{ turn: 1, kind: 'independent', correct: true, note: 'Distinguished ordered outcomes.' }] }], messages: [{ role: 'tutor', text: 'What outcomes are possible?', at: 100 }, { role: 'learner', text: 'HH, HT, TH, TT.', at: 200 }, { role: 'tutor', text: 'How many contain one head?', at: 200 }], notes: ['Check independence later.'] };
}
function memory() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('tutor export and import preserve the full conversation and learning evidence', () => {
  const value = fixture();
  assert.deepEqual(parseSessionImport(exportSession(value)), value);
});
test('tutor validation returns fresh canonical objects without unknown fields', () => {
  const value = fixture();
  value.unknown = 'discard';
  value.skills[0].unknown = 'discard';
  const valid = validateSession(value);
  assert.equal(valid.unknown, undefined);
  assert.equal(valid.skills[0].unknown, undefined);
  valid.skills[0].evidence[0].note = 'changed';
  assert.equal(value.skills[0].evidence[0].note, 'Distinguished ordered outcomes.');
});
test('tutor imports reject malformed JSON with a useful error', () => {
  assert.throws(() => parseSessionImport('{broken'), /not valid JSON/);
});
test('tutor rejects oversized imports before parsing', () => {
  assert.throws(() => parseSessionImport('x'.repeat(2_000_001)), /smaller than 2 MB/);
});
test('tutor version boundary leaves original exercise progress separate', () => {
  const storage = memory();
  storage.setItem('jane-street-observatory:v1', '{"legacy":true}');
  assert.equal(saveSession(storage, fixture()), true);
  assert.equal(storage.getItem('jane-street-observatory:v1'), '{"legacy":true}');
  assert.ok(storage.getItem(SESSION_STORAGE_KEY));
  assert.throws(() => validateSession({ ...fixture(), version: 1 }), /version 2/);
});
test('tutor rejects duplicate skill IDs and unknown focus IDs', () => {
  const value = fixture();
  value.skills.push(structuredClone(value.skills[0]));
  assert.throws(() => validateSession(value), /unique/);
  assert.throws(() => validateSession({ ...fixture(), focus: 'unknown' }), /not part/);
});
test('tutor rejects unsafe identifiers and out of range skill levels', () => {
  assert.throws(() => validateSession({ ...fixture(), id: '../private' }), /session ID/);
  for (const level of [-1, 6, 1.5, Infinity, NaN]) {
    const value = fixture();
    value.skills[0].level = level;
    assert.throws(() => validateSession(value), /level/);
  }
});
test('tutor rejects unsupported learning phases and diagnostic counts', () => {
  assert.throws(() => validateSession({ ...fixture(), phase: 'certified' }), /phase/);
  assert.throws(() => validateSession({ ...fixture(), diagnosticCount: 6 }), /phase/);
});
test('tutor validates evidence kind, correctness, turn and note bounds', () => {
  for (const changes of [{ kind: 'invented' }, { correct: 'yes' }, { turn: 401 }, { note: 'x'.repeat(1001) }]) {
    const value = fixture();
    Object.assign(value.skills[0].evidence[0], changes);
    assert.throws(() => validateSession(value), /evidence entry/);
  }
});
test('tutor rejects nonfinite or reversed dates and untrusted message roles', () => {
  assert.throws(() => validateSession({ ...fixture(), updatedAt: Infinity }), /dates/);
  assert.throws(() => validateSession({ ...fixture(), updatedAt: 99 }), /dates/);
  const value = fixture();
  value.messages[0].role = 'system';
  assert.throws(() => validateSession(value), /message/);
});
test('tutor safely retains markup as plain conversation text', () => {
  const value = fixture();
  value.messages[1].text = '<img src=x onerror=alert(1)><script>bad()</script>';
  assert.equal(parseSessionImport(exportSession(value)).messages[1].text, value.messages[1].text);
});
test('tutor rejects empty and overlong conversation messages', () => {
  for (const text of ['', '   ', 'x'.repeat(12001)]) {
    const value = fixture();
    value.messages[0].text = text;
    assert.throws(() => validateSession(value), /message/);
  }
});
test('tutor storage failure preserves a usable in-memory session', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.deepEqual(loadSession(storage), { session: null, error: 'denied' });
  assert.equal(saveSession(storage, fixture()), false);
  assert.equal(saveSession(null, fixture()), false);
  assert.doesNotThrow(() => exportSession(fixture()));
});
test('tutor loading corrupt stored data never overwrites it', () => {
  const storage = memory();
  storage.setItem(SESSION_STORAGE_KEY, 'broken');
  const loaded = loadSession(storage);
  assert.equal(loaded.session, null);
  assert.match(loaded.error, /JSON/);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), 'broken');
});
test('tutor resetting its namespace preserves unrelated browser state', () => {
  const storage = memory();
  storage.setItem('unrelated', 'keep');
  saveSession(storage, fixture());
  assert.equal(saveSession(storage, null), true);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
});


test('tutor rejects incomplete or out of sequence conversation histories', () => {
  const incomplete = fixture();
  incomplete.messages.pop();
  assert.throws(() => validateSession(incomplete), /end with the tutor/);
  const reordered = fixture();
  reordered.messages[0].role = 'learner';
  assert.throws(() => validateSession(reordered), /alternate/);
});
test('tutor evidence references substantive answers rather than command turns', () => {
  for (const command of ['easier', 'harder', 'just tell me', 'show progress', 'save state', 'focus: sample spaces']) {
    const value = fixture();
    value.messages[1].text = command;
    assert.throws(() => validateSession(value), /evidence cannot refer/);
    value.skills[0].evidence = [];
    assert.doesNotThrow(() => validateSession(value));
  }
});
test('tutor caps the whole canonical session below the API body budget', () => {
  const value = fixture();
  value.messages = [{ role: 'tutor', text: 'x'.repeat(2000), at: 100 }];
  for (let index = 0; index < 199; index += 1) value.messages.push({ role: 'learner', text: 'x'.repeat(2000), at: 100 }, { role: 'tutor', text: 'x'.repeat(2000), at: 100 });
  assert.throws(() => validateSession(value), /too large to continue/);
});


test('tutor accepts an assisted reveal before the first substantive answer', () => {
  const value = fixture();
  value.messages[1].text = 'just tell me';
  value.skills[0].evidence[0] = { turn: 0, kind: 'assisted', correct: false, note: 'Answer revealed at learner request.' };
  assert.doesNotThrow(() => validateSession(value));
  value.skills[0].evidence[0].kind = 'independent';
  assert.throws(() => validateSession(value), /evidence entry/);
});
