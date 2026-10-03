# /join (owner: agent 3)

The phone page. One HTML file, no build step, served by the backend (and the mock) at `/join`.
The Socket.IO client is loaded from `/socket.io/socket.io.js`, which the server provides.
Test locally: `npm run mock` from the repo root, then open http://localhost:3000/join (use your phone's
browser on the same Wi-Fi via your laptop's IP, or through the tunnel).
