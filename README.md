# Sky Surf — Meridian

Counter-Strike surf, reborn as a browser racing game. Everyone on the server launches together, surfs the same six-stage course of curved ramps, a helix and a 3,000-unit drop, and the first across the finish **owns a holographic billboard on the course** that every player flies past, every round, until someone takes the slot. The server record holder owns the biggest one, at the start gate. The record run is rendered as a ghost glider so there is always a second to shave.

- **Client:** TypeScript, Three.js on **WebGPU** (automatic WebGL2 fallback) with bloom, ambient occlusion, motion blur, chromatic aberration, lens flare and a physical sky; synthesized audio; full-screen play.
- **Server:** Rust (tokio + axum). One game-loop task owns all state; sockets talk to it over channels; 2,000 players on ~1 core.
- **Physics:** the movement code is a port of Source's `gamemovement.cpp`, so it feels like CS surf; collision is Quake-style brush tracing with seam handling for curved ramps.
- **Level:** `levels/build.mjs` walks the course with a turtle (`straight`, `turn`, `gap`, `stage`, `boost`), emitting mitered ramp prisms, the ideal racing line, neon edge strips and billboard slots.

## Run it locally

```sh
cd client && npm install && cd ..
node levels/build.mjs                                     # regenerate levels/meridian.json after editing build.mjs
cargo run --release --manifest-path server/Cargo.toml     # from the repo root: game server on :8080 (serves client/dist)
(cd client && npm run dev)                                # http://localhost:5173 with hot reload, proxies /ws and /img
```

Without the server the client still runs in solo mode (no rounds, no billboards).

Tests:

```sh
(cd client && npm test)    # physics: 0.7 ground rule, strafe gain, no tunneling, seam handling on curves, booster,
                           #          every stage completable from a standing start, a full run finishes with no fails
(cd server && cargo test)  # protocol, triggers, run validation, placement, late joiners, billboard slots, record ghost persistence, filters
```

## Controls (same as CS surf)

| | |
|---|---|
| `A` / `D` + mouse | surf: hold the strafe key *into* the ramp and steer with the mouse. Never `W` on a ramp. Look where you're going; strafe toward where you want the velocity to curve |
| `Space` | jump |
| `C` or `Ctrl` | duck |
| `F` | restart the current stage |
| `G` | toggle the record ghost |
| `V` | first/third person |
| `Tab` | scoreboard |
| `F11` / `Alt+Enter` | full screen |

Mouse sensitivity uses CS units (`sensitivity × 0.022°` per count).

## A round

1. **Lobby (20 s)** — a cinematic flythrough of the course, past every billboard, then 3-2-1-GO.
2. **Race** — everyone launches from the start gate at once. Leave the gate and your clock starts. Fall off and you restart the stage (with your speed gone). The round ends 30 s after the first finisher, or at 4 minutes. Late joiners race for a personal time but can't place.
3. **Podium** — top three with flags and sponsors, the winner's billboard, and a share link (`/?billboard=<slot>` opens the game looking at it).

The winner's billboard shows their uploaded image, name and sponsor immediately; they get a form to add an 80-character line and an `https` link. A win claims the lowest free slot of seven; when all are taken it bumps the oldest. The server record holder gets slot 0 at the start gate until beaten.

## The course: Meridian

Six stages, each teaching one idea, escalating: **The Launch** (one steep ramp into a committed gap), **The Serpent** (long S-bends with real airtime), **Transfers** (alternating ramps with widening gaps), **The Helix** (540° around a tower, with a skip for the brave), **The Gauntlet** (a safe low line or a narrow high line with a booster) and **The Drop** (walk off the edge, fall 3,000 units onto one huge ramp, get slung through the finish).

Design rules learned the hard way, encoded in the generator and the tests: in a bend only the inside face can hold you, and a strafe alone holds a turn of radius ≥ v²/3000, so openings are wide and the racing line hugs the inside face; stage gates are tall because arrivals fly far above the platforms; a diving arrival needs the next platform well below the flight path.

## Architecture notes

- **Movement is client-authoritative** for perfect feel. The server validates runs (checkpoint order, a max-speed displacement check, teleports only to earned spawns, a per-level `minRunMs` floor) and measures times itself. A modified client can still fake a run inside those limits; server-authoritative movement would close that.
- **Interest management:** players are bucketed into 2048-unit cells; each 3×3×3 neighbourhood is encoded once per 20 Hz tick, capped with a rotating window, and shared by everyone in the cell. Slow clients drop frames instead of buffering.
- **Ghost:** the server records each in-progress run at 10 Hz only while it could still beat the record; a new record's recording becomes the ghost (persisted as `data/ghost.bin`).
- **Images** (flags/billboards) are cropped and re-encoded in the browser (≤48 KB JPEG), uploaded over the socket, served content-addressed from `/img/<hash>`, and only persisted while a billboard or the record references them.

### Load test

`cargo run --release --bin bots -- <count> ws://host/ws <seconds> levels/meridian.json` with the server started with `MAX_CONN_PER_IP=100000`. Bots ride the racing line at surf speeds. On an M3 Pro: 2,000 bots ≈ 1.1 cores, 305 MB, 22 KB/s per client, 43 MB/s total out. Bandwidth, not CPU, is the ceiling on a small droplet.

## Deploy (second Kamal service on the blog droplet)

1. DNS: `A` record `surf.akdarrah.com → 142.93.201.166`.
2. `export SURFING_ADMIN_TOKEN=$(openssl rand -hex 24)`.
3. `kamal setup` the first time, then `kamal deploy`. The image cross-compiles natively into `scratch`.
4. Embed in a post (the blog's CSP needs akdarrah/akdarrah#8):

   ```html
   <iframe src="https://surf.akdarrah.com/" title="Sky Surf" allow="pointer-lock; fullscreen"
     style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px"></iframe>
   ```

Moderation (players can also hide all player images or mute individuals from the menu):

```sh
A="Authorization: Bearer $SURFING_ADMIN_TOKEN"
curl -H "$A" https://surf.akdarrah.com/admin/billboards                      # list billboards + record (image URL, text, name, sponsor, IP)
curl -X POST -H "$A" https://surf.akdarrah.com/admin/billboards/3/remove
curl -X POST -H "$A" "https://surf.akdarrah.com/admin/ban?ip=1.2.3.4"        # kicks, bans, removes their billboards
curl -X POST -H "$A" https://surf.akdarrah.com/admin/clear-images            # resets everyone's flag
```

Leaderboards, billboards, record and bans persist in the `surfing_data` volume.
