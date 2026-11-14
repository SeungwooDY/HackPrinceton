import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MatterportViewer from './MatterportViewer.jsx';
import './styles.css';

const DEFAULT_MODEL = 'KBqHB8Xq9Vo';
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
      <MatterportViewer key={modelId} modelId={modelId}/>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App/>);
