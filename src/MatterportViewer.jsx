import React, { useCallback, useEffect, useRef, useState } from 'react';
import ModelTags from './ModelTags.jsx';
import DrillDebrief from './DrillDebrief.jsx';
import AerialView from './AerialView.jsx';
import ObstacleControls from './ObstacleControls.jsx';

export default function MatterportViewer({ modelId, importedFile }) {
  const frame = useRef(null);
  const [status, setStatus] = useState('Loading viewer…');
  const [error, setError] = useState('');
  const [sweep, setSweep] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [roomStatus, setRoomStatus] = useState('waiting');
  const [retry, setRetry] = useState(0);
  const [connectedSdk, setConnectedSdk] = useState(null);
  const [overlayTarget, setOverlayTarget] = useState(null);
  // Aerial/exterior view (Vexcel).
  const [view, setView] = useState('interior');
  const [aerialOpened, setAerialOpened] = useState(false);
  const [aerialReady, setAerialReady] = useState(false);
  const aerialVisible = view === 'aerial' && aerialReady;
  const nativeOverview = useRef(false);
  const restoringInterior = useRef(false);
  const [viewError, setViewError] = useState('');
  // Drill lifecycle: active -> returning (all answered, go to exit) -> debrief -> done.
  const [phase, setPhase] = useState('active');
  const [summary, setSummary] = useState(null);
  const [plan, setPlan] = useState(null);
  const trail = useRef([]);
  const debriefTrail = useRef([]);
  const phaseRef = useRef('active');
  const exitSweepRef = useRef(null);

  function showAerial() {
    setViewError('');
    setAerialOpened(true);
    setView('aerial');
  }

  useEffect(() => {
    if (!connectedSdk?.Mode?.current?.subscribe) return;
    const subscription = connectedSdk.Mode.current.subscribe(mode => {
      if (mode === connectedSdk.Mode.Mode.DOLLHOUSE) {
        nativeOverview.current = true;
        if (!restoringInterior.current) showAerial();
      } else if (mode === connectedSdk.Mode.Mode.INSIDE) {
        nativeOverview.current = false;
        // Some Bundle releases leave the startup screen over a running panorama.
        // Hide it only after the SDK confirms an active interior mode.
        try {
          const loading = frame.current?.contentDocument?.querySelector('#loading-gui');
          if (loading) { loading.style.display = 'none'; loading.setAttribute('aria-hidden', 'true'); }
        } catch { /* Hosted Embed SDK is cross-origin. */ }
      }
    });
    return () => subscription.cancel();
  }, [connectedSdk]);

  async function showInterior() {
    setViewError('');
    // Keep the iframe rendering underneath the aerial layer during restoration.
    setView('interior');
    if (nativeOverview.current && connectedSdk) {
      restoringInterior.current = true;
      try {
        await connectedSdk.Mode.moveTo(connectedSdk.Mode.Mode.INSIDE);
      } catch {
        setViewError('Unable to return to the walkthrough. Retry or reload the viewer.');
      } finally {
        restoringInterior.current = false;
      }
    }
  }

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Reset the drill lifecycle whenever the model changes.
  useEffect(() => {
    setPhase('active'); phaseRef.current = 'active';
    setSummary(null); setPlan(null); exitSweepRef.current = null; trail.current = [];
  }, [modelId]);

  // Record the trainee's path (one entry per distinct sweep), and once they're
  // in the "returning" phase, complete the drill once they reach ANY marked
  // exit -- not just the one the optimal route happens to end at. A model can
  // have several real doors; the trainee should be free to leave through
  // whichever one they actually walk back to.
  useEffect(() => {
    if (!connectedSdk) return undefined;
    const sub = connectedSdk.Sweep.current.subscribe(cur => {
      if (!cur?.sid) return;
      const last = trail.current[trail.current.length - 1];
      if (!last || last.sweepId !== cur.sid) trail.current.push({ sweepId: cur.sid, position: cur.position, t: Date.now() });
      if (phaseRef.current === 'returning' && exitSweepRef.current?.has(cur.sid)) {
        debriefTrail.current = trail.current.slice();
        phaseRef.current = 'debrief';
        setPhase('debrief');
      }
    });
    return () => sub?.cancel?.();
  }, [connectedSdk]);

  // All questions answered -> enter "returning" and fetch the route's exit sweep.
  const handleComplete = useCallback(s => {
    setSummary(prev => prev || s);
    setPhase(prev => (prev === 'active' ? 'returning' : prev));
  }, []);

  useEffect(() => {
    if (phase !== 'returning') return undefined;
    let live = true;
    fetch(`/api/plan?model=${encodeURIComponent(modelId)}`)
      .then(r => r.json())
      .then(p => {
        if (!live) return;
        setPlan(p);
        const exits = (p.exitSweepIds?.length ? p.exitSweepIds : [p.exitSweepId]).filter(Boolean);
        exitSweepRef.current = exits.length ? new Set(exits) : null;
        // No exit to return to -> finish immediately.
        if (!exitSweepRef.current) {
          debriefTrail.current = trail.current.slice();
          phaseRef.current = 'debrief';
          setPhase('debrief');
        }
      })
      .catch(() => {});
    return () => { live = false; };
  }, [phase, modelId]);

  useEffect(() => {
    let active = true;
    let subscription;
    let roomSubscription;
    let sdk;
    let timer;
    let onLoad;
    const controller = new AbortController();
    const iframe = frame.current;
    setStatus('Loading viewer…');
    setError('');
    setSweep(null);
    setRooms([]);
    setRoomStatus('waiting');
    setConnectedSdk(null);

    async function initialize() {
      try {
        const response = await fetch('/config.json', { cache: 'no-store', signal: controller.signal });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || 'Unable to load SDK configuration.');
        if (!active) return;
        const key = config.matterportSdkKey;
        onLoad = async () => {
          try {
            setStatus('Connecting SDK…');
            if (config.matterportBundleUrl) {
              sdk = await iframe.contentWindow.MP_SDK.connect(iframe.contentWindow);
            } else {
              const bootstrap = 'https://static.matterport.com/showcase-sdk/bootstrap/3.1.0-0-g1cd7e0997a/sdk.es6.js';
              const { connect } = await import(/* @vite-ignore */ `${bootstrap}?applicationKey=${encodeURIComponent(key)}`);
              if (!active) return;
              sdk = await connect(iframe);
            }
            if (!active) return;
            clearTimeout(timer);
            window.mpSdk = sdk;
            setStatus(sdk.Scene?.createObjects ? 'Bundle SDK connected · 3D obstacles available' : 'Embed SDK connected · install Bundle SDK for 3D obstacles');
            setError('');
            subscription = sdk.Sweep.current.subscribe(current => {
              if (active) setSweep(current.sid ? { id: current.sid, floor: current.floorInfo?.sequence } : null);
            });
            // Room tracking is optional: missing room data must not break the viewer.
            try {
              if (!sdk.Room?.current?.subscribe) {
                setRoomStatus('unavailable');
              } else {
                roomSubscription = sdk.Room.current.subscribe(current => {
                  if (!active) return;
                  setRooms(Array.isArray(current?.rooms) ? current.rooms : []);
                  setRoomStatus('ready');
                });
              }
            } catch {
              if (active) {
                setRooms([]);
                setRoomStatus('unavailable');
              }
            }
            if (active) setConnectedSdk(sdk);
          } catch {
            if (active) {
              clearTimeout(timer);
              setError('SDK connection failed. Check model access and that your SDK key allows this localhost address.');
            }
          }
        };
        iframe.addEventListener('load', onLoad, { once: true });
        iframe.src = `${config.matterportBundleUrl || 'https://my.matterport.com/show/'}?m=${encodeURIComponent(modelId)}&play=1&applicationKey=${encodeURIComponent(key)}`;
        timer = setTimeout(() => {
          if (active) setError('The viewer is taking longer than expected. Check your connection and model access, then retry.');
        }, 30000);
      } catch (failure) {
        if (active) setError(failure.message || 'Unable to load viewer configuration.');
      }
    }
    initialize();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      if (onLoad) iframe.removeEventListener('load', onLoad);
      subscription?.cancel?.();
      roomSubscription?.cancel?.();
      if (sdk && window.mpSdk === sdk) delete window.mpSdk;
    };
  }, [modelId, retry]);

  return (
    <section className="viewer">
      <div className="status-bar" role="status">
        <span>{error ? 'Connection needs attention' : status}</span>
        <button onClick={() => setRetry(value => value + 1)}>Reload viewer</button>
      </div>
      <div className="room-status" role="status" aria-live="polite" aria-atomic="true">
        <strong>{rooms.length > 1 ? 'Current rooms' : 'Current room'}</strong>
        {error ? <span>Unavailable while disconnected</span>
          : roomStatus === 'unavailable' ? <span>Room tracking unavailable for this model or SDK</span>
          : roomStatus === 'waiting' ? <span>Waiting for room data…</span>
          : rooms.length ? rooms.map((room, index) => (
            <span className="room-name" key={room.id || index} title={`Room ID: ${room.id || 'unknown'}`}>
              {room.label?.trim() || 'Unlabeled room'}
            </span>
          )) : <span>No room reported at this viewpoint</span>}
      </div>
      <details className="viewpoint-details">
        <summary>Viewpoint details</summary>
        <dl>
          <div><dt>Model ID</dt><dd><code>{modelId}</code></dd></div>
          <div><dt>SDK floor index</dt><dd>{sweep?.floor ?? 'Unavailable'}</dd></div>
          <div><dt>Sweep ID</dt><dd><code>{sweep?.id || 'Unavailable'}</code></dd></div>
          <div><dt>Room IDs</dt><dd><code>{error ? 'Unavailable' : rooms.length ? rooms.map(room => room.id || 'Unknown').join(', ') : 'Unavailable'}</code></dd></div>
        </dl>
      </details>
      {error && <p className="error" role="alert">{error}</p>}
      {connectedSdk && !error && <ModelTags key={`${modelId}-${retry}`} sdk={connectedSdk} modelId={modelId} importedFile={importedFile} overlayTarget={overlayTarget} onShowViewer={() => frame.current?.scrollIntoView({ block: 'start' })} onComplete={handleComplete}/>}
      {phase === 'returning' && <div className="return-prompt" role="status">All tasks complete — return to the entrance to finish the drill.</div>}
      {phase === 'debrief' && connectedSdk && <DrillDebrief sdk={connectedSdk} modelId={modelId} score={summary?.score} maxScore={summary?.maxScore} answers={summary?.answers} trail={debriefTrail.current} plan={plan} checkpoints={importedFile?.tasks} onClose={() => setPhase('done')}/>}
      {connectedSdk && !error && <ObstacleControls key={`obstacles-${modelId}-${retry}`} sdk={connectedSdk} modelId={modelId} interior={view === 'interior'} onShowViewer={() => frame.current?.scrollIntoView({ block: 'center' })}/>}
      <div className="viewer-stage">
        {viewError && <p className="error" role="alert">{viewError}</p>}
        <div className="viewer-viewport">
        <iframe id="interior-view" className={`viewer-layer ${aerialVisible ? 'is-inactive' : 'is-active'}`} inert={aerialVisible} aria-hidden={aerialVisible} ref={frame} title={`Matterport model ${modelId}`} allow="fullscreen; xr-spatial-tracking" allowFullScreen/>
        <div hidden={view !== 'interior'} className="sweep-question-layer" ref={setOverlayTarget}/>
        {(connectedSdk || aerialOpened) && <div id="aerial-view" className={`aerial-container viewer-layer ${aerialVisible ? 'is-active' : 'is-inactive'}`} inert={!aerialVisible} aria-hidden={!aerialVisible}><AerialView modelId={modelId} onReady={() => setAerialReady(true)} onBackToInterior={showInterior}/></div>}
        {view === 'aerial' && !aerialReady && <div className="view-transition-status" role="status">Preparing aerial view… <button onClick={showInterior}>Cancel</button></div>}
        </div>
      </div>
    </section>
  );
}
