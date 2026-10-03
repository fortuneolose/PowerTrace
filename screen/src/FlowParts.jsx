import { memo } from 'react';
import { BaseEdge, Handle, Position } from '@xyflow/react';
import { BUS_DROP, loadBand } from './layout.js';

export const BoardNode = memo(function BoardNode({ data }) {
  const { node, pct, cls, delay } = data;
  const kw = Math.round((pct / 100) * node.capacityKW);
  return (
    <div className={`board ${cls}`} style={{ '--delay': `${delay}ms` }}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="board-head">
        <span className="tag">{node._id}</span>
        <span className="pill" title={`${node.phases}-phase, ${node.voltage} V`}>{node.phases === 3 ? '3φ' : '1φ'} {node.voltage}V</span>
      </div>
      <div className="board-name">{node.name}</div>
      <div className="board-load">
        <div className="loadbar"><span className={loadBand(pct)} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
        <strong className={node.tripped ? 'is-tripped' : loadBand(pct)}>{node.tripped ? 'Tripped' : `${pct}%`}</strong>
      </div>
      <div className="board-foot">{node.tripped ? 'No supply downstream' : `${kw} / ${node.capacityKW} kW`}</div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

export const EquipNode = memo(function EquipNode({ data }) {
  const { node, cls, delay } = data;
  return (
    <div className={`equip ${cls}`} style={{ '--delay': `${delay}ms` }} title={node.name}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="state" aria-label={node.on ? 'On' : 'Off'} />
      <span className="tag">{node._id}</span>
      {node.claimedBy && (
        <svg className="phone" viewBox="0 0 10 14" aria-label="Controlled from a phone" role="img">
          <rect x="1" y="1" width="8" height="12" rx="2" />
          <line x1="4" y1="10.5" x2="6" y2="10.5" />
        </svg>
      )}
      <span className="kw">{node.on ? `${node.loadKW} kW` : 'Off'}</span>
    </div>
  );
});

// Orthogonal wiring. Boards drop to a bus line, then across and down; equipment hangs off a vertical
// bus on the left of its column. A second path on top carries moving pulses of "current" while the
// wire is energised, so the room can see power flowing and see it stop when a board trips.
export const WireEdge = memo(function WireEdge({ id, sourceX, sourceY, targetX, targetY, data }) {
  const busY = sourceY + BUS_DROP;
  const d = data.toEquipment
    ? `M${sourceX},${sourceY} V${busY} H${targetX - 12} V${targetY} H${targetX}`
    : `M${sourceX},${sourceY} V${busY} H${targetX} V${targetY}`;
  return (
    <>
      <BaseEdge id={id} path={d} className={`wire ${data.cls}`} style={{ '--delay': `${data.delay}ms` }} interactionWidth={0} />
      <path d={d} className={`current ${data.cls}`} style={{ '--delay': `${data.delay}ms` }} fill="none" />
    </>
  );
});

export const nodeTypes = { board: BoardNode, equip: EquipNode };
export const edgeTypes = { wire: WireEdge };
