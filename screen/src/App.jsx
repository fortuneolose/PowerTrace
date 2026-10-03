// Main screen. Owner: agent 2 (screen). Scaffold only: proves the API + socket wiring works.
// Routes: "#/" live demo building, "#/hospital" scale view (hash routing, so the backend needs no SPA fallback).
import { useEffect, useState } from 'react';
import { api, socket } from './api.js';
import { BASE_URL } from './config.js';

export default function App() {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  const [feed, setFeed] = useState([]);

  useEffect(() => {
    api.tree().then(setTree).catch((e) => setError(e.message));
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onEvent = (e) => setFeed((f) => [e, ...f].slice(0, 20));
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('event', onEvent);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('event', onEvent);
    };
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>PowerTrace</h1>
      <p>
        API: <code>{BASE_URL || window.location.origin}</code> · socket: {connected ? 'connected' : 'disconnected'}
      </p>
      {error && <p style={{ color: 'crimson' }}>Could not load /api/tree: {error}</p>}
      {tree && (
        <p>
          {tree.nodes.length} nodes loaded. Loads: <code>{JSON.stringify(tree.loads)}</code>
        </p>
      )}
      <h2>Activity</h2>
      <ul>
        {feed.map((e, i) => (
          <li key={i}>
            {e.nodeId} {e.action} {String(e.from)} → {String(e.to)} ({e.who})
          </li>
        ))}
      </ul>
    </main>
  );
}
