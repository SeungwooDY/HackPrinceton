import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MatterportViewer from './MatterportViewer.jsx';
import TaskFileInput from './TaskFileInput.jsx';
import { loadQuizFile } from './quizSource.js';
import { installExporter } from './exportSweepGraph.js';
import { installExitMarker } from './exitMarker.js';
import './styles.css';

// Dev helpers: window.exportSweepGraph() for the SweepGraph export, and the
// on-screen exit-marker panel for designating door/window sweeps.
installExporter();
installExitMarker();

const DEFAULT_MODEL = 'KBqHB8Xq9Vo';
const MODEL_ID = /^[a-zA-Z0-9]{11}$/;
const requestedModel = new URLSearchParams(window.location.search).get('model');
const initialModel = MODEL_ID.test(requestedModel || '') ? requestedModel : DEFAULT_MODEL;

function App() {
  const [modelId, setModelId] = useState(initialModel);
  const [input, setInput] = useState(initialModel);
  const [error, setError] = useState('');
  const [importedFile, setImportedFile] = useState(null);
  const [customFile, setCustomFile] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('model', modelId);
    window.history.replaceState({}, '', url);
  }, [modelId]);
  // Pull this model's questions from the server (/api/quiz), unless the user has
  // loaded a custom task file.
  useEffect(() => {
    if (customFile) return undefined;
    let live = true;
    loadQuizFile(modelId)
      .then(file => { if (live) setImportedFile(file); })
      .catch(() => { if (live) setImportedFile(null); });
    return () => { live = false; };
  }, [modelId, customFile]);

  function selectModel(next) {
    if (!MODEL_ID.test(next)) return;
    setInput(next);
    setError('');
    setModelId(next);
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('model', next);
    window.history.replaceState({}, '', url);
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

  return (
    <main className="app">
      <header className="app-header">
        <p className="app-title">Matterport viewer</p>
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
      <MatterportViewer key={modelId} modelId={modelId} importedFile={importedFile}/>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
