import React, { useMemo, useState } from 'react';
import { resolveTask } from './taskImport.js';

export default function TaskImportPreview({ importedFile, modelId, sweeps, tags, busy, onCreate }) {
  const local = useMemo(() => importedFile.tasks.filter(task => task.modelId === modelId), [importedFile, modelId]);
  const scopes = useMemo(() => [...new Map(local.map(task => [task.scope, task.scopeName]))], [local]);
  const [scope, setScope] = useState(local[0]?.scope || '');
  const [excluded, setExcluded] = useState(new Set());
  const effectiveScope = scopes.some(([id]) => id === scope) ? scope : scopes[0]?.[0];
  const existing = new Set(tags.map(tag => tag.id));
  const rows = local.filter(task => task.scope === effectiveScope).map(task => ({ task, result: resolveTask(task, modelId, sweeps, existing) }));
  const selected = rows.filter(({ task, result }) => result.status === 'ready' && !excluded.has(task.id));
  function toggle(id) { setExcluded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  return <section className="task-import-preview" aria-label="Task import preview">
    <p className="import-title">Create sweep tasks from {importedFile.fileName}</p>
    <p className="import-note">Tasks without answer choices become fact-based quizzes when supported by the file, otherwise review checkpoints. Locations are unverified training checkpoints at sweep floor positions, not confirmed rooms, exits, or fixtures.</p>
    {scopes.length > 0 && <div className="scope-select"><label htmlFor="import-scope">Scenario floor</label><select id="import-scope" value={effectiveScope} onChange={e => setScope(e.target.value)}>{scopes.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>}
    {!local.length ? <p>No tasks in this file belong to the current model. Select a file model above.</p> : <>
      <p className="import-note">Showing one floor scenario at a time. Choosing a floor does not establish a match with the scan’s actual floor. {sweeps.size ? 'Sweep data received.' : 'Waiting for sweep data…'}</p>
      <ul className="import-task-list">{rows.map(({ task, result }) => <li key={task.id}><label className="import-task-choice"><input type="checkbox" disabled={busy || result.status !== 'ready'} checked={result.status === 'ready' && !excluded.has(task.id)} onChange={() => toggle(task.id)}/><span><strong>{task.title}</strong><span>{task.quiz ? task.quizOrigin === 'file' ? 'Quiz from file' : 'Quiz from recorded fact' : 'Review checkpoint'} · {result.reason}</span></span></label><details><summary>Task details</summary><p>{task.description || 'No task description supplied.'}</p><p>Model: <code>{task.modelId}</code><br/>Sweep: <code>{task.sweepId}</code></p>{task.quiz && <p>Question: {task.quiz.question}</p>}<ul>{task.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>{task.evidence.map((item, i) => <p key={i}>Quiz source: <code>{item.path}</code> — {String(item.value)}</p>)}</details></li>)}</ul>
      <button type="button" disabled={busy || selected.length === 0} onClick={() => onCreate(selected.map(({ task }) => task))}>{busy ? 'Please wait…' : `Create ${selected.length} sweep task${selected.length === 1 ? '' : 's'}`}</button>
      <p className="import-note">Already imported tasks are skipped. No operational actions or physical searches are verified by completing a quiz.</p>
    </>}
  </section>;
}
