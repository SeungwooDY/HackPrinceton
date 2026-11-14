import React, { useState } from 'react';
import AerialQuizPanel from './AerialQuizPanel.jsx';
import { AERIAL_QUIZ_POINTS, loadAerialQuizAnswers, saveAerialQuizAnswers, parseAerialQuizFile, loadAerialQuizPoints, saveAerialQuizPoints } from './aerialQuiz.js';
import { gradeTagAnswer } from './tagStorage.js';
import { imageToOffset, offsetToImage } from './aerialHotspotPosition.js';

const storageKey = modelId => `aerial-hotspots:v1:${modelId}`;

export default function AerialHotspots({ modelId, width, disabled }) {
  const [notice, setNotice] = useState('');
  const [tags, setTags] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey(modelId)) || '[]');
      return Array.isArray(saved) ? saved.filter(tag => tag && typeof tag.id === 'string' && typeof tag.label === 'string' && typeof tag.description === 'string' && Number.isFinite(tag.east) && Number.isFinite(tag.north)) : [];
    } catch { return []; }
  });
  const [importedPoints, setImportedPoints] = useState(() => {
    try { return loadAerialQuizPoints(localStorage, modelId); } catch { return null; }
  });
  const points = importedPoints || AERIAL_QUIZ_POINTS;
  const [importError, setImportError] = useState('');
  const [selectedQuiz, setSelectedQuiz] = useState(null);
  const [answers, setAnswers] = useState(() => {
    try { return loadAerialQuizAnswers(localStorage, modelId, points); } catch { return {}; }
  });
  const completed = points.filter(point => gradeTagAnswer(point, answers[point.id]) === true).length;

  function replacePoints(next) {
    setImportedPoints(next);
    setSelectedQuiz(null);
    setDraft(null);
    setPlacing(false);
    setAnswers({});
    setImportError('');
    try {
      saveAerialQuizPoints(localStorage, modelId, next);
      saveAerialQuizAnswers(localStorage, modelId, {});
      setNotice(next ? `Imported ${next.length} quiz points. Zoom out if a point is outside this view.` : 'Restored default training quizzes.');
    } catch { setNotice('Quiz points loaded for this session, but browser storage could not save them.'); }
  }

  async function importPoints(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('Choose a JSON file smaller than 256 KB.');
      const next = parseAerialQuizFile(await file.text(), modelId);
      replacePoints(next);
    } catch (error) { setImportError(error.message || 'Unable to read quiz file.'); }
  }

  function downloadPoints() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, modelId, points }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `aerial-quizzes-${modelId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveAnswer(point, selectedIndex) {
    if (selectedIndex !== undefined && gradeTagAnswer(point, selectedIndex) === null) return;
    const next = { ...answers };
    if (selectedIndex === undefined) delete next[point.id];
    else next[point.id] = selectedIndex;
    setAnswers(next);
    try { saveAerialQuizAnswers(localStorage, modelId, next); setNotice(''); }
    catch { setNotice('Quiz progress is available for this session, but browser storage could not save it.'); }
  }

  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState(null);

  function persist(next) {
    setTags(next);
    try {
      localStorage.setItem(storageKey(modelId), JSON.stringify(next));
      setNotice('');
    } catch { setNotice('Hotspots are available for this session, but browser storage could not save them.'); }
  }

  function place(x, y) {
    setDraft({ id: crypto.randomUUID(), label: '', description: '', ...imageToOffset(x, y, width) });
    setPlacing(false);
  }

  return <>
    <div className="aerial-hotspot-actions">
      <button disabled={disabled} onClick={() => { setPlacing(value => !value); setDraft(null); setSelectedQuiz(null); }}>{placing ? 'Cancel placement' : '+ Add hotspot'}</button>
      <label className="aerial-quiz-import">Import quiz JSON<input type="file" accept=".json,application/json" disabled={disabled} onChange={importPoints}/></label>
      <button disabled={disabled} onClick={downloadPoints}>Export quiz JSON</button>
      {importedPoints && <button disabled={disabled} onClick={() => replacePoints(null)}>Use default quizzes</button>}
      <span className="aerial-quiz-progress" role="status">Quizzes: {completed}/{points.length} correct</span>
      {placing && <span role="status">Click the image to place a hotspot, or focus the image and press Enter for its center.</span>}
      {importError && <span role="alert">{importError}</span>}
      {notice && <span role="status">{notice}</span>}
    </div>
    {placing && <div className="aerial-placement-surface" role="button" tabIndex={0} aria-label="Place hotspot on aerial image" onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      place((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
    }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); place(0.5, 0.5); }
      if (event.key === 'Escape') setPlacing(false);
    }}/>} 
    {points.map((point, index) => {
      const { x, y } = offsetToImage(point, width);
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      const correct = gradeTagAnswer(point, answers[point.id]);
      return <button key={point.id} className={`aerial-hotspot aerial-quiz-hotspot ${correct === true ? 'is-complete' : ''}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} title={point.label}
        aria-label={`Open quiz: ${point.label}${correct === true ? ', completed' : ''}`} onClick={() => { setSelectedQuiz(point); setDraft(null); setPlacing(false); }}>
        <span aria-hidden="true">{correct === true ? '✓' : index + 1}</span><span className="aerial-hotspot-label">{point.label}</span>
      </button>;
    })}
    {selectedQuiz && <AerialQuizPanel imported={Boolean(importedPoints)} key={selectedQuiz.id} point={selectedQuiz} selectedIndex={answers[selectedQuiz.id]} onAnswer={index => saveAnswer(selectedQuiz, index)} onRetry={() => saveAnswer(selectedQuiz, undefined)} onClose={() => setSelectedQuiz(null)}/>}
    {tags.map(tag => {
      const { x, y } = offsetToImage(tag, width);
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return <button key={tag.id} className="aerial-hotspot" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} title={tag.label} aria-label={`Open hotspot: ${tag.label}`} onClick={() => { setDraft({ ...tag }); setPlacing(false); setSelectedQuiz(null); }}><span aria-hidden="true">●</span><span className="aerial-hotspot-label">{tag.label}</span></button>;
    })}
    {draft && <form className="aerial-hotspot-editor" aria-label="Aerial hotspot details" onSubmit={event => {
      event.preventDefault();
      if (!draft.label.trim()) return;
      persist([...tags.filter(tag => tag.id !== draft.id), { ...draft, label: draft.label.trim(), description: draft.description.trim() }]);
      setDraft(null);
    }}>
      <strong>{tags.some(tag => tag.id === draft.id) ? 'Hotspot details' : 'New hotspot'}</strong>
      <label>Label<input autoFocus required maxLength={100} value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })}/></label>
      <label>Notes<textarea rows={3} maxLength={1000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
      <p>Saved in this browser for this property.</p>
      <div><button type="submit">Save hotspot</button><button type="button" onClick={() => setDraft(null)}>Close</button>{tags.some(tag => tag.id === draft.id) && <button type="button" onClick={() => { persist(tags.filter(tag => tag.id !== draft.id)); setDraft(null); }}>Delete</button>}</div>
    </form>}
  </>;
}
