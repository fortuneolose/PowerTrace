# Phone page

A mobile-first, single HTML page, served at `/join` by either server. No build step.
It claims an equipment item after Socket.IO connects and keeps the tag in localStorage.
All mutations include `X-Socket-Id` and `X-Who: phone:<tag>`.

- Switch on/off, add 5 kW, or select a board and re-wire.
- Board options show phase, load percentage and trip status. Incompatible boards remain
  selectable so the backend can demonstrate its validation and explain a rejection.
- Changes from other clients update the card. A disconnect disables actions; reconnect
  reclaims the same tag and fetches the authoritative state.
- An upstream trip shows a full-screen pulsing outage alert and attempts vibration.
  The alert can be dismissed while the card continues to show the outage. Reduced-motion
  preferences disable pulsing. Power restoration is checked against the server so resetting
  one of several tripped ancestors does not falsely announce restored power.
- Demo reset reclaims the current tag; hospital reload events are ignored.

## Rehearse

Install the mock dependencies, run `npm run mock` at the repository root, and open
[the phone page](http://localhost:3000/join). Use two browsers to see shared updates.
For the planned AHU-07 demo, claim that tag by setting `powertrace:nodeId` in browser
localStorage to `AHU-07`, then reload. This is a rehearsal setup, not a phone-page control.

Check switch on/off, +5 kW, successful re-wire, and the rejection when three-phase
AHU-07 is moved to single-phase DB-L2-02. Trip SMSB-B using the presenter controls
(or the contract's trip endpoint), then reset it. Check reload, network reconnect,
joining while already tripped, and a full demo reset.

See [the demo runbook](../bot/DEMO.md) for tunnel, QR, fallback and video instructions.
