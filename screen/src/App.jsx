// Main screen. Owner: agent 2 (screen).
// Routes: "#/" live demo building, "#/hospital" scale view (hash routing, so the backend needs no SPA fallback).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, socket } from './api.js';
import DemoView from './DemoView.jsx';
import HospitalView from './HospitalView.jsx';

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

const routeFromHash = () => (window.location.hash.startsWith('#/hospital') ? 'hospital' : 'demo');

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [connected, setConnected] = useState(socket.connected);
  const [toast, setToast] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const toastTimer = useRef();
  const confirmTimer = useRef();

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    const onKey = (e) => {
      if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) toggleFullscreen();
    };
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  const showToast = useCallback((t) => {
    setToast({ ...t, key: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), t.kind === 'trip' ? 7000 : 4500);
  }, []);

  // Two-step reset so a stray click mid-demo doesn't wipe the room's work.
  const resetDemo = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    setConfirmReset(false);
    try {
      const r = await api.reset();
      showToast({ kind: 'ok', title: 'Demo reset', text: `${r.nodes} nodes re-seeded` });
    } catch (e) {
      showToast({ kind: 'reject', title: 'Reset failed', text: e.message });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">
          <svg className="mark" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="2" width="6" height="5" rx="1.2" />
            <rect x="2" y="17" width="6" height="5" rx="1.2" />
            <rect x="16" y="17" width="6" height="5" rx="1.2" />
            <path d="M12 7v5M5 17v-5h14v5" fill="none" />
          </svg>
          PowerTrace
        </h1>
        <nav className="tabs" aria-label="Views">
          <a href="#/" aria-current={route === 'demo' ? 'page' : undefined}>Demo building</a>
          <a href="#/hospital" aria-current={route === 'hospital' ? 'page' : undefined}>Hospital</a>
        </nav>
        <div className="topbar-right">
          <span className={`live ${connected ? 'on' : 'off'}`}>{connected ? 'Live' : 'Reconnecting'}</span>
          <button type="button" className="btn small primary" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit full screen' : 'Present'}
          </button>
          {route === 'demo' && (
            <button type="button" className={`btn ghost small ${confirmReset ? 'confirm' : ''}`} onClick={resetDemo}>
              {confirmReset ? 'Click again to reset' : 'Reset demo'}
            </button>
          )}
        </div>
      </header>

      {toast && (
        <div key={toast.key} className={`toast ${toast.kind}`} role={toast.kind === 'ok' ? 'status' : 'alert'}>
          <strong>{toast.title}</strong>
          <span>{toast.text}</span>
        </div>
      )}

      <main className="view">
        {route === 'demo' ? <DemoView onToast={showToast} /> : <HospitalView onToast={showToast} />}
      </main>
    </div>
  );
}
