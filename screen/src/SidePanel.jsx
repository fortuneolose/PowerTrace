import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { JOIN_URL } from './config.js';
import { Explainer } from './Explainer.jsx';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function whoLabel(who) {
  if (!who || who === 'anonymous') return 'Someone';
  if (who === 'presenter') return 'Presenter';
  if (who.startsWith('phone:')) return `Phone ${who.slice(6)}`;
  if (who.startsWith('bot-')) return `Bot ${who.slice(4)}`;
  return who;
}

function describe(e) {
  switch (e.action) {
    case 'toggle': return `${e.nodeId} switched ${e.to}`;
    case 'rewire': return `${e.nodeId} moved from ${e.from} to ${e.to}`;
    case 'load': return `${e.nodeId} load ${Number(e.to) > Number(e.from) ? 'up' : 'down'} to ${e.to} kW`;
    case 'trip': return `${e.nodeId} tripped`;
    case 'reset': return `${e.nodeId} reset`;
    case 'claim': return `${e.nodeId} joined from a phone`;
    case 'import': return `Imported ${e.to}`;
    default: return `${e.nodeId ?? ''} ${e.action}`;
  }
}

function JoinCard() {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    QRCode.toDataURL(JOIN_URL, { margin: 1, width: 360, color: { dark: '#0b0f15', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, []);
  return (
    <section className="card join">
      {qr && <img src={qr} alt={`QR code for ${JOIN_URL}`} width="132" height="132" />}
      <div>
        <h2>Take control of the building</h2>
        <p>Scan to become a real piece of equipment. Switch it, re-wire it, overload its board.</p>
        <p className="url">{JOIN_URL.replace(/^https?:\/\//, '')}</p>
      </div>
    </section>
  );
}

function Path({ nodes, trace, onSelect }) {
  if (!trace) return null;
  const chain = [...trace.path].reverse(); // main switchboard first
  return (
    <>
      <h3>Fed from</h3>
      <ol className="path">
        {chain.map((id) => (
          <li key={id}>
            <button type="button" className="link" onClick={() => onSelect(id)}>{id}</button>
            <span className="muted">{nodes[id]?.name}</span>
          </li>
        ))}
        <li className="here"><strong>{trace.id}</strong></li>
      </ol>
      {trace.ms != null && <p className="query">Traced upstream with $graphLookup in {trace.ms} ms</p>}
    </>
  );
}

function BoardDetail({ node, pct, trace, preview, nodes, loadBand, onSelect, onDownstream, onTrip }) {
  const kw = Math.round((pct / 100) * node.capacityKW);
  return (
    <>
      <p className="detail-line">Level {node.level}, {node.phases}-phase {node.voltage} V, rated {node.capacityKW} kW</p>
      <div className="metric">
        <p className={`big ${node.tripped ? 'red' : loadBand(pct)}`}>{node.tripped ? 'Tripped' : `${pct}%`}</p>
        <p className="metric-sub">{node.tripped ? 'Everything below this board is off' : `${kw} of ${node.capacityKW} kW drawn`}</p>
        {!node.tripped && <div className="loadbar wide"><span className={loadBand(pct)} style={{ width: `${Math.min(pct, 100)}%` }} /></div>}
      </div>
      <div className="actions">
        {node.tripped
          ? <button type="button" className="btn primary" onClick={() => onTrip(node._id, false)}>Reset board</button>
          : <button type="button" className="btn danger" onClick={() => onTrip(node._id, true)}>Trip board</button>}
        <button type="button" className="btn" onClick={() => onDownstream(node._id)}>Show what loses power</button>
      </div>
      {preview?.id === node._id && (
        <div className="impact">
          <p><strong>{preview.equipment.length} items</strong> lose power if {node._id} trips ({Math.round(preview.kw * 10) / 10} kW running).</p>
          {preview.critical.length > 0 && (
            <p className="crit">Critical: {preview.critical.map((n) => `${n._id} (${n.name})`).join(', ')}</p>
          )}
          {preview.ms != null && <p className="query">Traced downstream with $graphLookup in {preview.ms} ms</p>}
        </div>
      )}
      <Path nodes={nodes} trace={trace} onSelect={onSelect} />
    </>
  );
}

function EquipDetail({ node, trace, nodes, boards, onSelect, onRewire }) {
  const [target, setTarget] = useState('');
  useEffect(() => setTarget(''), [node._id]);
  return (
    <>
      <p className="detail-line">
        {node.on ? `${node.loadKW} kW running` : 'Switched off'}, {node.phases}-phase, rated {node.ratedKW} kW
        {node.critical ? ', critical' : ''}{node.claimedBy ? ', controlled from a phone' : ''}
      </p>
      <Path nodes={nodes} trace={trace} onSelect={onSelect} />
      <h3>Re-wire</h3>
      <form className="rewire" onSubmit={(e) => { e.preventDefault(); if (target) onRewire(node._id, target); }}>
        <label className="sr-only" htmlFor="rewire-target">Move {node._id} to</label>
        <select id="rewire-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Move to board…</option>
          {boards.filter((b) => b._id !== node.parentId).map((b) => (
            <option key={b._id} value={b._id}>{b._id} ({b.phases}-phase)</option>
          ))}
        </select>
        <button type="submit" className="btn primary" disabled={!target}>Move</button>
      </form>
    </>
  );
}

export default function SidePanel({ nodes, loads, selected, trace, preview, feed, onSelect, onClear, onDownstream, onTrip, onRewire, loadBand }) {
  const node = selected && nodes?.[selected];
  const boards = useMemo(
    () => Object.values(nodes ?? {}).filter((n) => n.type === 'board').sort((a, b) => a.level - b.level || a._id.localeCompare(b._id)),
    [nodes],
  );
  return (
    <aside className="rail">
      <JoinCard />
      <section className="card selection" aria-live="polite">
        {node ? (
          <>
            <div className="sel-head">
              <h2>{node._id}</h2>
              <button type="button" className="btn ghost small" onClick={onClear} aria-label="Close selection">Esc</button>
            </div>
            <p className="muted">{node.name}</p>
            {node.type === 'board'
              ? <BoardDetail node={node} pct={loads[node._id] ?? 0} trace={trace} preview={preview} nodes={nodes} loadBand={loadBand} onSelect={onSelect} onDownstream={onDownstream} onTrip={onTrip} />
              : <EquipDetail node={node} trace={trace} nodes={nodes} boards={boards} onSelect={onSelect} onRewire={onRewire} />}
          </>
        ) : (
          <Explainer />
        )}
      </section>
      <section className="card feed">
        <div className="feed-head"><h3>Activity</h3><span className="muted">{feed.length ? `${feed.length} changes` : ''}</span></div>
        {feed.length === 0 && <p className="muted">Changes from phones and the presenter appear here as they happen.</p>}
        <ol>
          {feed.map((e, i) => (
            <li key={`${e.ts}-${i}`} className={`act-${e.action}`}>
              <span className="dot" aria-hidden="true" />
              <time>{time(e.ts)}</time>
              <span className="what">{describe(e)}</span>
              <span className="who">{whoLabel(e.who)}</span>
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
