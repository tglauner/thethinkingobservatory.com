/** Completion requirements, shared by the visible map and tutor's next-turn plan. */
export const tutorCommand = text => /^(easier|harder|just tell me|show progress|save state)$/i.test(text.trim()) || /^focus:/i.test(text.trim());
export function learningProgress(session) {
  const target = /5|full mastery/i.test(session.goal) ? 5 : 4;
  const skills = session.skills.map(skill => {
    const failure = Math.max(-1, ...skill.evidence.filter(e => !e.correct).map(e => e.turn));
    const successes = skill.evidence.filter(e => e.correct && e.turn > failure && ['independent', 'recall', 'edge'].includes(e.kind));
    const recall = successes.some(e => e.kind === 'recall' && successes.some(p => p.turn <= e.turn - 3));
    const independent = skill.level >= 4;
    const mastered = skill.level >= 5;
    const steps = [
      { label: 'Solve a new problem independently', done: independent || successes.length > 0 },
      { label: 'Recall it correctly after other questions', done: independent || (new Set(successes.map(e => e.turn)).size >= 2 && recall) },
      ...(target === 5 ? [
        { label: 'Handle an edge case', done: mastered || successes.some(e => e.kind === 'edge') },
        { label: 'Explain the idea in your own words', done: mastered || skill.evidence.some(e => e.correct && e.kind === 'explanation' && e.turn > failure) },
      ] : []),
      { label: target === 5 ? 'Tutor confirms full mastery' : 'Tutor confirms independent use', done: skill.level >= target },
    ];
    if (session.phase === 'diagnostic') steps.forEach(step => { step.done = false; });
    return { id: skill.id, name: skill.name, steps, done: steps.filter(s => s.done).length, total: steps.length, complete: session.phase !== 'diagnostic' && skill.level >= target };
  });
  const messages = session.messages;
  const start = messages.findLastIndex(m => m.role === 'tutor' && m.text.startsWith('[Mixed assessment]'));
  const answerCount = list => list.filter(m => m.role === 'learner' && !tutorCommand(m.text)).length;
  const before = start < 0 ? Infinity : answerCount(messages.slice(0, start));
  const integrationTurns = [];
  for (let i = Math.max(0, start); i < messages.length - 1; i++) {
    if (messages[i].role === 'tutor' && messages[i].text.includes('[Integrative problem]') && messages[i + 1].role === 'learner' && !tutorCommand(messages[i + 1].text)) integrationTurns.push(answerCount(messages.slice(0, i + 2)));
  }
  const integrated = start >= 0 && integrationTurns.some(turn => session.skills.filter(s => s.evidence.some(e => e.turn === turn && e.correct && e.kind !== 'assisted')).length >= Math.min(2, skills.length));
  const assessment = session.skills.map(s => ({ label: `Final check: ${s.name}`, done: session.phase === 'complete' || s.evidence.some(e => e.correct && e.kind !== 'assisted' && e.turn > before) }));
  assessment.push({ label: 'Connect the ideas in one combined problem', done: session.phase === 'complete' || integrated });
  const diagnosticDone = session.phase !== 'diagnostic';
  const done = Number(diagnosticDone) + skills.reduce((n, s) => n + s.done, 0) + assessment.filter(s => s.done).length;
  const total = 1 + skills.reduce((n, s) => n + s.total, 0) + assessment.length;
  return { target, skills, assessment, diagnosticDone, done, total, remaining: total - done, readySkills: skills.filter(s => s.complete).length };
}
