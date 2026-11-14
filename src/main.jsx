import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MatterportViewer from './MatterportViewer.jsx';
import { installExporter } from './exportSweepGraph.js';
import { installExitMarker } from './exitMarker.js';
import './styles.css';

// Exposes window.exportSweepGraph() — run it in the console after a model loads
// to download the SweepGraph JSON for the planner. installExitMarker() adds an
// on-screen panel to mark door/window sweeps and download the graph with exits[].
installExporter();
installExitMarker();

const DEFAULT_MODEL = '85RkQcGH3oE';
const MODEL_ID = /^[a-zA-Z0-9]{11}$/;
const requestedModel = new URLSearchParams(window.location.search).get('model');
const initialModel = MODEL_ID.test(requestedModel || '') ? requestedModel : DEFAULT_MODEL;

function App() {
  const [modelId, setModelId] = useState(initialModel);
  const [input, setInput] = useState(initialModel);
  const [error, setError] = useState('');

  function loadModel(event) {
    event.preventDefault();
    const next = input.trim();
    if (!MODEL_ID.test(next)) {
      setError('Enter an 11-character Matterport model ID.');
      return;
    }
    setError('');
    setModelId(next);
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('model', next);
    window.history.replaceState({}, '', url);
  }

  return (
    <main className="app">
      <header className="toolbar">
        <h1>Matterport viewer</h1>
        <form onSubmit={loadModel}>
          <label htmlFor="model-id">Model ID</label>
          <input id="model-id" value={input} onChange={event => setInput(event.target.value)} spellCheck="false" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'model-error' : undefined}/>
          <button type="submit">Load model</button>
        </form>
      </header>
      {error && <p className="error" id="model-error" role="alert">{error}</p>}
      <MatterportViewer key={modelId} modelId={modelId}/>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
