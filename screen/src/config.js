// The single base-URL setting. Dev: the backend (or /mock) on :3000. Production build: served by the
// backend itself, so same origin.
export const BASE_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');
