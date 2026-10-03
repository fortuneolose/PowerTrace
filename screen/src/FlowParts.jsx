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
        <span className="phase" title={`${node.phases}-phase, ${node.voltage} V`}>{node.phases === 3 ? '3-phase' : '1-phase'}</span>
      </div>
      <div className="board-name">{node.name}</div>
      <div className="loadbar"><span className={loadBand(pct)} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
      <div className="board-foot">
        <span>{node.tripped ? 'Off' : `${kw} of ${node.capacityKW} kW`}</span>
        <strong className={node.tripped ? 'is-tripped' : loadBand(pct)}>{node.tripped ? 'Tripped' : `${pct}%`}</strong>
      </div>
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
      {node.claimedBy && <span className="phone" title="Claimed by a phone" aria-label="Claimed by a phone" />}
      <span className="kw">{node.on ? `${node.loadKW} kW` : 'off'}</span>
    </div>
  );
});

// Orthogonal wiring. Boards drop to a bus line, then across and down; equipment hangs off a
// vertical bus on the left of its column.
export const WireEdge = memo(function WireEdge({ id, sourceX, sourceY, targetX, targetY, data }) {
  const busY = sourceY + BUS_DROP;
  const d = data.toEquipment
    ? `M${sourceX},${sourceY} V${busY} H${targetX - 12} V${targetY} H${targetX}`
    : `M${sourceX},${sourceY} V${busY} H${targetX} V${targetY}`;
  return <BaseEdge id={id} path={d} className={`wire ${data.cls}`} style={{ '--delay': `${data.delay}ms` }} />;
});

export const nodeTypes = { board: BoardNode, equip: EquipNode };
export const edgeTypes = { wire: WireEdge };
