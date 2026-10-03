# /screen (owner: agent 2)

Main screen: React + Vite + React Flow (`@xyflow/react`) + dagre.

```bash
npm install
npm run dev        # http://localhost:5173, talks to http://localhost:3000 (backend or `npm run mock`)
npm run build      # dist/ is served by the backend at / for the demo
```

The base URL is the single setting in `src/config.js` (override with `VITE_API_URL` in `screen/.env.local`).
Views: `#/` live demo building, `#/hospital` the scale view.
