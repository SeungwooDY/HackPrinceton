import React, { useState } from 'react';
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
      <button disabled={disabled} onClick={() => { setPlacing(value => !value); setDraft(null); }}>{placing ? 'Cancel placement' : '+ Add hotspot'}</button>
      {placing && <span role="status">Click the image to place a hotspot, or focus the image and press Enter for its center.</span>}
      {notice && <span role="status">{notice}</span>}
    </div>
    {placing && <div className="aerial-placement-surface" role="button" tabIndex={0} aria-label="Place hotspot on aerial image" onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      place((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
    }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); place(0.5, 0.5); }
      if (event.key === 'Escape') setPlacing(false);
    }}/>} 
    {tags.map(tag => {
      const { x, y } = offsetToImage(tag, width);
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return <button key={tag.id} className="aerial-hotspot" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} title={tag.label} aria-label={`Open hotspot: ${tag.label}`} onClick={() => { setDraft({ ...tag }); setPlacing(false); }}><span aria-hidden="true">●</span><span className="aerial-hotspot-label">{tag.label}</span></button>;
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
