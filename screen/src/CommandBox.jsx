// Plain-English operator commands on the main screen (POST /api/command on the real backend).
// "Route power away from DB-L3-01" trips that board through the normal trip route, so phones and
// the tree update exactly as if the Trip button had been pressed.
import { useState } from 'react';
import { BASE_URL } from './config.js';
import { socket } from './api.js';

const EXAMPLES = ['Route power away from SMSB-B', 'Restore power to SMSB-B', 'Isolate DB-L3-01'];

export default function CommandBox() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);

  async function run(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${BASE_URL}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Socket-Id': socket.id ?? '', 'X-Who': 'operator' },
        body: JSON.stringify({ text: t }),
      });
      const data = await res.json().catch(() => ({}));
      const by = data.by === 'claude' ? 'Claude' : data.by === 'demo default' ? 'demo default' : data.by ? 'keyword parser' : null;
      setLast({
        ok: res.ok && data.ok !== false,
        message: data.message || (res.status === 404 ? 'Commands need the real backend (not the mock).' : data.error || 'That did not work.'),
        by,
      });
      if (res.ok) setText('');
    } catch {
      setLast({ ok: false, message: 'Could not reach the server.', by: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card command">
      <h3>Tell the building</h3>
      <form onSubmit={run}>
        <label className="sr-only" htmlFor="command-text">Command</label>
        <input
          id="command-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Route power away from DB-L3-01"
          autoComplete="off"
        />
        <button type="submit" className="btn primary" disabled={busy || !text.trim()}>Run</button>
      </form>
      <div className="command-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="btn ghost small" onClick={() => setText(ex)}>{ex}</button>
        ))}
      </div>
      {last && (
        <p className={`command-result ${last.ok ? 'ok' : 'no'}`} aria-live="polite">
          {last.message}{last.by ? <span className="muted"> · read by {last.by}</span> : null}
        </p>
      )}
    </section>
  );
}
