// Live updates for the demo site (CONTRACT.md section 3).
// Change streams on `nodes` and `events` drive node:changed, loads and event. If change streams aren't
// available (a standalone server, not Atlas), we fall back to emitting straight from the route handlers.
import { boardLoads } from './graph.js';

export function createRealtime(io, getDemoDb) {
  let direct = false;
  let timer = null;
  let running = false;
  let again = false;

  // Recompute every board's load % and broadcast it. Coalesced, so a burst of changes = one query.
  function scheduleLoads() {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (running) { again = true; return; }
      running = true;
      try {
        const { pct } = await boardLoads(getDemoDb().collection('nodes'));
        io.emit('loads', pct);
      } catch (err) {
        console.error('[loads]', err.message);
      } finally {
        running = false;
        if (again) { again = false; scheduleLoads(); }
      }
    }, 60);
  }

  // Called by routes after a write. Only does anything in fallback mode; normally the change stream does it.
  function nodesChanged(site, nodes) {
    if (site !== 'demo' || !direct) return;
    for (const node of nodes) if (node) io.emit('node:changed', { node });
    scheduleLoads();
  }

  function eventRecorded(site, event) {
    if (site === 'demo' && direct) io.emit('event', event);
  }

  function watch(coll, pipeline, options, onChange, label) {
    const open = () => {
      if (direct) return;
      const stream = coll.watch(pipeline, options);
      stream.on('change', onChange);
      stream.on('error', (err) => {
        stream.close().catch(() => {});
        if (err.code === 40573 || /only supported on replica sets/i.test(err.message)) {
          if (!direct) console.warn(`[realtime] change streams unavailable (${err.message}); emitting from route handlers instead`);
          direct = true;
          return;
        }
        console.error(`[realtime] ${label} change stream error: ${err.message}; reopening`);
        setTimeout(open, 1000);
      });
    };
    open();
  }

  function start() {
    const db = getDemoDb();
    watch(db.collection('nodes'), [], { fullDocument: 'updateLookup' }, (change) => {
      if (change.fullDocument && ['insert', 'update', 'replace'].includes(change.operationType)) {
        io.emit('node:changed', { node: change.fullDocument });
      }
      scheduleLoads();
    }, 'nodes');
    watch(db.collection('events'), [{ $match: { operationType: 'insert' } }], {}, (change) => {
      io.emit('event', change.fullDocument);
    }, 'events');
    console.log('[realtime] watching demo nodes and events with change streams');
  }

  return { start, scheduleLoads, nodesChanged, eventRecorded, isDirect: () => direct };
}
