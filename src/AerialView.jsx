import React, { useEffect, useRef, useState } from 'react';
import { readAerialJson } from './aerialApi.js';
import AerialHotspots from './AerialHotspots.jsx';

const WIDTHS = [200, 400, 600, 1000, 1600];

export default function AerialView({ modelId, onBackToInterior, onReady }) {
  const [widthIndex, setWidthIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [site, setSite] = useState(null);
  const [image, setImage] = useState(null);
  const imageUrl = useRef(null);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  useEffect(() => () => { if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); }, []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const width = WIDTHS[widthIndex];

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl;
    setLoading(true);
    setError('');
    async function load() {
      try {
        const siteResponse = await fetch(`/api/aerial/site?model=${encodeURIComponent(modelId)}`, { signal: controller.signal });
        const metadata = await readAerialJson(siteResponse);
        if (controller.signal.aborted) return;
        setSite(metadata);
        if (!metadata.configured) throw new Error('Vexcel imagery is not configured. Set VEXCEL_API_KEY on the local server.');
        const response = await fetch(`/api/aerial/image?model=${encodeURIComponent(modelId)}&width=${width}`, { signal: controller.signal });
        if (!response.ok) {
          await readAerialJson(response);
        }
        if (!response.headers.get('content-type')?.startsWith('image/')) {
          throw new Error('The aerial server did not return an image. Restart python3 serve.py, then retry.');
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        const decoded = new Image();
        decoded.src = objectUrl;
        await decoded.decode();
        if (controller.signal.aborted) return;
        if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
        imageUrl.current = objectUrl;
        setImage({ url: objectUrl, width });
        objectUrl = null;
        setLoading(false);
        readyCallback.current?.();
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure.message || 'Unable to load aerial imagery.');
        setLoading(false);
        readyCallback.current?.();
      }
    }
    load();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [modelId, width, retry]);

  return <section className="aerial-view" aria-label="Vexcel aerial view" aria-busy={loading}>
    <div className="aerial-toolbar">
      <div><strong>Vexcel aerial imagery</strong><p>{site?.address || 'Building surroundings'}</p></div>
      <div className="aerial-zoom" role="group" aria-label="Aerial zoom">
        <button onClick={() => setWidthIndex(index => index - 1)} disabled={widthIndex === 0} aria-label="Zoom in">+</button>
        <span>{width.toLocaleString()} m across</span>
        <button onClick={() => setWidthIndex(index => index + 1)} disabled={widthIndex === WIDTHS.length - 1} aria-label="Zoom out">−</button>
      </div>
    </div>
    <div className="aerial-image-area">
      {loading && <p className="aerial-message" role="status">{image ? 'Updating aerial imagery…' : 'Loading aerial imagery…'}</p>}
      {error && <div className="aerial-message" role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Retry aerial view</button></div>}
      {image && <div className="aerial-image-frame"><img src={image.url} alt={`North-up aerial imagery around ${site?.address || 'the building'}, ${image.width} meters across`} onError={() => { setImage(null); setError('The aerial image could not be displayed. Please retry.'); }}/><AerialHotspots modelId={modelId} width={image.width} disabled={loading}/><span className="aerial-center" aria-hidden="true"/><span className="aerial-north" aria-label="North is up">N ↑</span></div>}
      <button type="button" className="aerial-interior-control" onClick={onBackToInterior} aria-label="Return to interior walkthrough" title="Return to interior walkthrough">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="m7 21 3-7 4 3v4M10 14l2-7 3 4 4 1M12 7 8 9l-2 4"/></svg>
        <span>Interior view</span>
      </button>
    </div>
    <p className="aerial-caption">© Vexcel Imaging · North up · Center: property address coordinates{site ? ` (${site.latitude.toFixed(5)}, ${site.longitude.toFixed(5)})` : ''}</p>
  </section>;
}
