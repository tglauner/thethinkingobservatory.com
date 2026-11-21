import { learningProgress } from './src/tutor-progress.js';
import { tracks, sources } from './src/curriculum.js';
import { validateSession, loadSession, saveSession, exportSession, parseSessionImport, MAX_IMPORT_BYTES } from './src/tutor-state.js';
import { createVoiceController } from './src/voice.js';

const main = document.querySelector('main');
const fileInput = document.querySelector('#session-file');
const connection = document.querySelector('#connection-status');
const levelNames = ['Not yet evidenced', 'Heard of it', 'Can follow along', 'Can do with help', 'Independent', 'Can teach & handle edge cases'];
const phaseNames = { diagnostic: 'Finding your starting point', learning: 'Thinking it through', review: 'Returning to an earlier idea', assessment: 'Mixed assessment', complete: 'Assessment complete' };
let storage;
try { storage = window.localStorage; } catch { storage = null; }
const loaded = loadSession(storage);
let session = loaded.session;
let storageWarning = loaded.error ? 'A saved session could not be loaded. Your stored data has not been changed. You can import a session backup.' : !storage ? 'Browser storage is unavailable. Export your session before closing this page.' : '';
let provider = { available: false, checking: true, message: 'Checking the tutor connection.' };
let pending = false;
let pendingText = '';
let draft = '';
let errorMessage = '';
let lastRequest = null;
let toastTimer;
let pendingTimer;
let pendingElapsed = 0;
let selectedTopic = 'probability';
let customTopic = '';
let selectedGoal = 'Independent problem solving (level 4)';
let experience = 'Place me from my answers';
const VOICE_PREFERENCE_KEY = 'thinking-observatory:voice:v1';
let readReplies = false;
let speakAfterNavigation = false;
try { readReplies = JSON.parse(storage?.getItem(VOICE_PREFERENCE_KEY) || 'null')?.readReplies === true; } catch { /* Use the quiet default. */ }
let voiceState = { supported: false, canSpeak: false, starting: false, listening: false, speaking: false, error: '' };

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const route = () => location.hash.slice(1) || 'home';
const button = (label, id, primary = false) => `<button class="button${primary ? ' primary' : ''}" id="${id}"${pending ? ' disabled' : ''}>${label}<span aria-hidden="true">→</span></button>`;
const voice = createVoiceController({
  onChange(next) { voiceState = next; updateVoiceControls(); },
  onTranscript(text) {
    if (!session || pending || route() !== 'study') return;
    draft = text;
    const input = main.querySelector('#reasoning-input');
    if (input) input.value = text;
  },
});
voiceState = voice.getState();

function stopVoice() { voice.abort(); voice.stopSpeaking(); }
function voiceMarkup() {
  return `<div class="voice-controls"><button class="voice-button" id="voice-input" type="button" aria-pressed="false" aria-describedby="voice-status voice-help"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg><span class="voice-label">Speak your answer</span><span class="recording-dot" aria-hidden="true"></span></button><div class="spoken-controls"><button class="link-button" id="listen-question" type="button">Listen to question</button><label class="read-replies"><input id="read-replies" type="checkbox"${readReplies ? ' checked' : ''}>Read tutor replies aloud</label></div></div><p class="voice-status" id="voice-status" role="status" aria-live="polite"></p><p class="voice-help" id="voice-help"></p>`;
}
function updateVoiceControls() {
  const microphone = main.querySelector('#voice-input');
  if (!microphone) return;
  const active = voiceState.starting || voiceState.listening;
  microphone.disabled = pending || !voiceState.supported;
  microphone.setAttribute('aria-pressed', String(active));
  microphone.classList.toggle('recording', active);
  microphone.querySelector('.voice-label').textContent = active ? 'Stop listening' : 'Speak your answer';
  const input = main.querySelector('#reasoning-input');
  input.readOnly = active;
  const status = main.querySelector('#voice-status');
  const message = voiceState.error || (voiceState.starting ? 'Waiting for microphone permission… Allow access in your browser.' : voiceState.listening ? 'Listening… Speak your reasoning, then stop to review and edit.' : voiceState.speaking ? 'Reading the tutor’s question aloud.' : !voiceState.supported ? 'Voice input is unavailable in this browser. Try Chrome, or use your computer’s dictation in the answer box.' : 'Speak, stop, then review your words before sending.');
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle('voice-error', Boolean(voiceState.error));
  main.querySelector('#voice-help').textContent = voiceState.supported ? 'Your browser’s speech service may process audio online. The transcript goes to the tutor when you press Send.' : '';
  const listen = main.querySelector('#listen-question');
  listen.disabled = pending || !voiceState.canSpeak;
  listen.textContent = voiceState.speaking ? 'Stop reading' : 'Listen to question';
  const checkbox = main.querySelector('#read-replies');
  checkbox.disabled = !voiceState.canSpeak;
  checkbox.checked = readReplies;
}
function wireVoice() {
  updateVoiceControls();
  main.querySelector('#voice-input').addEventListener('click', () => {
    if (voiceState.starting) voice.abort();
    else if (voiceState.listening) voice.stop();
    else voice.start(draft);
  });
  main.querySelector('#listen-question').addEventListener('click', () => {
    if (voiceState.speaking) voice.stopSpeaking();
    else voice.speak(session.messages.filter(message => message.role === 'tutor').at(-1).text);
  });
  main.querySelector('#read-replies').addEventListener('change', event => {
    readReplies = event.target.checked;
    try { storage?.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({ readReplies })); } catch { /* Keep the preference in memory. */ }
    if (readReplies) voice.speak(session.messages.filter(message => message.role === 'tutor').at(-1).text);
    else voice.stopSpeaking();
  });
}
function toast(message) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 6500);
}
function persist() {
  if (!saveSession(storage, session)) storageWarning = 'This session is kept in memory because browser storage is unavailable or full. Export it before closing this page.';
}
function availabilityMarkup() {
  if (provider.available) return '<p class="provider-notice">Your topic, goal and conversation are sent to OpenAI. The site owner pays for tutor responses. AI feedback can be mistaken.</p>';
  return `<div class="inline-availability" role="status"><p>${escapeHTML(provider.message)}</p>${provider.checking ? '' : '<button class="link-button" data-reconnect>Check connection again ↗</button>'}</div>`;
}
function warningsMarkup() {
  return `${storageWarning ? `<p class="storage-warning" role="status">${escapeHTML(storageWarning)}</p>` : ''}${errorMessage ? `<div class="error-box" role="alert"><p>${escapeHTML(errorMessage)}</p>${lastRequest ? '<button class="link-button" id="retry-turn">Retry this turn ↗</button>' : ''}</div>` : ''}`;
}
function methodSteps() {
  return `<div class="method-steps"><div class="method-step"><b>01</b><div><h3>Find your starting point.</h3><p>A few questions, one at a time, reveal what you already know.</p></div></div><div class="method-step"><b>02</b><div><h3>Work through the why.</h3><p>Explain your thinking. A wrong turn becomes a smaller question to reason through.</p></div></div><div class="method-step"><b>03</b><div><h3>Make the understanding yours.</h3><p>Return to earlier ideas, handle new cases, and connect them in a mixed assessment.</p></div></div></div>`;
}
function renderHome() {
  const completed = session?.phase === 'complete';
  main.innerHTML = `${session ? `<aside class="resume-banner"><div><p class="eyebrow">YOUR SAVED STUDY ROOM</p><h2>${escapeHTML(session.topic)}</h2><p>${phaseNames[session.phase]} · ${session.messages.filter(message => message.role === 'learner').length} responses</p></div><div class="resume-actions">${button(completed ? 'Return to your session' : 'Continue learning', 'resume-session', true)}<button class="link-button" id="home-export"${pending ? ' disabled' : ''} title="Download your conversation, learning map and notes to back up or resume on another browser.">Export session</button></div></aside>` : ''}
  <section class="onboarding"><div class="intro"><p class="eyebrow">A SOCRATIC STUDY ROOM</p><h1>Think it through.<br><em>One question<br>at a time.</em></h1><p>Choose something you want to understand. Your tutor starts where you are, listens to your reasoning, and asks the next question that helps you move forward.</p><div class="intro-rule"></div>${methodSteps()}<div class="intro-chart" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><span>FROM RECOGNITION TO INDEPENDENCE</span></div></div>
  <div class="setup-panel"><div class="panel-top"><p class="eyebrow">YOUR NEXT EXPLORATION</p><span>01 / BEGIN</span></div><h2>What would you like to understand?</h2><p>Pick a field, or bring a question of your own.</p><form id="setup-form"><fieldset class="topic-grid"><legend>Choose your field</legend>${tracks.map(track => `<label class="topic-option"><input type="radio" name="topic" value="${track.id}"${selectedTopic === track.id ? ' checked' : ''}><span class="topic-symbol${track.symbol.length > 2 ? ' long-symbol' : ''}" aria-hidden="true">${escapeHTML(track.symbol)}</span><span>${escapeHTML(track.shortTitle || track.title)}</span></label>`).join('')}</fieldset><div class="custom-field"><label class="field-label" for="custom-topic">Or choose a specific topic <span>(optional)</span></label><input class="text-input" id="custom-topic" maxlength="240" value="${escapeHTML(customTopic)}" placeholder="e.g. Bayes’ rule, recursion, market making"></div>
  <details class="setup-details"><summary>Set your goal & starting experience</summary><div class="setup-detail-fields"><div><label class="field-label" for="learning-goal">Learning goal</label><select id="learning-goal"><option${selectedGoal.includes('4') ? ' selected' : ''}>Independent problem solving (level 4)</option><option${selectedGoal.includes('5') ? ' selected' : ''}>Full mastery (level 5)</option></select></div><div><label class="field-label" for="experience">Your experience</label><select id="experience">${['Place me from my answers', 'I am new to this', 'I know the basics', 'Challenge my understanding'].map(value => `<option${experience === value ? ' selected' : ''}>${value}</option>`).join('')}</select></div></div></details>
  <button class="button primary" id="start-session" type="submit"${pending || !provider.available ? ' disabled' : ''}>${pending ? 'Preparing your first question…' : session ? 'Start a new learning session' : 'Start learning'}<span aria-hidden="true">→</span></button><p class="small-note">We’ll begin with 3–5 diagnostic questions, then build a skill map and suggest a starting point. You can change direction at any time.</p>${availabilityMarkup()}${warningsMarkup()}</form><div class="import-row"><p>Already have a session saved?<br>Bring your conversation and skill map with you.</p><button class="link-button" data-import${pending ? ' disabled' : ''}>Import session ↗</button></div></div></section>`;
  const form = main.querySelector('#setup-form');
  form.addEventListener('change', () => {
    selectedTopic = form.elements.topic.value;
    selectedGoal = form.querySelector('#learning-goal').value;
    experience = form.querySelector('#experience').value;
  });
  form.querySelector('#custom-topic').addEventListener('input', event => { customTopic = event.target.value; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !provider.available) return;
    if (session && !confirm('Start a new session? Your current session will be replaced after the first new question arrives. Export it first if you want to keep both.')) return;
    const topic = customTopic.trim() || tracks.find(track => track.id === selectedTopic)?.title || 'Probability';
    const goal = `${selectedGoal}. Starting experience: ${experience}.`;
    await requestTurn({ session: null, topic, goal, message: '' });
  });
  main.querySelector('#resume-session')?.addEventListener('click', () => { location.hash = 'study'; });
  main.querySelector('#home-export')?.addEventListener('click', downloadSession);
  wireCommon();
}
function addMessage(message, optimistic = false) {
  const currentQuestion = message.role === 'tutor' && message === session?.messages.at(-1);
  const article = document.createElement('article');
  article.className = `message ${message.role}${currentQuestion ? ' current-question' : ''}`;
  if (currentQuestion) article.setAttribute('aria-label', 'Current tutor question');
  if (optimistic) article.dataset.optimistic = 'true';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const mark = document.createElement('span');
  mark.className = 'speaker-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = message.role === 'tutor' ? '∴' : '↳';
  const speaker = document.createElement('span');
  speaker.textContent = currentQuestion ? (session.phase === 'complete' ? 'A MOMENT TO TAKE STOCK' : 'YOUR NEXT EXPLORATION') : message.role === 'tutor' ? 'YOUR TUTOR' : 'YOUR THINKING';
  meta.append(mark, speaker);
  const text = document.createElement('div');
  text.className = 'message-text';
  const focusedSkill = message.role === 'learner' && message.text.startsWith('focus:') ? session?.skills.find(skill => skill.id === message.text.slice(6).trim()) : null;
  text.textContent = focusedSkill ? `Let’s focus on ${focusedSkill.name}.` : message.text;
  if (currentQuestion) {
    const emblem = document.createElement('span');
    emblem.className = 'question-emblem';
    emblem.setAttribute('aria-hidden', 'true');
    emblem.textContent = '✳';
    meta.append(emblem);
  }
  article.append(meta, text);
  main.querySelector('#transcript').append(article);
}
function renderSkillMap() {
  const node = main.querySelector('#skill-map');
  const progress = learningProgress(session);
  const checklist = steps => `<ul class="completion-checklist">${steps.map(step => `<li class="${step.done ? 'finished' : ''}"><span aria-hidden="true">${step.done ? '✓' : '○'}</span><span>${escapeHTML(step.label)}<small>${step.done ? 'Done' : 'Still to do'}</small></span></li>`).join('')}</ul>`;
  node.innerHTML = `<p class="eyebrow">YOUR LEARNING MAP</p><h2>Your route<br><em>to the finish.</em></h2><div class="completion-overview"><strong>${progress.done} of ${progress.total} milestones done</strong><progress max="${progress.total}" value="${progress.done}" aria-label="Session milestones completed"></progress><p>${progress.remaining ? `${progress.remaining} milestones left` : 'All milestones complete'} · ${progress.readySkills} of ${progress.skills.length} skills ready</p></div><ol class="route-stages"><li>${progress.diagnosticDone ? '✓ Starting diagnostic complete' : `Starting diagnostic: ${session.diagnosticCount} answers given (3–5 needed)`}</li><li>${progress.readySkills} / ${progress.skills.length} skills ready for the final assessment</li><li>Final assessment: ${progress.assessment.filter(s => s.done).length} / ${progress.assessment.length} checks passed</li></ol><p class="map-note">These are the finish requirements, not an endless count of attempts. A correct answer may complete more than one milestone; mistakes or hints can require another try.</p><ul class="skill-list">${progress.skills.map(skill => `<li class="skill-item${skill.id === session.focus ? ' current-skill' : ''}"><div class="skill-row"><button class="skill-name" data-focus="${skill.id}"${pending ? ' disabled' : ''}>${escapeHTML(skill.name)}</button><span class="skill-value">${skill.complete ? 'READY' : `${skill.done} / ${skill.total}`}</span></div><p class="requirement-remaining">${skill.complete ? 'Learning goal reached. Final assessment below.' : `${skill.total - skill.done} requirements left`}</p>${checklist(skill.steps)}</li>`).join('')}</ul><details class="final-checklist"${session.phase === 'assessment' ? ' open' : ''}><summary>Final assessment — what remains</summary>${checklist(progress.assessment)}</details><p class="focus-note">If you have already practised a skill, its checklist shows whether a later recall check or tutor confirmation is still missing. Select its name to focus on that step.</p>${session.notes.length ? '<details class="session-notes"><summary>Session notes & misconceptions</summary><ul id="notes-list"></ul></details>' : ''}`;
  node.querySelectorAll('[data-focus]').forEach(button => button.addEventListener('click', () => {
    const skill = session.skills.find(item => item.id === button.dataset.focus);
    if (skill) sendMessage(`focus:${skill.id}`, 'focus');
  }));
  const notes = node.querySelector('#notes-list');
  session.notes.forEach(note => {
    const item = document.createElement('li');
    item.textContent = note;
    notes?.append(item);
  });
}
function renderStudy() {
  if (!session) { renderHome(); return; }
  const responses = session.messages.filter(message => message.role === 'learner').length;
  main.innerHTML = `<div class="study-heading"><div><p class="eyebrow">YOUR SOCRATIC STUDY ROOM</p><h1>${escapeHTML(session.topic)}</h1></div><div class="session-actions"><button class="link-button" id="export-session"${pending ? ' disabled' : ''} title="Download your conversation, learning map and notes to back up or resume on another browser.">Back up / export ↗</button><button class="link-button" data-import${pending ? ' disabled' : ''}>Import</button><button class="link-button" id="new-topic"${pending ? ' disabled' : ''}>New topic</button><span class="save-time">${storageWarning ? 'In memory' : 'Saved in this browser'}</span></div></div><div class="workspace"><section class="conversation-shell phase-${session.phase}" aria-label="Learning conversation"><div class="session-topline"><span class="phase">${phaseNames[session.phase].toUpperCase()}</span><span>${session.phase === 'diagnostic' ? `${session.diagnosticCount} DIAGNOSTIC RESPONSES` : `${responses} RESPONSES · ONE QUESTION AT A TIME`}</span></div><aside class="session-guide" aria-label="Session guide"><p><strong>Take your time.</strong> Response speed is not scored.</p><p>Start with 3–5 diagnostic answers. Your learning map then lists the remaining requirements and final assessment. You can stop at any time; this browser saves your session.</p><details><summary>Why back up / export?</summary><p>Download your conversation, learning map and notes as a JSON file. Import it to resume in another browser or recover after clearing browser data. Keep the file private: it includes your answers.</p></details></aside><div id="transcript" class="transcript" aria-label="Conversation history"></div>${pending ? `<div class="pending-message" role="status"><span class="pending-mark" aria-hidden="true">✳</span><div><p>Your tutor is considering ${pendingText ? 'your reasoning' : 'where to begin'}.</p><small id="pending-detail">The next question may take a little time. Your session is safe.</small></div></div>` : ''}${warningsMarkup()}${session.phase === 'complete' ? '<aside class="complete-note"><h2>A moment to take stock.</h2><p>Your tutor has marked this assessment complete. Review your skill map and weaker areas, export your session, or ask for a new challenge below.</p></aside>' : ''}<form class="composer" id="answer-form"><label for="reasoning-input">MAKE YOUR THINKING VISIBLE</label>${voiceMarkup()}<textarea id="reasoning-input" maxlength="12000" rows="4" placeholder="Explain your reasoning. An uncertain thought is a useful place to start."${pending ? ' disabled' : ''}></textarea><div class="composer-footer"><span>⌘ / CTRL + ENTER TO SEND</span><button class="button primary" id="send-answer" type="submit"${pending || !provider.available ? ' disabled' : ''}>${pending ? 'Thinking…' : 'Send your reasoning'}<span aria-hidden="true">↗</span></button></div></form><div class="tutor-controls" aria-label="Tutor commands"><span class="controls-label">CHANGE THE PACE</span>${[['easier', 'A smaller step'], ['harder', 'Challenge me'], ['just tell me', 'Just tell me'], ['show progress', 'Review my progress']].map(([command, label]) => `<button data-command="${command}"${pending || !provider.available ? ' disabled' : ''}>${label}</button>`).join('')}</div><p class="session-footnote">You can also ask to change focus, explain a different way, or revisit an earlier idea. “Just tell me” reveals the answer for this question; the tutor will check the idea again in a new way.</p>${!provider.available ? availabilityMarkup() : ''}<p class="session-footnote">AI feedback can be mistaken. The skill map is a learning aid, not a certification. Answers are sent to OpenAI; the site owner pays for responses. Your saved conversation belongs to this browser; export it to move or back it up.</p></section><aside class="skill-sidebar" id="skill-map" aria-label="Skill map"></aside></div>`;
  for (const message of session.messages) addMessage(message);
  if (pendingText) addMessage({ role: 'learner', text: pendingText }, true);
  renderSkillMap();
  const input = main.querySelector('#reasoning-input');
  input.value = draft;
  input.addEventListener('input', () => { draft = input.value; });
  wireVoice();
  input.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      main.querySelector('#answer-form').requestSubmit();
    }
  });
  main.querySelector('#answer-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!draft.trim()) { input.focus(); return; }
    sendMessage(draft.trim());
  });
  main.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => sendMessage(button.dataset.command, button.dataset.command)));
  main.querySelector('#export-session').addEventListener('click', downloadSession);
  main.querySelector('#new-topic').addEventListener('click', () => { location.hash = 'home'; });
  wireCommon();
}
function wireCommon() {
  main.querySelectorAll('[data-import]').forEach(button => button.addEventListener('click', () => { if (!pending) { stopVoice(); fileInput.click(); } }));
  main.querySelectorAll('[data-reconnect]').forEach(button => button.addEventListener('click', checkConnection));
  main.querySelector('#retry-turn')?.addEventListener('click', () => { if (lastRequest && !pending) requestTurn(lastRequest); });
}
function sendMessage(text, command) {
  if (pending || !session || !provider.available) return;
  requestTurn({ session, topic: session.topic, goal: session.goal, message: text, ...(command ? { command } : {}) });
}
async function requestTurn(request) {
  if (pending) return;
  stopVoice();
  lastRequest = request;
  pending = true;
  pendingText = request.message;
  pendingElapsed = 0;
  errorMessage = '';
  if (request.session) draft = '';
  render();
  if (session && route() === 'study') main.querySelector('.pending-message')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  pendingTimer = setInterval(() => {
    pendingElapsed += 1;
    const detail = main.querySelector('#pending-detail');
    if (detail && pendingElapsed >= 20) detail.textContent = `Still considering the next question (${pendingElapsed}s). You can leave this tab open.`;
  }, 1000);
  let success = false;
  try {
    const response = await fetch('/api/tutor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `The tutor could not respond (HTTP ${response.status}). Retry this turn.`);
    const next = validateSession(result.session);
    session = next;
    persist();
    draft = '';
    lastRequest = null;
    success = true;
  } catch (error) {
    errorMessage = error.name === 'AbortError' ? 'The tutor took too long to respond. Your last saved session is unchanged. Retry this turn.' : error.message || 'The tutor connection was interrupted. Your last saved session is unchanged.';
    if (request.session && !request.command) draft = request.message;
  } finally {
    clearTimeout(timeout);
    clearInterval(pendingTimer);
    pending = false;
    pendingText = '';
    if (success) {
      if (route() !== 'study') { speakAfterNavigation = readReplies; location.hash = 'study'; }
      else {
        render();
        if (readReplies) voice.speak(session.messages.filter(message => message.role === 'tutor').at(-1).text);
      }
    } else render();
    if (route() === 'study' && success) {
      requestAnimationFrame(() => {
        const latest = main.querySelector('#transcript .message:last-child');
        latest?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        main.querySelector('#reasoning-input')?.focus({ preventScroll: true });
      });
    }
  }
}
async function checkConnection() {
  stopVoice();
  provider.checking = true;
  provider.message = 'Checking the tutor connection.';
  updateConnection();
  render();
  try {
    const response = await fetch('/api/tutor/status', { signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    if (!response.ok || typeof result.available !== 'boolean') throw new Error('The tutor connection is unavailable. Please try again later.');
    provider = { available: result.available, checking: false, message: String(result.message || (result.available ? 'Your tutor is connected.' : 'The tutor connection is unavailable.')) };
  } catch {
    provider = { available: false, checking: false, message: 'The tutor connection is unavailable here. Please try again shortly or use the fixed exercises at thequantobservatory.com.' };
  }
  updateConnection();
  render();
}
function updateConnection() {
  connection.className = `connection ${provider.available ? 'ready' : provider.checking ? '' : 'unavailable'}`;
  connection.querySelector('span').textContent = provider.checking ? 'Checking tutor connection' : provider.available ? 'TUTOR CONNECTED' : 'TUTOR NOT CONNECTED';
  connection.title = provider.message;
}
function downloadSession() {
  if (!session || pending) return;
  try {
    const blob = new Blob([exportSession(session)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `thinking-observatory-session-${new Date().toLocaleDateString('en-CA')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Session exported: conversation, skill map, and notes. Keep it somewhere private.');
  } catch { toast('The session could not be exported. Please try again.'); }
}
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || pending) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a tutor session file smaller than 2 MB.');
    const imported = parseSessionImport(await file.text());
    if (session && !confirm('Replace your current session with this imported conversation? Export the current session first if you want to keep both.')) return;
    stopVoice();
    session = imported;
    draft = '';
    errorMessage = '';
    lastRequest = null;
    persist();
    if (route() !== 'study') location.hash = 'study';
    else render();
    toast('Session restored. Continue with the question where you left off.');
  } catch (error) { toast(`${error.message} Your current session has been kept.`); }
});
function renderMethod() {
  main.innerHTML = `<article class="content-page"><a class="return-link" href="#study">← Return to your study room</a><p class="eyebrow" style="margin-top:30px">THE SOCRATIC METHOD</p><h1>Understanding is<br><em>something you do.</em></h1><p>This study room uses Jane Street’s open-source Socratic Tutor skill as instructions for the tutor during your learning session. Your responses shape the questions, the pace, and the path through the topic.</p>${methodSteps()}<h2>Reason first. Explain when needed.</h2><p>The tutor begins with 3–5 diagnostic questions without teaching the answers. It then proposes a map of concrete subskills and a place to begin. You can choose a different focus.</p><p>During learning, the tutor asks one question and waits. If your reasoning misses something, it should ask a narrower question before explaining directly. After an explanation, it checks the same idea from another angle. Correct answers may be challenged with a counterexample.</p><h2>Earn the next level.</h2><p>The map uses levels 0–5: from not yet evidenced to being able to teach a concept and handle edge cases. Progress requires multiple independent checks, including recall without a just-seen explanation. Earlier skills return for spaced review. Once the target levels are met, a mixed assessment connects the ideas.</p><h2>You can change the conversation.</h2><p>Use the controls below the answer box, or write “easier,” “harder,” “just tell me,” or “show progress.” Select a subskill in the map to request a different focus. Export your full session whenever you want to save or move it.</p><p>The tutor is an AI system and can make mistakes. Its feedback and skill estimates are learning aids. They are not a certification of mastery or interview readiness.</p><a class="button primary" href="#study">Enter your study room <span aria-hidden="true">→</span></a></article>`;
}
function renderSources() {
  main.innerHTML = `<article class="content-page"><a class="return-link" href="#study">← Return to your study room</a><p class="eyebrow" style="margin-top:30px">SOURCE NOTES & LIMITATIONS</p><h1>Good questions.<br><em>Clear foundations.</em></h1><p>The tutor’s teaching instructions are adapted from <a href="https://github.com/janestreet/agent_skills/blob/7c6715c29548a3b39d4a9545c698ee4fd17a7213/socratic-tutor/SKILL.md" target="_blank" rel="noopener noreferrer">Jane Street’s Socratic Tutor skill</a> in the <a href="https://github.com/janestreet/agent_skills" target="_blank" rel="noopener noreferrer">janestreet/agent_skills repository</a>. The skill is released under the MIT License, Copyright (c) 2026 Jane Street Group, LLC. The <a href="/licenses/jane-street-socratic-tutor.txt" target="_blank" rel="noopener noreferrer">full licence and copyright notice</a> is preserved.</p><p>This website is an independent adaptation. Jane Street does not endorse it. The skill’s licence applies to that material; it does not place a blanket MIT licence on the application or original curriculum.</p><h2>Public references for the fields of study</h2><p>These primary sources provide context and further reading. Tutor questions are generated for learning; they are not represented as actual interview questions or reproduced source exercises.</p><ul class="source-list">${sources.map(source => `<li><h2><a href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.title)} ↗</a></h2><p>${escapeHTML(source.note)}</p></li>`).join('')}</ul><h2>Your session & the model</h2><p>The tutor sends the selected topic, your goal, and conversation to OpenAI. The site owner pays for usage. Your session is saved in this browser under a separate tutor namespace. Older exercise progress is preserved separately. There is no shared learner database.</p><p>Exported files include your written answers and feedback. Import only your own session files. Imports are validated before replacing the active session. If browser storage is blocked or full, you can continue in memory and export before closing the tab.</p><p>AI judgments and calculations can be wrong. The skill map summarizes learning evidence; it does not certify competence. For fixed exercises without AI responses, visit thequantobservatory.com.</p><a class="button primary" href="#study">Return to learning <span aria-hidden="true">→</span></a></article>`;
}
function render() {
  document.querySelector('#study-nav').setAttribute('aria-current', ['study', 'home', ''].includes(route()) ? 'page' : 'false');
  if (route() === 'method') renderMethod();
  else if (route() === 'sources') renderSources();
  else if (route() === 'study' || route() === 'diagnostic' || route() === 'progress') renderStudy();
  else renderHome();
}
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  main.focus();
  main.scrollIntoView({ block: 'start' });
});
window.addEventListener('hashchange', () => {
  stopVoice();
  render();
  if (speakAfterNavigation) {
    speakAfterNavigation = false;
    if (route() === 'study' && session && readReplies) voice.speak(session.messages.filter(message => message.role === 'tutor').at(-1).text);
  }
});
window.addEventListener('pagehide', stopVoice);
window.addEventListener('keydown', event => { if (event.key === 'Escape') stopVoice(); });
render();
checkConnection();
