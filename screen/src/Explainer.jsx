// Audience-facing help on the big screen: a "how this works" panel in the side rail (shown whenever
// nothing is selected), and a caption that says what just happened in plain English.
import { useEffect, useState } from 'react';

export function Explainer() {
  return (
    <div className="explainer">
      <h2>How this works</h2>
      <p className="explainer-lede">
        This is a building's power system, live. Power flows from the main switchboard at the top, through
        boards, down to every piece of equipment.
      </p>
      <ol className="steps">
        <li><strong>Scan the QR code above.</strong> Your phone becomes one piece of equipment in this building.</li>
        <li><strong>Switch it, add load, or move it.</strong> Every change is saved in MongoDB and shows up here instantly.</li>
        <li><strong>Watch the boards.</strong> Overload one and it turns red. Unsafe moves are refused.</li>
      </ol>
      <ul className="legend">
        <li><span className="key flow" />Power flowing</li>
        <li><span className="key dead" />No power</li>
        <li><span className="key path" />Supply path</li>
        <li><span className="key bar"><i /></span>Board load</li>
      </ul>
      <p className="explainer-foot">Tap any box to trace where its power comes from.</p>
    </div>
  );
}

const pctText = (pct) => (pct > 100 ? `${pct}%, over capacity` : `${pct}% loaded`);

// One sentence about the latest change, written for someone who has never seen a single-line diagram.
export function narrate(e, nodes, loads) {
  if (!e) return null;
  const node = nodes?.[e.nodeId];
  const board = node?.parentId;
  const who = e.who?.startsWith('phone:') ? 'A phone' : e.who === 'presenter' ? 'The presenter' : e.who?.startsWith('bot-') ? 'A simulated contractor' : 'Someone';
  switch (e.action) {
    case 'claim':
      return { text: `Someone just joined as ${e.nodeId}${node ? `, the ${node.name.toLowerCase()}` : ''}.`, note: 'Their phone now controls it.' };
    case 'toggle':
      return { text: `${who} switched ${e.nodeId} ${e.to}.`, note: board ? `${board} is now ${pctText(loads[board] ?? 0)}.` : null };
    case 'load':
      return {
        text: `${who} ${Number(e.to) > Number(e.from) ? 'added' : 'removed'} load on ${e.nodeId}: it now draws ${e.to} kW.`,
        note: board ? `${board} is now ${pctText(loads[board] ?? 0)}.` : null,
        bad: board && (loads[board] ?? 0) > 100,
      };
    case 'rewire':
      return { text: `${who} moved ${e.nodeId} from ${e.from} to ${e.to}.`, note: 'MongoDB re-checked the whole feed before allowing it.' };
    case 'trip':
      return { text: `${e.nodeId} tripped. Everything it feeds has lost power.`, note: 'One $graphLookup query found every affected item.', bad: true };
    case 'reset':
      return { text: `${e.nodeId} was reset. Power is back on downstream.`, note: null };
    case 'import':
      return { text: `A cable schedule was imported: ${e.to}.`, note: null };
    default:
      return null;
  }
}

export function Caption({ line }) {
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (!line) return undefined;
    setShown(line);
    const t = setTimeout(() => setShown(null), 9000);
    return () => clearTimeout(t);
  }, [line]);
  const current = shown ?? { text: 'Scan the QR code to take control of a piece of equipment.', note: null, idle: true };
  return (
    <div className={`caption ${current.bad ? 'bad' : ''} ${current.idle ? 'idle' : ''}`} role="status" aria-live="polite" key={current.text}>
      <span className="caption-dot" aria-hidden="true" />
      <p>
        <span className="caption-text">{current.text}</span>
        {current.note && <span className="caption-note">{current.note}</span>}
      </p>
    </div>
  );
}
