import React, { useEffect, useRef, useState } from 'react';

export default function MatterportViewer({ modelId }) {
  const frame = useRef(null);
  const [status, setStatus] = useState('Loading viewer…');
  const [error, setError] = useState('');
  const [sweep, setSweep] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [roomStatus, setRoomStatus] = useState('waiting');
  const [retry, setRetry] = useState(0);

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
            const bootstrap = 'https://static.matterport.com/showcase-sdk/bootstrap/3.1.0-0-g1cd7e0997a/sdk.es6.js';
            const { connect } = await import(/* @vite-ignore */ `${bootstrap}?applicationKey=${encodeURIComponent(key)}`);
            if (!active) return;
            sdk = await connect(iframe);
            if (!active) return;
            clearTimeout(timer);
            window.mpSdk = sdk;
            setStatus('SDK connected');
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
          } catch {
            if (active) {
              clearTimeout(timer);
              setError('SDK connection failed. Check model access and that your SDK key allows this localhost address.');
            }
          }
        };
        iframe.addEventListener('load', onLoad, { once: true });
        iframe.src = `https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}&play=1&applicationKey=${encodeURIComponent(key)}`;
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
        <span>{sweep ? `Floor index: ${sweep.floor ?? 'unknown'} · Sweep: ${sweep.id}` : `Model: ${modelId}`}</span>
        <button onClick={() => setRetry(value => value + 1)}>Reload</button>
      </div>
      <div className="room-status" role="status" aria-live="polite" aria-atomic="true">
        <strong>{rooms.length > 1 ? 'Current rooms:' : 'Current room:'}</strong>
        {error ? <span>Unavailable while disconnected</span>
          : roomStatus === 'unavailable' ? <span>Room tracking unavailable for this model or SDK</span>
          : roomStatus === 'waiting' ? <span>Waiting for room data…</span>
          : rooms.length ? rooms.map((room, index) => (
            <span className="room-label" key={room.id || index} title={`Room ID: ${room.id || 'unknown'}`}>
              {room.label?.trim() || 'Unlabeled room'}
              <code>{room.id || 'No room ID'}</code>
            </span>
          )) : <span>No room reported at this viewpoint</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <iframe ref={frame} title={`Matterport model ${modelId}`} allow="fullscreen; xr-spatial-tracking" allowFullScreen/>
    </section>
  );
}
