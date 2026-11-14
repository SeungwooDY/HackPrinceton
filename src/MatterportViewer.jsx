import React, { useEffect, useRef, useState } from 'react';

export default function MatterportViewer({ modelId }) {
  const frame = useRef(null);
  const [status, setStatus] = useState('Loading viewer…');
  const [error, setError] = useState('');
  const [sweep, setSweep] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    let subscription;
    let sdk;
    let timer;
    let onLoad;
    const controller = new AbortController();
    const iframe = frame.current;
    setStatus('Loading viewer…');
    setError('');
    setSweep(null);

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
              if (active && current.sid) setSweep({ id: current.sid, floor: current.floorInfo?.sequence });
            });
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
      {error && <p className="error" role="alert">{error}</p>}
      <iframe ref={frame} title={`Matterport model ${modelId}`} allow="fullscreen; xr-spatial-tracking" allowFullScreen/>
    </section>
  );
}
