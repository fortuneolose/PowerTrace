# Contractor bot and QR

From the repository root:

```bash
npm --prefix bot install
npm run bot -- --n 30 --url http://localhost:3000
npm run bot -- --n 30 --url http://localhost:3000 --duration 60
npm run qr -- https://your-tunnel.trycloudflare.com/join
npm --prefix bot test
```

Each contractor connects with its own Socket.IO client, claims equipment, and makes
one random toggle, load change (+5 or -5 kW), or re-wire every 1–3 seconds. Actions
use the same contract and identity headers as phones. Rejections are expected during
random re-wiring and are counted separately from errors. A summary prints every ten
seconds and at shutdown. Ctrl+C disconnects clients and stops their timers. The mock
releases their claims on disconnect. Reconnect and demo reset reclaim the same tags.

`--n` defaults to 30 (range 1–500). `--url` defaults to `BOT_URL` from the environment
or root `.env`, then `http://localhost:3000`. `--duration` is optional, in seconds;
zero runs until stopped. `--help` prints usage. Requests time out after ten seconds.
Load changes include reductions so a long rehearsal does not only accumulate load.

The QR script accepts an explicit URL or root `.env`'s `PUBLIC_URL`. A bare origin
gets `/join` appended. An explicit path and query are preserved. It prints both a
terminal QR and the exact URL; HTTP(S) only, with no embedded credentials.

See [DEMO.md](DEMO.md) for the tunnel, rehearsal checklist and recording script.
