// "#/hospital" The scale view: ~300 boards and ~4,000 items. Levels are collapsed by default and only
// boards are listed (equipment is counted, never rendered), so the page stays light.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, socket } from './api.js';
import { loadBand } from './layout.js';

const levelName = (l) => (l === 0 ? 'Ground and plant' : `Level ${l}`);
const byTag = (a, b) => a._id.localeCompare(b._id, undefined, { numeric: true });

export default function HospitalView({ onToast }) {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [selected, setSelected] = useState(null);
  const [impact, setImpact] = useState(null);
  const [loadingImpact, setLoadingImpact] = useState(false);

  const load = useCallback(() => {
    api.tree('hospital').then((t) => { setTree(t); setError(null); }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const onReload = ({ site }) => { if (site === 'hospital') { setImpact(null); setSelected(null); load(); } };
    socket.on('tree:reload', onReload);
    return () => socket.off('tree:reload', onReload);
  }, [load]);

  // One pass over the nodes: boards per level, child boards, direct equipment counts.
  const model = useMemo(() => {
    if (!tree) return null;
    const boards = new Map();
    const levelStats = new Map();
    const directItems = new Map();
    for (const n of tree.nodes) {
      const s = levelStats.get(n.level) ?? { boards: 0, items: 0 };
      if (n.type === 'board') { boards.set(n._id, n); s.boards += 1; } else { s.items += 1; directItems.set(n.parentId, (directItems.get(n.parentId) ?? 0) + 1); }
      levelStats.set(n.level, s);
    }
    const children = new Map();
    for (const b of boards.values()) {
      if (!children.has(b.parentId)) children.set(b.parentId, []);
      children.get(b.parentId).push(b);
    }
    for (const list of children.values()) list.sort(byTag);
    const levels = [...levelStats.keys()].sort((a, b) => a - b);
    return { boards, children, levelStats, directItems, levels, total: tree.nodes.length };
  }, [tree]);

  const pick = useCallback(async (id) => {
    setSelected(id);
    setLoadingImpact(true);
    try {
      setImpact(await api.impact(id));
    } catch (e) {
      setImpact(null);
      onToast({ kind: 'reject', title: 'Impact report failed', text: e.message });
    } finally {
      setLoadingImpact(false);
    }
  }, [onToast]);

  const toggle = (level) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(level)) next.delete(level); else next.add(level);
    return next;
  });

  if (error) {
    return <div className="empty"><h2>Can't load the hospital</h2><p>{error}</p></div>;
  }
  if (!model) return <div className="empty"><p>Loading the hospital…</p></div>;
  if (model.total === 0) {
    return (
      <div className="empty">
        <h2>The hospital is empty</h2>
        <p>Seed it with <code>npm run seed:hospital</code>, or import a cable schedule into it.</p>
      </div>
    );
  }

  // Roots on a level: boards on that level whose feeder is on another level (or nothing).
  const rootsOn = (level) => [...model.boards.values()]
    .filter((b) => b.level === level && model.boards.get(b.parentId)?.level !== level)
    .sort(byTag);

  const renderBoard = (b, depth) => {
    const pct = tree.loads[b._id] ?? 0;
    const kids = (model.children.get(b._id) ?? []).filter((c) => c.level === b.level);
    return (
      <li key={b._id}>
        <button
          type="button"
          className={`hrow ${selected === b._id ? 'selected' : ''} ${b.tripped ? 'tripped' : ''}`}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => pick(b._id)}
        >
          <span className="tag">{b._id}</span>
          <span className="hname">{b.name}</span>
          <span className="hcount">{model.directItems.get(b._id) ?? 0} items</span>
          <span className="minibar"><span className={loadBand(pct)} style={{ width: `${Math.min(pct, 100)}%` }} /></span>
          <span className={`hpct ${loadBand(pct)}`}>{b.tripped ? 'Tripped' : `${pct}%`}</span>
        </button>
        {kids.length > 0 && <ul>{kids.map((k) => renderBoard(k, depth + 1))}</ul>}
      </li>
    );
  };

  const affectedBoards = impact?.affected.filter((a) => a.type === 'board') ?? [];

  return (
    <div className="hospital">
      <section className="levels" aria-label="Boards by level">
        <header className="hosp-head">
          <h2>Synthetic hospital</h2>
          <p className="muted">{model.boards.size} boards, {model.total - model.boards.size} pieces of equipment, {model.levels.length} levels. Same collection, same queries as the demo building.</p>
        </header>
        <ul className="level-list">
          {model.levels.map((level) => {
            const s = model.levelStats.get(level);
            const isOpen = open.has(level);
            return (
              <li key={level}>
                <button type="button" className="level-head" aria-expanded={isOpen} onClick={() => toggle(level)}>
                  <span className="chev" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                  <span className="lname">{levelName(level)}</span>
                  <span className="muted">{s.boards} boards, {s.items} items</span>
                </button>
                {isOpen && <ul className="board-list">{rootsOn(level).map((b) => renderBoard(b, 0))}</ul>}
              </li>
            );
          })}
        </ul>
      </section>

      <aside className="rail">
        <section className="card selection" aria-live="polite">
          {!selected && <p className="hint">Open a level and pick a board to see everything a planned shutdown would take out.</p>}
          {selected && loadingImpact && !impact && <p className="muted">Tracing {selected}…</p>}
          {impact && (
            <>
              <h2>If {impact.boardId} is isolated</h2>
              <p className="muted">{model.boards.get(impact.boardId)?.name}</p>
              <div className="counts">
                <div><strong>{impact.counts.equipment}</strong><span>items lose power</span></div>
                <div><strong>{impact.counts.boards}</strong><span>boards below it</span></div>
                <div className={impact.counts.critical ? 'bad' : ''}><strong>{impact.counts.critical}</strong><span>critical</span></div>
                <div><strong>{impact.totalKW}</strong><span>kW running</span></div>
              </div>
              <p className="query">$graphLookup over {model.total.toLocaleString()} nodes: {impact.queryMs} ms in MongoDB</p>
              {impact.critical.length > 0 && (
                <>
                  <h3>Critical loads</h3>
                  <ul className="crit-list">
                    {impact.critical.map((c) => (
                      <li key={c._id}><span className="tag">{c._id}</span><span>{c.name}</span><span className="muted">via {c.parentId}</span></li>
                    ))}
                  </ul>
                </>
              )}
              {affectedBoards.length > 0 && (
                <>
                  <h3>Boards that go dark</h3>
                  <ul className="plain">
                    {affectedBoards.map((b) => (
                      <li key={b._id}>
                        <button type="button" className="link" onClick={() => pick(b._id)}>{b._id}</button>
                        <span className="muted"> {b.name}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
