import React, { useEffect, useRef, useState } from 'react';
import { createObstacleScene } from './obstacleScene.js';

export default function ObstacleControls({ sdk, modelId, interior, onShowViewer }) {
  const controller = useRef(null);
  const sweep = useRef(null);
  const alive = useRef(true);
  const [ready, setReady] = useState(false);
  const [inside, setInside] = useState(false);
  const [type, setType] = useState('barricade');
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Preparing 3D obstacle renderer…');
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState(false);
  const [captureSeconds, setCaptureSeconds] = useState(0);
  const captureTimer = useRef(null);
  const target = useRef(null);
  const key = `training-obstacles:v1:${modelId}`;
  function persist(next) {
    setItems(next);
    try { localStorage.setItem(key, JSON.stringify(next)); }
    catch { setError('Obstacles work for this session, but browser storage could not save them.'); }
  }

  useEffect(() => {
    alive.current = true;
    let scene;
    const pointerSub = sdk.Pointer?.intersection?.subscribe(hit => {
      if (hit.object === sdk.Pointer.Colliders.MODEL && hit.normal?.y > .6 && ['x', 'y', 'z'].every(axis => Number.isFinite(hit.position?.[axis]))) target.current = { ...hit.position };
    });
    const sub = sdk.Sweep.current.subscribe(current => {
      sweep.current = current;
      if (alive.current) setInside(Boolean(current.sid));
    });
    async function initialize() {
      try {
        scene = await createObstacleScene(sdk);
        if (!alive.current) { scene.dispose(); return; }
        controller.current = scene;
        let saved = [];
        try {
          const raw = JSON.parse(localStorage.getItem(key) || '[]');
          if (Array.isArray(raw)) saved = raw.filter(item => item && typeof item.id === 'string' && ['barricade', 'cone', 'debris'].includes(item.type) && ['x', 'y', 'z'].every(axis => Number.isFinite(item.position?.[axis])) && Number.isFinite(item.yaw)).slice(0, 30);
        } catch { /* Start fresh if browser storage is unavailable. */ }
        const restored = [];
        for (const item of saved) {
          if (!alive.current) return;
          restored.push(await scene.add(item));
        }
        if (!alive.current) return;
        setItems(restored);
        setReady(true);
        setMessage(restored.length ? `Restored ${restored.length} 3D obstacle(s).` : 'Enter the walkthrough, face the path, then add an obstacle.');
      } catch (failure) { if (alive.current) { setError(failure.message); setMessage('3D obstacle renderer unavailable.'); } }
    }
    initialize();
    return () => { alive.current = false; sub.cancel(); pointerSub?.cancel?.(); clearInterval(captureTimer.current); scene?.dispose(); controller.current = null; };
  }, [sdk, key]);

  useEffect(() => {
    if (!interior || !inside) { clearInterval(captureTimer.current); setCaptureSeconds(0); }
  }, [interior, inside]);

  async function add(position) {
    if (!controller.current || !sweep.current?.sid || busy) return;
    setBusy(true); setError(''); setMessage('Attaching obstacle to the 3D scene…');
    try {
      const item = await controller.current.add({ type, sweepId: sweep.current.sid, floorY: sweep.current.puckPosition?.y, ...(position ? { position: { x: position.x, y: position.y + .03, z: position.z }, yaw: 0 } : {}) });
      if (!alive.current) return;
      persist([...items, item]);
      setMessage(position ? `${type} attached at the captured floor position.` : `${type} attached 1.5 m ahead. It stays in this location as you walk.`);
      onShowViewer?.();
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusy(false); }
  }

  function captureFloor() {
    target.current = null;
    let seconds = 5;
    setCaptureSeconds(seconds);
    setMessage('Move the pointer onto a visible floor spot in the walkthrough. Hold it there until placement.');
    clearInterval(captureTimer.current);
    captureTimer.current = setInterval(() => {
      seconds -= 1;
      setCaptureSeconds(seconds);
      if (seconds <= 0) {
        clearInterval(captureTimer.current);
        if (target.current) add(target.current);
        else setError('No floor surface was captured. Aim at the scanned floor, then retry.');
      }
    }, 1000);
    onShowViewer?.();
  }

  function adjust(item, change) {
    const next = controller.current?.adjust(item.id, change);
    if (next) persist(items.map(value => value.id === next.id ? next : value));
  }

  async function show(item) {
    setError('');
    try {
      if (item.sweepId) await sdk.Sweep.moveTo(item.sweepId, {});
      await sdk.Camera.lookAt({ x: item.position.x, y: item.position.y + .5, z: item.position.z });
      onShowViewer?.();
    } catch { if (alive.current) setError('Unable to return to this obstacle’s viewpoint.'); }
  }

  return <section className="obstacle-controls" aria-label="Training obstacles">
    <div className="obstacle-toolbar"><strong>3D training obstacles</strong>
      <label>Object <select value={type} onChange={event => setType(event.target.value)}><option value="barricade">Barricade</option><option value="cone">Traffic cone</option><option value="debris">Debris</option></select></label>
      <button disabled={!ready || !inside || !interior || busy || captureSeconds > 0 || items.length >= 30} onClick={() => add()}>{busy ? 'Placing…' : 'Add obstacle ahead'}</button>
      <button disabled={!ready || !inside || !interior || busy || captureSeconds > 0 || items.length >= 30} onClick={captureFloor}>{captureSeconds ? `Aim at floor (${captureSeconds}s)` : 'Place on floor'}</button>
      <label className="obstacle-diagnostic"><input type="checkbox" checked={diagnostic} onChange={event => { setDiagnostic(event.target.checked); controller.current?.setDiagnostic(event.target.checked); }}/>Show through walls (visibility check)</label>
    </div>
    <p role="status">{message}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {diagnostic && <p>Visibility check is on: obstacles appear through surfaces. Turn it off for normal depth.</p>}
    {items.length > 0 && <ul>{items.map((item, index) => <li key={item.id}><span>{index + 1}. {item.type}</span><button disabled={!interior || busy} onClick={() => show(item)}>Show</button><button disabled={busy || captureSeconds > 0} onClick={() => adjust(item, { yaw: Math.PI / 4 })}>Rotate</button><button disabled={busy || captureSeconds > 0} aria-label={`Raise ${item.type}`} onClick={() => adjust(item, { height: .1 })}>↑</button><button disabled={busy || captureSeconds > 0} aria-label={`Lower ${item.type}`} onClick={() => adjust(item, { height: -.1 })}>↓</button><button disabled={busy || captureSeconds > 0} onClick={() => { controller.current?.remove(item.id); persist(items.filter(value => value.id !== item.id)); setMessage('Obstacle removed.'); }}>Remove</button></li>)}</ul>}
    <small>Training props are visual obstacles; they do not change Matterport’s navigation graph.</small>
  </section>;
}
