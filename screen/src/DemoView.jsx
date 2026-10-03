// "#/" The live demo building: React Flow tree, load bars, fault ripple, activity feed,
// presenter controls. Everything that changes arrives over Socket.IO from the change stream.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import { api, socket } from './api.js';
import { edgeTypes, nodeTypes } from './FlowParts.jsx';
import { deadSet, depthBelow, feedPath, layout, loadBand } from './layout.js';
import SidePanel from './SidePanel.jsx';
import { Caption, narrate } from './Explainer.jsx';
import CommandBox from './CommandBox.jsx';

const STEP_MS = 130;      // fault ripple delay per level
const MOVE_MS = 750;      // re-wire glide
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function DemoView({ onToast }) {
  return (
    <ReactFlowProvider>
      <Demo onToast={onToast} />
    </ReactFlowProvider>
  );
}

function Demo({ onToast }) {
  const [nodes, setNodes] = useState(null);   // { [id]: node }
  const [loads, setLoads] = useState({});     // { [boardId]: percent }
  const [feed, setFeed] = useState([]);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [trace, setTrace] = useState(null);     // { id, ids: Set, path, ms }
  const [preview, setPreview] = useState(null); // { id, depth: Map, equipment, critical, kw, ms }
  const [wave, setWave] = useState(null);       // { origin } while a trip/reset ripple plays
  const [moved, setMoved] = useState(null);     // id that was just re-wired
  const nodesRef = useRef(null);
  nodesRef.current = nodes;
  const timers = useRef({});
  const later = (key, fn, ms) => { clearTimeout(timers.current[key]); timers.current[key] = setTimeout(fn, ms); };

  const loadTree = useCallback(async () => {
    try {
      const t = await api.tree('demo');
      setNodes(Object.fromEntries(t.nodes.map((n) => [n._id, n])));
      setLoads(t.loads);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // --- Socket.IO (CONTRACT.md section 3) ---
  useEffect(() => {
    loadTree();
    const onChanged = ({ node }) => {
      const old = nodesRef.current?.[node._id];
      if (old && old.parentId !== node.parentId) {
        setMoved(node._id);
        later('moved', () => setMoved(null), 3500);
      }
      setNodes((prev) => (prev ? { ...prev, [node._id]: node } : prev));
    };
    const onLoads = (l) => setLoads(l);
    const onTrip = ({ boardId, tripped, affected }) => {
      setWave({ origin: boardId });
      later('wave', () => setWave(null), 2500);
      const all = nodesRef.current ?? {};
      const equipment = affected.filter((id) => all[id]?.type === 'equipment');
      const critical = equipment.filter((id) => all[id]?.critical);
      onToast(tripped
        ? { kind: 'trip', title: `${boardId} tripped`, text: `${equipment.length} items lost power${critical.length ? `, ${critical.length} critical: ${critical.join(', ')}` : ''}` }
        : { kind: 'ok', title: `${boardId} reset`, text: `Power restored to ${equipment.length} items` });
    };
    const onEvent = (e) => setFeed((f) => [e, ...f].slice(0, 40));
    const onReload = ({ site }) => {
      if (site !== 'demo') return;
      setSelected(null); setTrace(null); setPreview(null);
      loadTree();
    };
    const onRejected = ({ reason }) => onToast({ kind: 'reject', title: 'Rejected', text: reason.replace(/^Rejected:\s*/, '') });

    socket.on('connect', loadTree); // catch up on anything missed while disconnected
    socket.on('node:changed', onChanged);
    socket.on('loads', onLoads);
    socket.on('trip', onTrip);
    socket.on('event', onEvent);
    socket.on('tree:reload', onReload);
    socket.on('rejected', onRejected);
    return () => {
      socket.off('connect', loadTree);
      socket.off('node:changed', onChanged);
      socket.off('loads', onLoads);
      socket.off('trip', onTrip);
      socket.off('event', onEvent);
      socket.off('tree:reload', onReload);
      socket.off('rejected', onRejected);
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, [loadTree, onToast]);

  // --- Layout: recomputed only when the wiring changes, then tweened so re-wires glide ---
  const structureKey = nodes ? Object.values(nodes).map((n) => `${n._id}>${n.parentId}`).sort().join('|') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const targets = useMemo(() => (nodes ? layout(Object.values(nodes)) : {}), [structureKey]);
  const [pos, setPos] = useState({});
  const posRef = useRef({});
  useEffect(() => {
    const from = posRef.current;
    const ids = Object.keys(targets);
    const changed = ids.some((id) => from[id] && (from[id].x !== targets[id].x || from[id].y !== targets[id].y));
    if (!changed || reducedMotion()) { posRef.current = targets; setPos(targets); return undefined; }
    let raf;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / MOVE_MS);
      const e = 1 - (1 - k) ** 3;
      const next = {};
      for (const id of ids) {
        const a = from[id] ?? targets[id];
        const b = targets[id];
        next[id] = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
      }
      posRef.current = next;
      setPos(next);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [targets]);

  const { fitView } = useReactFlow();
  const initialised = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (initialised && !fitted.current) { fitted.current = true; fitView({ padding: { top: '92px', bottom: '84px', left: '24px', right: '24px' } }); }
  }, [initialised, fitView]);

  // --- What each node looks like right now ---
  const dead = useMemo(() => (nodes ? deadSet(nodes) : new Set()), [nodes]);

  const delayFor = useCallback((id) => {
    if (preview?.depth.has(id)) return preview.depth.get(id) * STEP_MS;
    if (wave && nodes) {
      const d = depthBelow(nodes, id, wave.origin);
      if (d != null) return d * STEP_MS;
    }
    return 0;
  }, [preview, wave, nodes]);

  const rfNodes = useMemo(() => {
    if (!nodes) return [];
    return Object.values(nodes).map((n) => {
      const position = pos[n._id] ?? targets[n._id];
      if (!position) return null;
      const cls = [
        dead.has(n._id) && 'dead',
        n.type === 'board' && n.tripped && 'tripped',
        n.type === 'equipment' && !n.on && 'off',
        n.critical && 'critical',
        trace?.ids.has(n._id) && 'trace',
        preview?.depth.has(n._id) && 'preview',
        selected === n._id && 'selected',
        moved === n._id && 'moved',
      ].filter(Boolean).join(' ');
      return {
        id: n._id,
        type: n.type === 'board' ? 'board' : 'equip',
        position,
        data: { node: n, pct: loads[n._id] ?? 0, cls, delay: delayFor(n._id) },
        draggable: false,
        connectable: false,
        selectable: false,
      };
    }).filter(Boolean);
  }, [nodes, pos, targets, loads, dead, trace, preview, selected, moved, delayFor]);

  const rfEdges = useMemo(() => {
    if (!nodes) return [];
    return Object.values(nodes)
      .filter((n) => n.parentId && nodes[n.parentId])
      .map((n) => ({
        id: `wire:${n._id}`,
        source: n.parentId,
        target: n._id,
        type: 'wire',
        data: {
          toEquipment: n.type === 'equipment',
          delay: delayFor(n._id),
          cls: [
            dead.has(n._id) && 'dead',
            n.type === 'equipment' && !n.on && 'off',
            trace?.ids.has(n._id) && trace.ids.has(n.parentId) && 'trace',
            preview?.depth.has(n._id) && 'preview',
            moved === n._id && 'moved',
          ].filter(Boolean).join(' '),
        },
      }));
  }, [nodes, dead, trace, preview, moved, delayFor]);


  // --- Interactions ---
  const select = useCallback(async (id) => {
    setSelected(id);
    setPreview(null);
    try {
      const r = await api.traceUp(id);
      setTrace({ id, ids: new Set([id, ...r.path]), path: r.path, ms: r.queryMs });
    } catch (e) {
      // Fall back to the local path so the screen still shows something if the API hiccups.
      const path = nodesRef.current ? feedPath(nodesRef.current, id) : [];
      setTrace({ id, ids: new Set([id, ...path]), path, ms: null });
      onToast({ kind: 'reject', title: 'Trace failed', text: e.message });
    }
  }, [onToast]);

  const clear = useCallback(() => { setSelected(null); setTrace(null); setPreview(null); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') clear(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  const showDownstream = useCallback(async (id) => {
    try {
      const r = await api.traceDown(id);
      const all = nodesRef.current ?? {};
      const depth = new Map([[id, 0], ...r.downstream.map((d) => [d._id, d.depth + 1])]);
      const equipment = r.downstream.filter((d) => d.type === 'equipment').map((d) => all[d._id]).filter(Boolean);
      setTrace(null);
      setPreview({
        id,
        depth,
        equipment,
        critical: equipment.filter((n) => n.critical),
        kw: equipment.filter((n) => n.on).reduce((s, n) => s + n.loadKW, 0),
        ms: r.queryMs,
      });
    } catch (e) {
      onToast({ kind: 'reject', title: 'Trace failed', text: e.message });
    }
  }, [onToast]);

  const act = useCallback(async (fn) => {
    try {
      await fn();
    } catch (e) {
      // The backend also emits `rejected` to this socket; only toast here for non-409s so the
      // message doesn't appear twice.
      if (e.status !== 409) onToast({ kind: 'reject', title: 'Request failed', text: e.message });
    }
  }, [onToast]);

  // Narrate only when a new event arrives, using the loads at that moment.
  const latest = feed[0];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const caption = useMemo(() => narrate(latest, nodesRef.current, loads), [latest]);

  const stats = useMemo(() => {
    if (!nodes) return null;
    const equipment = Object.values(nodes).filter((n) => n.type === 'equipment');
    return {
      equipment: equipment.length,
      phones: equipment.filter((n) => n.claimedBy).length,
      dark: equipment.filter((n) => dead.has(n._id)).length,
      hot: Object.entries(loads).filter(([, p]) => p > 100).map(([id]) => id),
    };
  }, [nodes, dead, loads]);

  return (
    <div className="demo">
      <section className="canvas" aria-label="Building single-line diagram">
        {error && !nodes && (
          <div className="empty">
            <h2>Can't reach the backend</h2>
            <p>{error}. Start it with <code>npm run backend</code>, or <code>npm run mock</code> to work without Atlas.</p>
          </div>
        )}
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => select(n.id)}
          onPaneClick={clear}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.2}
          maxZoom={2}
        >
          <Background gap={22} size={1.4} color="#1d2632" variant="dots" />
          <Controls showInteractive={false} position="top-left" />
        </ReactFlow>
        {nodes && (
          <div className="topline">
            <Caption line={caption} />
            <CommandBox bar />
          </div>
        )}
        {stats && (
          <dl className="stats" aria-label="Building summary">
            <div><dt>Equipment</dt><dd>{stats.equipment}</dd></div>
            <div><dt>Phones in control</dt><dd className="blue">{stats.phones}</dd></div>
            <div className={stats.dark ? 'bad' : ''}><dt>Without power</dt><dd>{stats.dark}</dd></div>
            <div className={stats.hot.length ? 'bad' : ''}><dt>Over capacity</dt><dd>{stats.hot.length ? stats.hot.join(', ') : 'None'}</dd></div>
          </dl>
        )}
      </section>
      <SidePanel
        nodes={nodes}
        loads={loads}
        selected={selected}
        trace={trace}
        preview={preview}
        feed={feed}
        onSelect={select}
        onClear={clear}
        onDownstream={showDownstream}
        onTrip={(id, tripped) => act(() => api.trip(id, tripped))}
        onRewire={(id, parentId) => act(() => api.rewire(id, parentId))}
        loadBand={loadBand}
      />
    </div>
  );
}
