# Alex's demo runbook

## Local rehearsal

1. Install mock and bot dependencies: `npm --prefix mock install` and `npm --prefix bot install`.
2. Run `npm run mock`. Open `http://localhost:3000/join` and verify a claim and all three actions.
3. Run `npm run bot -- --n 30 --url http://localhost:3000 --duration 60` for the fallback.
4. Stop the bot before resetting the demo or recording controlled actions.
5. Start the finished main screen using `npm run screen` for local development. For a
   single public origin, the screen owner builds with `npm run build:screen` and the
   server must then be restarted so it discovers `screen/dist`.

The current branch's backend and main screen are scaffolds. The mock demonstrates
phones and bot today; a final Atlas recording depends on the other owners' completed work.
The missing hospital and import modules belong to the lead. Do not describe a mock
recording as a live MongoDB demonstration.

## Phones through a tunnel

With cloudflared available, leave the API running on port 3000 and run in another terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the HTTPS URL that cloudflared prints, then run:

```bash
npm run qr -- https://YOUR-URL.trycloudflare.com/join
```

Keep both terminals running. A new quick-tunnel session generates a new URL, so regenerate
its QR. Scan it from a phone using mobile data to verify access outside the laptop's Wi-Fi.
Check the claim, a button action, and live outage/restoration before showing the QR to the room.
The public tunnel exposes the demo API, including reset and import; use disposable demo data
and stop the tunnel when the demonstration ends. No credentials belong in the public URL.

If cloudflared is not installed, use the official installation instructions linked below.
On this machine its executable was not available during implementation. No public tunnel
or final QR URL has been provisioned yet.

If the venue connection fails, use the local bot and presenter laptop. Phones on the same
Wi-Fi can try `http://LAPTOP-LAN-IP:3000/join`, subject to venue isolation and Windows firewall.
The fallback command still works without audience phones. If Atlas is unavailable, explicitly
label the run as an in-memory rehearsal.

## Stage sequence and acceptance checklist

- Reset the demo, start the completed screen, and have phones scan the current QR.
- AHU-07 begins at 15 kW on DB-L3-01. Toggle it and show load bars changing.
- Add 5 kW repeatedly to take its board into amber and red.
- Try re-wiring AHU-07 to DB-L2-02: show the single-phase rejection on the phone.
- Trip SMSB-B: affected phones show YOU'VE LOST POWER; unrelated phones keep working.
- Reset SMSB-B: affected phones show Power restored.
- Test nested trips: trip DB-L3-01 and SMSB-B, reset only SMSB-B, verify AHU-07 still
  has no power, then reset DB-L3-01 and verify restoration.
- Re-wire to a tripped supply and back to a live one; confirm the supply state follows.
- Reload a phone, briefly disconnect/reconnect, and reset the entire demo. Confirm the
  equipment tag stays the same, controls recover, and initial state returns.
- Finish with the completed hospital impact view and MongoDB query timing, after the
  lead and backend owner verify those features.

## Video script (about 90 seconds)

| Time | Shot | Narration |
| --- | --- | --- |
| 0–12 s | Building graph and title | On a building project, answering what a board feeds can mean comparing several spreadsheets. PowerTrace makes the electrical dependencies visible. |
| 12–27 s | Phone scans QR and claims equipment | Everyone joins from a browser and controls a piece of equipment. Changes appear on the shared screen. |
| 27–42 s | Toggle and add load | Loads are added across the equipment downstream. The board moves from green to amber and red as its capacity fills. |
| 42–55 s | AHU-07 to DB-L2-02 rejected | This is three-phase equipment. The single-phase board rejects the move and explains why. |
| 55–70 s | Trip SMSB-B and phone outage; reset | Trip a board and see everything that loses power. Reset it and the phones recover. |
| 70–85 s | Finished hospital impact panel | The same model scales to a hospital. MongoDB graph traversal identifies affected equipment and critical loads. |
| 85–90 s | Title and team | PowerTrace: know what feeds it, and what depends on it. |

Record the final integration with Atlas connected; keep a mock rehearsal recording labelled
as such. Avoid recording `.env`, connection strings, credentials, or private team notes.
Use the browser's phone emulation or an actual phone for the close-ups. Record at 1080p,
check legibility and audio, and review the exported file before submission. The final video
requires the finished shared screen, Atlas backend, and the event's submission destination.

## Handoff

Alex's implementation is confined to `/join` and `/bot`. The lead can link this runbook
from the root README when polishing the submission. README coordination, final public URL,
and final video upload remain team integration steps.

Official tunnel reference: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/

