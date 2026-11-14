import React, { useRef, useState } from 'react';
import { parseTaskDocument } from './taskImport.js';

export default function TaskFileInput({ importedFile, onImport, onClear, modelId, onModelChange }) {
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  const input = useRef(null);
  async function readFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const request = ++sequence.current;
    setError(''); setReading(true);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Choose a JSON file smaller than 2 MB.');
      const parsed = parseTaskDocument(await file.text(), file.name);
      if (sequence.current !== request) return;
      onImport(parsed);
      if (!parsed.models.includes(modelId)) onModelChange(parsed.models[0]);
    } catch (failure) { if (sequence.current === request) setError(failure.message || 'Unable to read this file.'); }
    finally { if (sequence.current === request) setReading(false); }
  }
  return <section className="task-file-input" aria-label="Import task file">
    <label htmlFor="task-file">Task JSON file</label>
    <input ref={input} id="task-file" type="file" accept=".json,application/json,text/plain" onChange={readFile}/>
    {reading && <p role="status">Reading file…</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {importedFile && <div className="task-file-summary">
      <p>{importedFile.fileName} · {importedFile.tasks.length} parsed tasks. Select tasks below once the model connects.</p>
      <div><label htmlFor="task-file-model">File model</label><select id="task-file-model" value={importedFile.models.includes(modelId) ? modelId : ''} onChange={e => onModelChange(e.target.value)}>{!importedFile.models.includes(modelId) && <option value="" disabled>Select a file model</option>}{importedFile.models.map(id => <option value={id} key={id}>{id}</option>)}</select><button type="button" onClick={() => {sequence.current += 1; setReading(false); onClear(); setError(''); if (input.current) input.current.value = '';}}>Clear file</button></div>
      {importedFile.issues.length > 0 && <details><summary>{importedFile.issues.length} skipped or invalid entries</summary><ul>{importedFile.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
    </div>}
  </section>;
}
