import React, { useState } from 'react';
import { MODEL_CATALOG, parseModelId } from './modelCatalog.js';

export default function ModelSelection({ initialValue = '', onSelect }) {
  const [input, setInput] = useState(initialValue);
  const [error, setError] = useState('');
  function openModel(event) {
    event.preventDefault();
    const model = parseModelId(input);
    if (!model) { setError('Enter an 11-character model ID or a tour link containing a model ID.'); return; }
    setError('');
    onSelect(model);
  }
  return <main className="model-selection">
    <header className="selection-header"><span>FireSight</span></header>
    <div className="selection-content">
      <h1>Choose a model</h1>
      <p className="selection-description">Open a property to begin its walkthrough.</p>
      <ul className="selection-models" aria-label="Available models">
        {MODEL_CATALOG.map(model => <li key={model.id}>
          <div className="selection-model-info"><h2>{model.name}</h2><p>{model.type} · {model.detail}</p><code>{model.id}</code></div>
          <button type="button" onClick={() => onSelect(model.id)} aria-label={`Open model: ${model.name}`}>Open model <span aria-hidden="true">→</span></button>
        </li>)}
      </ul>
      <section className="selection-custom" aria-labelledby="custom-model-heading">
        <h2 id="custom-model-heading">Use another model</h2>
        <form onSubmit={openModel}>
          <div className="model-field"><label htmlFor="selection-model-id">Matterport model ID or tour link</label>
            <input id="selection-model-id" value={input} onChange={event => { setInput(event.target.value); if (error) setError(''); }} placeholder="Model ID or https://my.matterport.com/show/?m=…" autoComplete="off" spellCheck="false" required aria-invalid={Boolean(error)} aria-describedby={error ? 'selection-model-error' : undefined}/>
          </div>
          <button className="selection-open" type="submit">Open model</button>
        </form>
        {error && <p className="field-error" id="selection-model-error" role="alert">{error}</p>}
      </section>
    </div>
  </main>;
}
