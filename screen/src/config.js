// The single base-URL setting. Dev: the backend (or /mock) on :3000. Production build: served by the
// backend itself, so same origin.
export const BASE_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');

// Where phones join. In the demo the screen is served through the tunnel, so same origin + /join is
// the public URL. Override with VITE_JOIN_URL in screen/.env.local if the screen runs elsewhere.
export const JOIN_URL = import.meta.env.VITE_JOIN_URL || `${BASE_URL || window.location.origin}/join`;
