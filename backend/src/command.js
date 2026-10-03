// Plain-English operator commands: "route power away from DB-L3-01" -> trip DB-L3-01.
// The command is only ever turned into one of the existing, validated actions (trip, reset, re-wire,
// switch on/off), so the same rules and live updates apply as when a button is pressed.
// With ANTHROPIC_API_KEY set, Claude reads the sentence; otherwise (or if that call fails) a small
// keyword parser does. The response says which one understood it.

const TAG = /\b(?:MSB|SMSB-[A-Z0-9]+|DB-L\d+-[A-Z0-9]+|[A-Z]{2,5}-L\d+-\d{1,3}|[A-Z]{2,5}-\d{1,3})\b/gi;
const CUT = /\b(away from|cut|isolate|de-?power|de-?energi[sz]e|shut ?down|shut off|switch off|turn off|kill|trip|disconnect|take .* off)\b/i;
const RESTORE = /\b(restore|re-?energi[sz]e|re-?power|power (?:back|up)|reset|turn on|switch on|back on|reconnect|bring .* back)\b/i;
const MOVE = /\b(re-?route|re-?wire|move|transfer|switch|feed)\b[\s\S]*\b(?:to|onto|from)\b/i;

export const EXAMPLES = [
  'Route power away from DB-L3-01',
  'Restore power to DB-L3-01',
  'Isolate SMSB-B',
  'Move AHU-07 onto DB-L2-01',
  'Switch off EV-02',
  'Reset LTG-L1-02',
];

// Demo fallback: a command that names no board we recognise acts on this sub-main (the demo's fault board).
export const FAULT_BOARD = process.env.DEMO_FAULT_BOARD || 'SMSB-B';
export function fallbackCommand(text) {
  return RESTORE.test(String(text)) ? { action: 'reset', target: FAULT_BOARD } : { action: 'trip', target: FAULT_BOARD };
}

// -> { action: 'trip'|'reset'|'rewire'|'toggle', target, to?, on? } or { error }
export function parseCommand(text, byId = new Map()) {
  text = String(text).replace(/\b([A-Za-z]{2,5})[\s_]+(L\d+-\d{1,3})\b/gi, '$1-$2'); // "ltg l1-02" -> "ltg-l1-02"
  const tags = [...String(text).matchAll(TAG)].map((m) => m[0].toUpperCase()).filter((t) => byId.size === 0 || byId.has(t));
  if (!tags.length) return { error: 'Name a board or piece of equipment, for example DB-L3-01 or AHU-07.' };
  const [target, second] = tags;
  const type = byId.get(target)?.type ?? (/^(MSB|SMSB|DB)/.test(target) ? 'board' : 'equipment');

  if (second && MOVE.test(text)) return { action: 'rewire', target, to: second };
  if (type !== 'board' && /\b(reset|normal|default)\b/i.test(text)) return { action: 'restore', target };
  if (RESTORE.test(text)) return type === 'board' ? { action: 'reset', target } : { action: 'toggle', target, on: true };
  if (CUT.test(text)) return type === 'board' ? { action: 'trip', target } : { action: 'toggle', target, on: false };
  return { error: `I found ${target} but not what to do with it. Try "route power away from ${target}" or "restore ${target}".` };
}

// Claude reads the sentence and returns the same shape. Any failure returns null (the caller falls back).
export async function parseWithClaude(text, byId) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const boards = [...byId.values()].filter((n) => n.type === 'board').map((n) => n._id).join(', ');
  const prompt = `You control a building's power distribution. Boards: ${boards}. Equipment tags look like AHU-07.
Turn the operator's instruction into exactly one JSON object and nothing else:
{"action":"trip","target":"<board>"}  cut / isolate / route power away from a board
{"action":"reset","target":"<board>"}  restore power to a board
{"action":"rewire","target":"<tag>","to":"<board>"}  move something onto another board
{"action":"toggle","target":"<equipment>","on":true|false}  switch one item on or off
{"action":"restore","target":"<equipment>"}  reset one item to normal
{"error":"<one short sentence>"}  if the instruction is unclear
Instruction: ${text}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.content?.map((c) => c.text ?? '').join('') ?? '';
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (json.error) return { error: String(json.error) };
    if (!['trip', 'reset', 'rewire', 'toggle', 'restore'].includes(json.action) || typeof json.target !== 'string') return null;
    const out = { action: json.action, target: json.target.toUpperCase() };
    if (json.action === 'rewire') out.to = String(json.to ?? '').toUpperCase();
    if (json.action === 'toggle') out.on = json.on !== false;
    return out;
  } catch {
    return null;
  }
}

// The existing REST call each action maps to.
export function toRequest(cmd) {
  const id = encodeURIComponent(cmd.target);
  switch (cmd.action) {
    case 'trip': return { path: `/api/boards/${id}/trip`, body: { tripped: true } };
    case 'reset': return { path: `/api/boards/${id}/trip`, body: { tripped: false } };
    case 'rewire': return { path: `/api/nodes/${id}/rewire`, body: { parentId: cmd.to } };
    case 'toggle': return { path: `/api/nodes/${id}/toggle`, body: { on: cmd.on } };
    case 'restore': return { path: `/api/nodes/${id}/restore`, body: {} };
    default: return null;
  }
}

// One line for the operator, from the action and the existing route's response.
export function describe(cmd, status, json) {
  if (status >= 400) return json?.error ?? `That didn't work (${status}).`;
  switch (cmd.action) {
    case 'trip': return `Routed power away from ${cmd.target}: ${json.affected.length} items downstream are now without power.`;
    case 'reset': return `Power restored to ${cmd.target}: ${json.affected.length} items downstream are back on.`;
    case 'rewire': return `${cmd.target} is now fed from ${cmd.to} (was ${json.from}).`;
    case 'toggle': return `${cmd.target} switched ${json.node?.on ? 'on' : 'off'}.`;
    case 'restore': return `${cmd.target} is back to normal: ${json.node?.loadKW} kW on ${json.node?.parentId}.`;
    default: return 'Done.';
  }
}
