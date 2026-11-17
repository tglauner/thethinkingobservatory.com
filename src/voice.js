/** Browser speech only: audio is never recorded or uploaded by this application. */
export function createVoiceController({ scope = globalThis, onChange = () => {}, onTranscript = () => {}, maxLength = 12000 } = {}) {
  const Recognition = scope.SpeechRecognition || scope.webkitSpeechRecognition;
  const synthesis = scope.speechSynthesis;
  const supported = typeof Recognition === 'function';
  const canSpeak = typeof synthesis?.speak === 'function' && typeof scope.SpeechSynthesisUtterance === 'function';
  const limit = Math.min(12000, Math.max(1, Math.floor(maxLength) || 12000));
  const state = { supported, canSpeak, starting: false, listening: false, speaking: false, interim: '', error: '' };
  let active = null;
  let spoken = null;
  let destroyed = false;
  const language = () => scope.document?.documentElement?.lang || scope.navigator?.language || 'en-US';
  const getState = () => ({ ...state });
  const update = changes => {
    Object.assign(state, changes);
    if (!destroyed) onChange(getState());
  };
  const publish = (session, interim = false) => {
    if (active === session && !destroyed) onTranscript(session.text, { interim });
  };
  function stopSpeaking() {
    const hadSpeech = spoken !== null;
    spoken = null;
    if (hadSpeech) {
      try { synthesis.cancel(); } catch { /* The browser may already have stopped. */ }
    }
    if (state.speaking) update({ speaking: false });
  }
  function abort() {
    const session = active;
    active = null;
    if (session) {
      try { session.recognition.abort(); } catch { /* Recognition may already have ended. */ }
    }
    update({ starting: false, listening: false, interim: '', error: '' });
  }
  function stop() {
    if (!active) return;
    // A pending permission prompt must not activate the mic after a stop click.
    if (state.starting) { abort(); return; }
    const session = active;
    session.stopping = true;
    publish(session);
    update({ starting: false, listening: false, interim: '' });
    try { session.recognition.stop(); }
    catch {
      active = null;
      try { session.recognition.abort(); } catch { /* Already stopped. */ }
    }
  }
  function start(initialText = '') {
    if (destroyed) return false;
    abort();
    stopSpeaking();
    if (!supported) {
      update({ error: 'Voice input is unavailable in this browser. Try Chrome or use your device’s dictation with the answer box.' });
      return false;
    }
    let recognition;
    try { recognition = new Recognition(); }
    catch {
      update({ error: 'Your browser could not start voice input. You can still type or use your device’s dictation.' });
      return false;
    }
    const base = String(initialText).slice(0, limit).trimEnd();
    const session = { recognition, base, text: base, heard: false, stopping: false };
    active = session;
    recognition.lang = language();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (active === session && !session.stopping) update({ starting: false, listening: true });
    };
    recognition.onresult = event => {
      if (active !== session || destroyed) return;
      const parts = [], interim = [];
      // Results include prior final segments; rebuild instead of appending them.
      for (let index = 0; index < event.results.length; index++) {
        const result = event.results[index];
        const text = String(result[0]?.transcript || '').trim();
        if (text) parts.push(text);
        if (text && !result.isFinal) interim.push(text);
      }
      const recognized = parts.join(' ');
      session.heard ||= recognized.length > 0;
      session.text = [session.base, recognized].filter(Boolean).join(' ').slice(0, limit);
      publish(session, interim.length > 0 && !session.stopping);
      update({ interim: session.stopping ? '' : interim.join(' ') });
      if (session.text.length >= limit) {
        update({ error: 'The answer has reached its length limit. Review or shorten it before sending.' });
        stop();
      }
    };
    recognition.onerror = event => {
      if (active !== session || destroyed) return;
      active = null;
      const errors = {
        'not-allowed': 'Microphone access was denied. Allow microphone access for this site in your browser settings, then try again.',
        'service-not-allowed': 'Your browser’s speech service is unavailable. Try Chrome or your device’s dictation.',
        'audio-capture': 'No microphone was available. Check your microphone connection and browser permissions.',
        network: 'The browser’s speech service could not connect. Check your connection and try again, or type your answer.',
        'no-speech': 'No speech was heard. Try again and speak after the listening indicator appears.',
        'language-not-supported': 'This language is unavailable for voice input. Try your device’s dictation instead.',
      };
      const error = event.error === 'aborted' ? '' : errors[event.error] || 'Voice input stopped unexpectedly. Your draft is kept; try again or type your answer.';
      try { recognition.abort(); } catch { /* A failed service may already be closed. */ }
      update({ starting: false, listening: false, interim: '', error });
    };
    recognition.onnomatch = () => {
      if (active === session) update({ error: 'The speech was not clear enough to transcribe. Try again, or type your answer.' });
    };
    recognition.onend = () => {
      if (active !== session || destroyed) return;
      publish(session);
      active = null;
      update({ starting: false, listening: false, interim: '', ...(!session.heard && !session.stopping ? { error: 'No speech was heard. Try again and speak after the listening indicator appears.' } : {}) });
    };
    update({ starting: true, listening: false, interim: '', error: '' });
    try { recognition.start(); return true; }
    catch {
      active = null;
      try { recognition.abort(); } catch { /* No active service. */ }
      update({ starting: false, listening: false, error: 'Voice input could not start. Check microphone permissions and try again.' });
      return false;
    }
  }
  function speak(text) {
    if (destroyed) return false;
    abort();
    stopSpeaking();
    if (!canSpeak) {
      update({ error: 'Read-aloud is unavailable in this browser. The tutor’s reply is still shown in the conversation.' });
      return false;
    }
    const content = String(text).trim().slice(0, limit);
    if (!content) return false;
    const utterance = new scope.SpeechSynthesisUtterance(content);
    utterance.lang = language();
    utterance.rate = 1;
    spoken = utterance;
    utterance.onstart = () => { if (spoken === utterance) update({ speaking: true }); };
    utterance.onend = () => {
      if (spoken !== utterance) return;
      spoken = null;
      update({ speaking: false });
    };
    utterance.onerror = () => {
      if (spoken !== utterance) return;
      spoken = null;
      update({ speaking: false, error: 'Your browser could not read the reply aloud. Press Listen to try again, or read it in the conversation.' });
    };
    update({ speaking: true, error: '' });
    try { synthesis.speak(utterance); return true; }
    catch {
      spoken = null;
      update({ speaking: false, error: 'Your browser could not read the reply aloud. You can read it in the conversation.' });
      return false;
    }
  }
  function destroy() {
    if (destroyed) return;
    abort();
    stopSpeaking();
    destroyed = true;
  }
  return { supported, canSpeak, getState, start, stop, abort, speak, stopSpeaking, destroy };
}
