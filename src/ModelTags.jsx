import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadTags, saveTags, surfacePosition, normalizeQuiz, gradeTagAnswer } from './tagStorage.js';
import { createTagWidget } from './tagWidget.js';
import TaskImportPreview from './TaskImportPreview.jsx';
import { resolveTask } from './taskImport.js';
import SweepQuestions from './SweepQuestions.jsx';
import { questionsAtSweep, sweepIds } from './sweepQuestions.js';

export default function ModelTags({ sdk, modelId, importedFile, onShowViewer, overlayTarget, onComplete }) {
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
  const [sweeps, setSweeps] = useState(new Map());
  const [currentSweepIds, setCurrentSweepIds] = useState([]);
  const [taskRequest, setTaskRequest] = useState(null);
  const activatedDemo = useRef(null);
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
      color: tag.importedTask ? { r: 0.25, g: 0.45, b: 0.8 } : { r: 0.7, g: 0.55, b: 0.35 },
    });
    if (!sdkId) throw new Error('No tag ID returned.');
    if (!alive.current) { await sdk.Tag.remove(sdkId); return null; }
    runtime.current.set(tag.id, sdkId);
    // Imported/quiz checkpoints get a visible native marker (tag.label is the
    // order-blind "Checkpoint N" wayfinding name) purely so a trainee can see
    // where they are from a distance. The quiz itself still only triggers via
    // the proximity-based SweepQuestions overlay below -- no interactive
    // widget is attached here, so the marker itself isn't a second way to answer.
    if (tag.importedTask) return sdkId;
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
    let sweepSubscription;
    let currentSweepSubscription;
    let sweepTimer;
    const sweepIndex = new Map();
    function updateSweep(item, removed = false) {
      if (!item) return;
      for (const id of [item.id, item.sid, item.uuid].filter(Boolean)) {
        if (removed || item.enabled === false) sweepIndex.delete(id);
        else sweepIndex.set(id, item);
      }
      clearTimeout(sweepTimer);
      sweepTimer = setTimeout(() => { if (alive.current) setSweeps(new Map(sweepIndex)); }, 75);
    }
    async function initialize() {
      try {
        if (!sdk.Tag?.add || !sdk.Pointer?.intersection?.subscribe) throw new Error('Tag editing is unavailable in this SDK.');
        currentSweepSubscription = sdk.Sweep.current.subscribe(sweep => {
          if (alive.current) setCurrentSweepIds(sweepIds(sweep));
        });
        if (sdk.Sweep?.data?.subscribe) {
          sweepSubscription = sdk.Sweep.data.subscribe({
            onAdded: (_index, item) => updateSweep(item),
            onUpdated: (_index, item) => updateSweep(item),
            onRemoved: (_index, item) => updateSweep(item, true),
          });
        }
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
      clearTimeout(sweepTimer);
      pointerSubscription?.cancel?.();
      sweepSubscription?.cancel?.();
      currentSweepSubscription?.cancel?.();
      const ids = [...runtime.current.values()];
      runtime.current.clear();
      if (ids.length) sdk.Tag.remove(...ids).catch(() => {});
    };
  }, [sdk, modelId]);

  async function importTasks(tasks) {
    if (busy) return;
    setBusy(true); setError('');
    let added = 0, skipped = 0, failed = 0;
    let firstAdded;
    try {
      for (const task of tasks) {
        if (!alive.current) return;
        const resolved = resolveTask(task, modelId, sweeps, new Set(saved.current.map(tag => tag.id)));
        if (resolved.status !== 'ready') { skipped += 1; continue; }
        try {
          const sdkId = await installTag(resolved.tag);
          if (!alive.current) return;
          if (!sdkId) { failed += 1; continue; }
          persist([...saved.current, resolved.tag]);
          firstAdded ||= resolved.tag;
          added += 1;
        } catch { failed += 1; }
      }
      if (alive.current) {
        setMessage(`Created ${added} sweep task(s). ${skipped} skipped; ${failed} failed. Questions open at their assigned sweeps. Floor and suite mapping remain unverified.`);
        if (failed) setError('Some tags could not be created. Successful tags were saved; retry to import the remaining tasks.');
        if (firstAdded) await goToTask(firstAdded);
      }
    } finally { if (alive.current) setBusy(false); }
  }

  useEffect(() => {
    if (!importedFile?.autoActivate || busy || sweeps.size === 0) return;
    const localTasks = importedFile.tasks.filter(task => task.modelId === modelId);
    if (!localTasks.length) return;
    const freshDrill = activatedDemo.current?.file !== importedFile;
    // On a fresh drill, ignore any persisted copies so the latest quiz content
    // (scores, text) replaces stale localStorage tags and answers start clean.
    const existing = freshDrill ? new Set() : new Set(saved.current.map(tag => tag.id));
    const resolved = localTasks.map(task => ({task, result: resolveTask(task, modelId, sweeps, existing)}));
    const available = resolved.filter(({result}) => result.status === 'ready' || result.status === 'existing');
    if (available.length === 0) {
      setMessage('Questions are waiting for their assigned sweeps in this scan.');
      return;
    }
    if (freshDrill) activatedDemo.current = {file: importedFile, navigated: false};
    const additions = resolved.filter(({result}) => result.status === 'ready').map(({result}) => result.tag);
    // Fresh drill: drop old copies of these questions, then add the fresh tags.
    const importedIds = new Set(localTasks.map(task => task.id));
    const base = freshDrill ? saved.current.filter(tag => !importedIds.has(tag.id)) : saved.current;
    if (additions.length || freshDrill) persist([...base, ...additions]);
    setMessage(`${available.length} question(s) active.${available.length < localTasks.length ? ' Waiting for the remaining sweep IDs.' : ''}`);
    const first = saved.current.find(tag => tag.id === available[0].task.id);
    if (first && !activatedDemo.current.navigated) {activatedDemo.current.navigated = true;goToTask(first);}
  }, [importedFile, busy, sweeps, modelId]);

  // Remove a checkpoint's visible 3D marker once it's been answered/reviewed --
  // manual (non-imported) tags are untouched, they're meant to persist.
  useEffect(() => {
    for (const tag of tags) {
      if (!tag.importedTask) continue;
      const completed = tag.quiz ? tag.quizResult != null : tag.reviewed;
      if (!completed) continue;
      const sdkId = runtime.current.get(tag.id);
      if (sdkId) {
        runtime.current.delete(tag.id);
        sdk.Tag.remove(sdkId).catch(() => {});
      }
    }
  }, [tags, sdk]);

  // Drill complete when every imported quiz question has been answered.
  useEffect(() => {
    if (!onComplete) return;
    const quizTags = tags.filter(tag => tag.importedTask && tag.quiz);
    if (quizTags.length && quizTags.every(tag => tag.quizResult != null)) {
      onComplete({
        score: quizTags.reduce((sum, tag) => sum + (tag.quizPoints ?? 0), 0),
        maxScore: quizTags.length * 3,
        count: quizTags.length,
      });
    }
  }, [tags, onComplete]);

  async function goToTask(tag) {
    try {
      await sdk.Sweep.moveTo(tag.importedTask.sweepId, {});
      if (alive.current) { onShowViewer?.(); await openTag(tag); }
    } catch { if (alive.current) setError('Could not move to this task’s sweep. Check the model and sweep access.'); }
  }

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
    if (tag.importedTask) {
      setTaskRequest(previous => ({id: tag.id, sequence: (previous?.sequence || 0)+1}));
      return;
    }
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

  function answerTask(task, selectedIndex) {
    const current = saved.current.find(item => item.id === task.id);
    // One shot: once answered it locks. No correctness feedback, no reset.
    if (!current || current.quizResult != null || !questionsAtSweep([current], modelId, currentSweepIds).length) return;
    const quiz = normalizeQuiz(current.quiz);
    if (!quiz || !Number.isInteger(selectedIndex)) return;
    const points = quiz.scores?.[selectedIndex] ?? 0;
    persist(saved.current.map(item => item.id === current.id
      ? {...item, reviewed: true, quizResult: 'answered', quizPoints: points, quizChoice: selectedIndex}
      : item));
  }
  function reviewTask(task) {
    if (!questionsAtSweep([task], modelId, currentSweepIds).length) return;
    persist(saved.current.map(item => item.id === task.id ? {...item, reviewed: true} : item));
  }
  function resetTask(task) {
    if (!questionsAtSweep([task], modelId, currentSweepIds).length) return;
    persist(saved.current.map(item => item.id === task.id ? {...item, reviewed: false, quizResult: null} : item));
  }
  const demoIds = importedFile?.autoActivate ? new Set(importedFile.tasks.map(task => task.id)) : null;
  // Once a question is answered (or a review checkpoint reviewed) it drops out,
  // so Confirm makes the panel disappear / advance to the next question here.
  const currentTasks = questionsAtSweep(demoIds ? tags.filter(tag => demoIds.has(tag.id)) : tags, modelId, currentSweepIds)
    .filter(task => (task.quiz ? task.quizResult == null : !task.reviewed));

  return <details className="tag-editor" open={!importedFile?.autoActivate}>
    <summary>Questions & tags ({tags.length})</summary>
    {overlayTarget && currentTasks.length > 0 && createPortal(<SweepQuestions key={currentSweepIds.join(':')} tasks={currentTasks} request={taskRequest} onAnswer={answerTask} onReview={reviewTask} onReset={resetTask}/>, overlayTarget)}
    {tags.some(tag => tag.importedTask) && <p>Imported questions appear automatically at their assigned sweep and disappear when you leave it. Manual tags remain clickable.</p>}
    {importedFile && !importedFile.autoActivate && <TaskImportPreview key={`${importedFile.fileName}-${modelId}`} importedFile={importedFile} modelId={modelId} sweeps={sweeps} tags={tags} busy={busy || captureSeconds > 0} onCreate={importTasks}/>}
    <details className="manual-tag-editor" open={!importedFile}>
    <summary>Add a tag manually</summary>
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
    </details>
    <p className="tag-message" role="status">{message}</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    {tags.length > 0 && <ul className="tag-list">{tags.map(tag => <li key={tag.id}><div><strong>{tag.label}</strong><span>{tag.quiz ? tag.quizResult === 'answered' ? `Answered (+${tag.quizPoints ?? 0})` : tag.quizResult === 'correct' ? 'Quiz complete' : tag.quizResult === 'incorrect' ? 'Quiz: try again' : 'Quiz not answered' : tag.reviewed ? 'Reviewed' : 'Not reviewed'}</span>{tag.importedTask && <span>Imported task · floor/suite mapping unverified</span>}</div>{tag.importedTask && <button disabled={busy} onClick={() => goToTask(tag)}>Go to task</button>}{!tag.importedTask && <button disabled={busy} onClick={() => openTag(tag)}>Open</button>}<button disabled={busy} onClick={() => removeTag(tag)}>Remove</button></li>)}</ul>}
    <p className="tag-storage-note">Tags are saved in this browser for this model. They do not change the original Matterport model.</p>
  </details>;
}
