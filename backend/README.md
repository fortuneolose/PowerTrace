# /backend (owner: agent 4)

Express + Socket.IO + the official `mongodb` driver. Implements [CONTRACT.md](../CONTRACT.md).

```bash
npm install
npm run dev        # node --watch src/index.js, reads MONGODB_URI from the root .env
```

- `src/config.js`: env (root `.env`), database names per site
- `src/db.js`: `connect()`, `getDb(site)` (`?site=demo|hospital`)
- `src/schema.js`: `$jsonSchema` validator + indexes. Also used by `/data` seed scripts, so keep it dependency-free.
- `src/index.js`: server, static `/join` and built `/screen`, route stubs (501 until implemented)

Reference behaviour: `/mock/server.js` implements the same contract in memory.
