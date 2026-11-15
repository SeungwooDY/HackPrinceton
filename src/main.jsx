import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ModelSelection from './ModelSelection.jsx';
import TaskFileInput from './TaskFileInput.jsx';
import { loadQuizFile } from './quizSource.js';
import { installExporter } from './exportSweepGraph.js';
import { installExitMarker } from './exitMarker.js';
import './styles.css';

const MatterportViewer = lazy(() => import('./MatterportViewer.jsx'));

const DEFAULT_MODEL = 'KBqHB8Xq9Vo';
const MODEL_ID = /^[a-zA-Z0-9]{11}$/;
const requestedModel = new URLSearchParams(window.location.search).get('model');
const initialModel = MODEL_ID.test(requestedModel || '') ? requestedModel : DEFAULT_MODEL;

function App() {
  const [screen, setScreen] = useState('selection');
  const [modelId, setModelId] = useState(initialModel);
  const [input, setInput] = useState(initialModel);
  const [error, setError] = useState('');
  const [importedFile, setImportedFile] = useState(null);
  const [customFile, setCustomFile] = useState(false);
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, screen: 'selection' }, '', window.location.href);
    function restoreScreen(event) {
      const id = new URLSearchParams(window.location.search).get('model');
      const valid = MODEL_ID.test(id || '');
      if (valid) { setModelId(id); setInput(id); }
      setScreen(event.state?.screen === 'viewer' && valid ? 'viewer' : 'selection');
      setCustomFile(false);
      setImportedFile(null);
      setError('');
    }
    window.addEventListener('popstate', restoreScreen);
    return () => window.removeEventListener('popstate', restoreScreen);
  }, []);
  useEffect(() => {
    if (screen !== 'viewer') return undefined;
    const removeExporter = installExporter();
    const removeExitMarker = installExitMarker();
    return () => { removeExitMarker?.(); removeExporter?.(); };
  }, [screen, modelId]);
  // Pull this model's questions from the server (/api/quiz), unless the user has
  // loaded a custom task file.
  useEffect(() => {
    if (customFile || screen !== 'viewer') return undefined;
    let live = true;
    loadQuizFile(modelId)
      .then(file => { if (live) setImportedFile(file); })
      .catch(() => { if (live) setImportedFile(null); });
    return () => { live = false; };
  }, [modelId, customFile, screen]);

  function selectModel(next) {
    if (!MODEL_ID.test(next)) return;
    setInput(next);
    setError('');
    if (next !== modelId && !customFile) setImportedFile(null);
    setModelId(next);
    setScreen('viewer');
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('model', next);
    window.history.pushState({ screen: 'viewer' }, '', url);
  }

  function chooseFromLanding(next) {
    setImportedFile(null);
    setCustomFile(false);
    selectModel(next);
  }

  function chooseAnotherModel() {
    setScreen('selection');
    setError('');
    const url = new URL(window.location.href);
    url.searchParams.delete('model');
    window.history.pushState({ screen: 'selection' }, '', url);
    window.scrollTo({ top: 0 });
  }

  function loadModel(event) {
    event.preventDefault();
    const next = input.trim();
    if (!MODEL_ID.test(next)) {
      setError('Enter an 11-character Matterport model ID.');
      return;
    }
    selectModel(next);
  }

  if (screen === 'selection') return <ModelSelection initialValue={modelId} onSelect={chooseFromLanding}/>;

  return (
    <main className="app">
      <header className="app-header">
        <p className="app-title">FireSight</p><button type="button" className="choose-model-button" onClick={chooseAnotherModel}>← Choose another model</button>
      </header>
      <div className="model-controls">
        <form onSubmit={loadModel} aria-label="Select model">
          <div className="model-field">
            <label htmlFor="model-id">Model ID</label>
            <input id="model-id" value={input} onChange={event => setInput(event.target.value)} spellCheck="false" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'model-error' : undefined}/>
          </div>
          <button type="submit">Load model</button>
        </form>
        {error && <p className="field-error" id="model-error" role="alert">{error}</p>}
      </div>
      <p className="demo-file-status">{customFile ? 'Using a custom task file.' : 'Questions loaded from the server for this model. The viewer moves to the first checkpoint once sweep data is ready.'}</p>
      <details className="custom-task-file"><summary>Use a different task file</summary><TaskFileInput importedFile={importedFile} onImport={file => { setImportedFile(file); setCustomFile(true); }} onClear={() => setCustomFile(false)} modelId={modelId} onModelChange={selectModel}/></details>
      <Suspense fallback={<p className="viewer-loading" role="status">Opening walkthrough…</p>}><MatterportViewer key={modelId} modelId={modelId} importedFile={importedFile}/></Suspense>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
