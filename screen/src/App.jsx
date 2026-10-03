// Main screen. Owner: agent 2 (screen).
// Routes: "#/" live demo building, "#/hospital" scale view (hash routing, so the backend needs no SPA fallback).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, socket } from './api.js';
import DemoView from './DemoView.jsx';
import HospitalView from './HospitalView.jsx';

const routeFromHash = () => (window.location.hash.startsWith('#/hospital') ? 'hospital' : 'demo');

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [connected, setConnected] = useState(socket.connected);
  const [toast, setToast] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const toastTimer = useRef();
  const confirmTimer = useRef();

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    window.addEventListener('hashchange', onHash);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      window.removeEventListener('hashchange', onHash);
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
        <h1 className="brand">PowerTrace</h1>
        <nav className="tabs" aria-label="Views">
          <a href="#/" aria-current={route === 'demo' ? 'page' : undefined}>Demo building</a>
          <a href="#/hospital" aria-current={route === 'hospital' ? 'page' : undefined}>Hospital</a>
        </nav>
        <div className="topbar-right">
          <span className={`live ${connected ? 'on' : 'off'}`}>{connected ? 'Live' : 'Reconnecting'}</span>
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
