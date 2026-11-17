import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../src/voice.js';

function fixture({ prefixed = false, maxLength } = {}) {
  const recognitions = [], spoken = [], transcripts = [], changes = [];
  let cancellations = 0;
  class Recognition {
    constructor() { recognitions.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  class Utterance { constructor(text) { this.text = text; } }
  const scope = {
    [prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition']: Recognition,
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: { speak: utterance => spoken.push(utterance), cancel: () => { cancellations++; } },
    document: { documentElement: { lang: 'en-US' } },
  };
  const controller = createVoiceController({ scope, maxLength, onTranscript: (text, meta) => transcripts.push({ text, ...meta }), onChange: state => changes.push(state) });
  return { controller, recognitions, spoken, transcripts, changes, scope, get cancellations() { return cancellations; } };
}
function result(recognition, items) {
  recognition.onresult({ results: items.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal })) });
}

test('voice remains idle until the learner explicitly starts it', () => {
  const f = fixture();
  assert.equal(f.recognitions.length, 0);
  assert.deepEqual(f.controller.getState(), { supported: true, canSpeak: true, starting: false, listening: false, speaking: false, interim: '', error: '' });
  f.controller.start('Existing thought.');
  assert.equal(f.recognitions.length, 1);
  assert.equal(f.controller.getState().starting, true);
  assert.equal(f.recognitions[0].continuous, true);
  assert.equal(f.recognitions[0].interimResults, true);
  assert.equal(f.recognitions[0].lang, 'en-US');
  f.recognitions[0].onstart();
  assert.equal(f.controller.getState().listening, true);
});

test('voice supports prefixed browser recognition without requiring extra dependencies', () => {
  const f = fixture({ prefixed: true });
  assert.equal(f.controller.supported, true);
  assert.equal(f.controller.start(), true);
});

test('voice replaces interim text and does not duplicate final segments from later result events', () => {
  const f = fixture();
  f.controller.start('My reasoning:');
  const r = f.recognitions[0]; r.onstart();
  result(r, [['two', false]]);
  assert.equal(f.transcripts.at(-1).text, 'My reasoning: two');
  result(r, [['two outcomes', true], ['might', false]]);
  assert.equal(f.transcripts.at(-1).text, 'My reasoning: two outcomes might');
  result(r, [['two outcomes', true], ['might be equal', true]]);
  assert.deepEqual(f.transcripts.at(-1), { text: 'My reasoning: two outcomes might be equal', interim: false });
  assert.equal(f.controller.getState().interim, '');
});

test('voice handles interim list shrinking rather than retaining stale hypotheses', () => {
  const f = fixture(); f.controller.start();
  const r = f.recognitions[0]; r.onstart();
  result(r, [['one', true], ['two', false], ['three', false]]);
  result(r, [['one', true], ['different', false]]);
  assert.equal(f.transcripts.at(-1).text, 'one different');
});

test('stopping voice keeps the current draft and accepts the browser’s final correction', () => {
  const f = fixture(); f.controller.start('I think');
  const r = f.recognitions[0]; r.onstart();
  result(r, [['one half', false]]);
  f.controller.stop();
  assert.equal(r.stopped, true);
  assert.equal(f.controller.getState().listening, false);
  assert.deepEqual(f.transcripts.at(-1), { text: 'I think one half', interim: false });
  result(r, [['one half.', true]]); r.onend();
  assert.equal(f.transcripts.at(-1).text, 'I think one half.');
  assert.equal(f.controller.getState().interim, '');
});

test('stopping during a permission prompt invalidates a delayed microphone start', () => {
  const f = fixture(); f.controller.start();
  const r = f.recognitions[0];
  f.controller.stop(); r.onstart();
  assert.equal(r.aborted, true);
  assert.equal(f.controller.getState().starting, false);
  assert.equal(f.controller.getState().listening, false);
});

test('aborting voice ignores late results that could overwrite a new draft', () => {
  const f = fixture(); f.controller.start('Old');
  const old = f.recognitions[0]; old.onstart();
  result(old, [['draft', true]]);
  f.controller.abort();
  const count = f.transcripts.length;
  result(old, [['late replacement', true]]); old.onend();
  assert.equal(f.transcripts.length, count);
  f.controller.start('New');
  result(old, [['even later replacement', true]]);
  result(f.recognitions[1], [['thought', true]]);
  assert.equal(f.transcripts.at(-1).text, 'New thought');
});

test('voice permission denial stops the mic, retains recognized text and explains recovery', () => {
  const f = fixture(); f.controller.start('Draft');
  const r = f.recognitions[0]; r.onstart(); result(r, [['so far', true]]);
  r.onerror({ error: 'not-allowed' });
  assert.equal(r.aborted, true);
  assert.equal(f.controller.getState().listening, false);
  assert.match(f.controller.getState().error, /Allow microphone access/);
  assert.equal(f.transcripts.at(-1).text, 'Draft so far');
  f.controller.start();
  assert.equal(f.controller.getState().error, '');
});

test('voice service failures have distinct actionable messages', () => {
  for (const [error, pattern] of [['audio-capture', /No microphone/], ['network', /could not connect/], ['no-speech', /No speech was heard/], ['service-not-allowed', /speech service is unavailable/], ['language-not-supported', /language is unavailable/]]) {
    const f = fixture(); f.controller.start(); f.recognitions[0].onerror({ error });
    assert.match(f.controller.getState().error, pattern);
    assert.equal(f.controller.getState().starting, false);
  }
});

test('voice browser abort errors do not become spurious user-facing failures', () => {
  const f = fixture(); f.controller.start(); f.recognitions[0].onerror({ error: 'aborted' });
  assert.equal(f.controller.getState().error, '');
});

test('voice natural ending commits the last interim text without restarting automatically', () => {
  const f = fixture(); f.controller.start();
  const r = f.recognitions[0]; r.onstart(); result(r, [['A provisional idea', false]]); r.onend();
  assert.deepEqual(f.transcripts.at(-1), { text: 'A provisional idea', interim: false });
  assert.equal(f.controller.getState().listening, false);
  assert.equal(f.recognitions.length, 1);
});

test('voice stops at the answer limit and never emits an oversized draft', () => {
  const f = fixture({ maxLength: 12 }); f.controller.start('Base');
  const r = f.recognitions[0]; r.onstart(); result(r, [['a much longer spoken answer', false]]);
  assert.equal(f.transcripts.at(-1).text.length, 12);
  assert.equal(r.stopped, true);
  assert.match(f.controller.getState().error, /length limit/);
});

test('unsupported browser voice has a usable typing or device-dictation fallback', () => {
  const controller = createVoiceController({ scope: {} });
  assert.equal(controller.supported, false);
  assert.equal(controller.canSpeak, false);
  assert.equal(controller.start(), false);
  assert.match(controller.getState().error, /device’s dictation/);
  assert.equal(controller.speak('Question?'), false);
  assert.match(controller.getState().error, /Read-aloud is unavailable/);
});

test('a failed microphone start clears pending state rather than leaving a stuck indicator', () => {
  const f = fixture();
  f.scope.SpeechRecognition.prototype.start = () => { throw new Error('blocked'); };
  assert.equal(f.controller.start(), false);
  assert.equal(f.controller.getState().starting, false);
  assert.match(f.controller.getState().error, /could not start/);
});

test('read-aloud cancels dictation so the tutor cannot transcribe its own voice', () => {
  const f = fixture(); f.controller.start(); const r = f.recognitions[0]; r.onstart();
  assert.equal(f.controller.speak('Which outcomes remain?'), true);
  assert.equal(r.aborted, true);
  assert.equal(f.controller.getState().listening, false);
  assert.equal(f.spoken[0].text, 'Which outcomes remain?');
  assert.equal(f.controller.getState().speaking, true);
  f.spoken[0].onend();
  assert.equal(f.controller.getState().speaking, false);
});

test('starting a microphone cancels read-aloud and ignores its stale ending', () => {
  const f = fixture(); f.controller.speak('An earlier question?'); const old = f.spoken[0];
  f.controller.start(); old.onend(); old.onerror();
  assert.equal(f.cancellations, 1);
  assert.equal(f.controller.getState().starting, true);
  assert.equal(f.controller.getState().error, '');
});

test('read-aloud replacement ignores cancellation events from the earlier utterance', () => {
  const f = fixture(); f.controller.speak('Old question?'); const old = f.spoken[0];
  f.controller.speak('New question?'); old.onend(); old.onerror();
  assert.equal(f.cancellations, 1);
  assert.equal(f.controller.getState().speaking, true);
  f.spoken[1].onerror();
  assert.equal(f.controller.getState().speaking, false);
  assert.match(f.controller.getState().error, /could not read/);
});

test('voice destruction releases both speech services and ignores all future callbacks', () => {
  const f = fixture(); f.controller.start(); const r = f.recognitions[0]; r.onstart();
  f.controller.destroy(); const count = f.changes.length;
  result(r, [['late', true]]); r.onstart(); r.onend(); r.onerror({ error: 'network' });
  assert.equal(f.changes.length, count);
  assert.equal(f.controller.start(), false);
  assert.equal(f.controller.speak('Late question?'), false);
  assert.equal(f.transcripts.length, 0);
});
