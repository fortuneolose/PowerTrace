import { io } from 'socket.io-client';
import { BASE_URL } from './config.js';

export const socket = io(BASE_URL || undefined);

async function request(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Socket-Id': socket.id ?? '',
      'X-Who': 'presenter',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText || 'Request failed'), { code: data.code, status: res.status });
  return data;
}

export const api = {
  tree: (site = 'demo') => request('GET', `/api/tree?site=${site}`),
  traceUp: (id, site = 'demo') => request('GET', `/api/trace/up/${encodeURIComponent(id)}?site=${site}`),
  traceDown: (id, site = 'demo') => request('GET', `/api/trace/down/${encodeURIComponent(id)}?site=${site}`),
  impact: (id) => request('GET', `/api/impact/${encodeURIComponent(id)}?site=hospital`),
  trip: (id, tripped) => request('POST', `/api/boards/${encodeURIComponent(id)}/trip`, tripped === undefined ? {} : { tripped }),
  rewire: (id, parentId) => request('POST', `/api/nodes/${encodeURIComponent(id)}/rewire`, { parentId }),
  reset: () => request('POST', '/api/reset?site=demo'),
};
