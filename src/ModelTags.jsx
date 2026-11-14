import React, { useEffect, useRef, useState } from 'react';
import { loadTags, saveTags, surfacePosition, normalizeQuiz, gradeTagAnswer } from './tagStorage.js';
import { createTagWidget } from './tagWidget.js';

export default function ModelTags({ sdk, modelId }) {
  const [tags, setTags] = useState([]);
  const [label, setLabel] = useState('Training point');
  const [description, setDescription] = useState('Inspect this location.');
  const [taskType, setTaskType] = useState('quiz');
  const [question, setQuestion] = useState('What is the purpose of this marker?');
  const [options, setOptions] = useState(['A training checkpoint', 'A camera position', 'A verified exit']);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [target, setTarget] = useState(null);
  const [captureSeconds, setCaptureSeconds] = useState(0);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('Restoring saved tags…');
  const [error, setError] = useState('');
  const point = useRef(null);
  const runtime = useRef(new Map());
  const saved = useRef([]);
  const alive = useRef(true);
  const captureTimer = useRef(null);
  const captureRemaining = useRef(0);

  function persist(next) {
    saved.current = next;
    setTags(next);
    try { saveTags(window.localStorage, modelId, next); }
    catch { setError('The tag works for this session, but browser storage is unavailable. It may not survive a refresh.'); }
  }

  async function installTag(tag) {
    const [sdkId] = await sdk.Tag.add({
      label: tag.label, description: tag.description,
      anchorPosition: tag.anchorPosition, stemVector: tag.stemVector,
      color: { r: 0.7, g: 0.55, b: 0.35 },
    });
    if (!sdkId) throw new Error('No tag ID returned.');
    if (!alive.current) { await sdk.Tag.remove(sdkId); return null; }
    runtime.current.set(tag.id, sdkId);
    // The native tag still works if this SDK does not support custom attachments.
    try {
      const widget = createTagWidget(tag);
      const [attachmentId, messenger] = await sdk.Tag.registerSandbox(widget, {
        name: tag.quiz ? 'Checkpoint quiz' : 'Training point', size: { w: 320, h: tag.quiz ? 430 : 210 },
      });
      if (!alive.current) return null;
      messenger.on('review', () => {
        if (!alive.current) return;
        persist(saved.current.map(item => item.id === tag.id ? { ...item, reviewed: true } : item));
        setMessage(`Reviewed: ${tag.label}`);
      });
      messenger.on('answer', payload => {
        if (!alive.current) return;
        const current = saved.current.find(item => item.id === tag.id);
        if (!current) return;
        const correct = gradeTagAnswer(current, payload?.selectedIndex);
        if (correct === null) return;
        persist(saved.current.map(item => item.id === tag.id ? { ...item, reviewed: correct, quizResult: correct ? 'correct' : 'incorrect' } : item));
        setMessage(`${correct ? 'Correct answer' : 'Try again'}: ${tag.label}`);
      });
      messenger.on('resetQuiz', () => {
        if (!alive.current) return;
        persist(saved.current.map(item => item.id === tag.id ? { ...item, reviewed: false, quizResult: null } : item));
        setMessage(`Quiz reset: ${tag.label}`);
      });
      await sdk.Tag.attach(sdkId, attachmentId);
    } catch {
      if (alive.current) setError('Tag added, but its interactive content could not load. The label and note are still available.');
    }
    return sdkId;
  }

  useEffect(() => {
    alive.current = true;
    let pointerSubscription;
    async function initialize() {
      try {
        if (!sdk.Tag?.add || !sdk.Pointer?.intersection?.subscribe) throw new Error('Tag editing is unavailable in this SDK.');
        pointerSubscription = sdk.Pointer.intersection.subscribe(hit => {
          if (!alive.current || captureRemaining.current === 0 || hit.object !== sdk.Pointer.Colliders.MODEL) return;
          const position = surfacePosition(hit);
          if (!position) return;
          point.current = position;
        });
        let restored = [];
        try { restored = loadTags(window.localStorage, modelId); }
        catch { setError('Saved tags could not be read. You can add tags for this session.'); }
        saved.current = restored;
        setTags(restored);
        let failed = 0;
        for (const tag of restored) {
          if (!alive.current) return;
          try { await installTag(tag); } catch { failed += 1; }
        }
        if (!alive.current) return;
        setMessage(restored.length ? `${restored.length - failed} saved tag(s) restored.` : 'No tags saved for this model.');
        if (failed) setError(`${failed} saved tag(s) could not be restored. Reload the viewer to retry.`);
      } catch {
        if (alive.current) setError('Tag editing is unavailable. Check that this SDK supports tags and pointer intersections.');
      } finally { if (alive.current) setBusy(false); }
    }
    initialize();
    return () => {
      alive.current = false;
      clearInterval(captureTimer.current);
      pointerSubscription?.cancel?.();
      const ids = [...runtime.current.values()];
      runtime.current.clear();
      if (ids.length) sdk.Tag.remove(...ids).catch(() => {});
    };
  }, [sdk, modelId]);

  function choosePosition() {
    clearInterval(captureTimer.current);
    point.current = null;
    setTarget(null);
    setError('');
    captureRemaining.current = 5;
    setCaptureSeconds(5);
    setMessage('Move the pointer onto a wall or floor inside the walkthrough and hold it there until the countdown ends.');
    captureTimer.current = setInterval(() => {
      captureRemaining.current -= 1;
      setCaptureSeconds(captureRemaining.current);
      if (captureRemaining.current === 0) {
        clearInterval(captureTimer.current);
        setTarget(point.current);
        setMessage(point.current ? 'Position captured. Click Add tag to place the marker.' : 'No surface captured. Choose position again and point inside the walkthrough.');
      }
    }, 1000);
  }

  async function addTag(event) {
    event.preventDefault();
    if (!target || !label.trim() || busy) return;
    const quiz = taskType === 'quiz' ? normalizeQuiz({ question, options, correctIndex }) : null;
    if (taskType === 'quiz' && !quiz) { setError('Enter a question, three answer choices, and a correct answer.'); return; }
    if (quiz && new Set(quiz.options.map(option => option.toLowerCase())).size !== quiz.options.length) { setError('Use a different answer for each choice.'); return; }
    const tag = { id: crypto.randomUUID(), label: label.trim(), description: description.trim(), ...target, reviewed: false, quiz, quizResult: null };
    setBusy(true); setError('');
    try {
      const sdkId = await installTag(tag);
      if (!alive.current || !sdkId) return;
      persist([...saved.current, tag]);
      setMessage(`Added: ${tag.label}. Click the marker in the model to open it.`);
      try { await sdk.Tag.open(sdkId); } catch { /* It can still be opened manually. */ }
    } catch { if (alive.current) setError('Could not create the tag. Point at a model surface and try again.'); }
    finally { if (alive.current) setBusy(false); }
  }

  async function openTag(tag) {
    const id = runtime.current.get(tag.id);
    if (!id) { setError('This tag was not restored. Reload the viewer to retry.'); return; }
    try { await sdk.Tag.open(id); } catch { setError('Could not open this tag. Try clicking its marker in the model.'); }
  }

  async function removeTag(tag) {
    setBusy(true); setError('');
    try {
      const id = runtime.current.get(tag.id);
      if (id) await sdk.Tag.remove(id);
      if (!alive.current) return;
      runtime.current.delete(tag.id);
      persist(saved.current.filter(item => item.id !== tag.id));
      setMessage(`Removed: ${tag.label}`);
    } catch { if (alive.current) setError('Could not remove the tag. Try again.'); }
    finally { if (alive.current) setBusy(false); }
  }

  return <details className="tag-editor" open>
    <summary>Model tags ({tags.length})</summary>
    <p>Choose a task and enter its content. Click “Choose position”, then point at a wall or floor in the walkthrough until the five-second countdown ends. Click “Add tag” to place it.</p>
    <form className="tag-form" onSubmit={addTag}>
      <div><label htmlFor="tag-label">Label</label><input id="tag-label" value={label} maxLength={100} required onChange={e => setLabel(e.target.value)}/></div>
      <div className="tag-note-field"><label htmlFor="tag-note">Note</label><input id="tag-note" value={description} maxLength={1000} onChange={e => setDescription(e.target.value)}/></div>
      <div className="tag-task-type"><label htmlFor="tag-task-type">Task</label><select id="tag-task-type" value={taskType} onChange={e => setTaskType(e.target.value)}><option value="quiz">Quiz question</option><option value="review">Review checkpoint</option></select></div>
      {taskType === 'quiz' && <fieldset className="quiz-fields"><legend>Quiz content</legend>
        <div className="quiz-question-field"><label htmlFor="tag-question">Question</label><input id="tag-question" required maxLength={300} value={question} onChange={e => setQuestion(e.target.value)}/></div>
        {options.map((option, index) => <div key={index}><label htmlFor={`tag-option-${index}`}>Answer {String.fromCharCode(65 + index)}</label><input id={`tag-option-${index}`} required maxLength={150} value={option} onChange={e => setOptions(values => values.map((value, i) => i === index ? e.target.value : value))}/></div>)}
        <div><label htmlFor="tag-correct">Correct answer</label><select id="tag-correct" value={correctIndex} onChange={e => setCorrectIndex(Number(e.target.value))}>{options.map((option, index) => <option key={index} value={index}>{String.fromCharCode(65 + index)}: {option || '(empty)'}</option>)}</select></div>
      </fieldset>}
      <button disabled={busy || captureSeconds > 0} type="button" onClick={choosePosition}>{captureSeconds > 0 ? `Point at surface (${captureSeconds}s)` : 'Choose position'}</button>
      <button disabled={busy || !target || !label.trim()} type="submit">{busy ? 'Please wait…' : 'Add tag'}</button>
    </form>
    <p className="tag-position">{target ? `Captured position: ${['x', 'y', 'z'].map(axis => `${axis} ${target.anchorPosition[axis].toFixed(2)}`).join(', ')}` : 'No position selected.'}</p>
    <p className="tag-message" role="status">{message}</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {tags.length > 0 && <ul className="tag-list">{tags.map(tag => <li key={tag.id}><div><strong>{tag.label}</strong><span>{tag.quiz ? tag.quizResult === 'correct' ? 'Quiz complete' : tag.quizResult === 'incorrect' ? 'Quiz: try again' : 'Quiz not answered' : tag.reviewed ? 'Reviewed' : 'Not reviewed'}</span></div><button disabled={busy} onClick={() => openTag(tag)}>Open</button><button disabled={busy} onClick={() => removeTag(tag)}>Remove</button></li>)}</ul>}
    <p className="tag-storage-note">Tags are saved in this browser for this model. They do not change the original Matterport model.</p>
  </details>;
}
