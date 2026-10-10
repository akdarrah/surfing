# Sky Surf — Meridian

Counter-Strike surf, reborn as a browser racing game. Every two minutes everyone on the server launches together and surfs the same six-stage course of curved ramps, a spiral around a tower and a drop onto one huge ramp, thousands of units above a sea of cloud, with floating rocks, distant megastructures and giant creatures drifting through the scenery. Dotted around the course are **spray walls**: reach one, press `T`, and your spray stays on it for everyone until someone else paints over it. The best ones are off the racing line: a floating island beside a bend, a crown you jump onto from the top of the spiral, a ledge under the drop, a column past the finish you only reach by carrying speed through the line. The server record run is rendered as a ghost glider so there is always a second to shave.

- **Client:** TypeScript, Three.js on **WebGPU** (automatic WebGL2 fallback) with bloom, ambient occlusion, motion blur, chromatic aberration, lens flare and a physical sky; synthesized audio; full-screen play.
- **Server:** Rust (tokio + axum). One game-loop task owns all state; sockets talk to it over channels; 2,000 players on ~1 core.
- **Physics:** the movement code is a port of Source's `gamemovement.cpp`, so it feels like CS surf; collision is Quake-style brush tracing with seam handling for curved ramps.
- **Level:** `levels/build.mjs` walks the course with a turtle (`straight`, `turn`, `gap`, `stage`, `boost`, `wall`, `perch`), emitting mitered ramp prisms, the ideal racing line, neon edge strips, spray walls and side routes.

## Run it locally

```sh
cd client && npm install && cd ..
node levels/build.mjs                                     # regenerate levels/meridian.json after editing build.mjs
NPC_COUNT=6 cargo run --release --manifest-path server/Cargo.toml   # from the repo root: game server on :8080 (serves client/dist)
(cd client && npm run dev)                                # http://localhost:5173 with hot reload, proxies /ws and /img
```

`NPC_COUNT` (default 6, `0` disables) adds bot racers so a quiet server still has a race. They ride the racing line at 2,300–3,400 u/s with their own mistakes, chat canned lines, can win a round, but never set the record and never paint walls. Without the server the client still runs in solo mode (no rounds, no walls, no chat).

Tests:

```sh
(cd client && npm test)    # physics: 0.7 ground rule, strafe gain, no tunneling, seam handling on curves, booster,
                           #          every stage completable from a standing start, 8 jittered full runs with no fails,
                           #          the Crow's Nest and Finish Lookout side routes are reachable
(cd server && cargo test)  # protocol, triggers, run validation, the 2:00 round loop, free-for-all walls, NPC placement, chat rate limit
```

## Controls (same as CS surf)

| | |
|---|---|
| `A` / `D` + mouse | surf: hold the strafe key *into* the ramp and steer with the mouse. Never `W` on a ramp. Look where you're going; strafe toward where you want the velocity to curve |
| `Space` | jump |
| `C` or `Ctrl` | duck |
| `F` | restart the current stage |
| `T` | spray. Near a spray wall it paints the wall; anywhere else it's a CS-style spray on the ramp (one per player, 15 s cooldown, gone when you leave) |
| `Y` | chat (`Enter` sends, `Esc` cancels) |
| `G` | toggle the record ghost |
| `V` | first/third person |
| `Tab` | scoreboard |
| `F11` / `Alt+Enter` | full screen |

Mouse sensitivity uses CS units (`sensitivity × 0.022°` per count).

## A round

Exactly two minutes, repeating:

1. **Lobby (15 s)** — nobody can surf. A flythrough of the course, the previous round's podium, then 3-2-1-GO.
2. **Race (1:45)** — everyone launches from the start pad at once. Leave the pad and your clock starts. Fall off and you restart the stage (with your speed gone). First valid finisher wins the round; late joiners race for a personal time but can't place.

Joining asks for a callsign (anything up to 24 characters) and a spray: eight built-ins (skull, bolt, flame, GG, cat, smiley, crossed boards, SURF) or upload your own PNG. Sprays are re-encoded in the browser to 128×128 and served content-addressed from `/img/<hash>`.

## Spray walls

Thirteen walls. Seven sit beside the racing line (painting one mid-race costs you speed, so it's a choice between the clock and the wall); the rest are the reason to leave it:

| | How to get there |
|---|---|
| Serpent Island | fly straight off the outside of the Serpent's apex |
| Crow's Nest | at the top of the Helix, ride the outer face and jump off it |
| Helix Tower | anywhere in the spiral |
| High Line | the Gauntlet's narrow upper ramp with the booster, to its dead end |
| Under the Drop | veer left off the Drop's edge onto the ledge instead of the long fall |
| Finish Lookout | bunny-hop the finish landing so the flat doesn't eat your speed, fly off the end of the platform |

Every wall is free-for-all: whoever reaches it and presses `T` owns it until someone paints over it. `/?wall=N` opens the game looking at wall N.

## The course: Meridian

Six stages, each teaching one idea, escalating: **The Launch** (one steep ramp and a drop onto a landing ramp pitched to meet the dive), **The Serpent** (long S-bends, with gently climbing straights so you cross the ridge onto the next inside face), **Transfers** (a staircase of offset ramps), **The Helix** (a long climb into a widening 450° spiral around a tower, with the Crow's Nest above it), **The Gauntlet** (a safe low line or the narrow high line with a booster) and **The Drop** (launch off the edge, cross a 3,000-unit gap onto one huge 28° ramp, get slung through the finish).

Design rules learned the hard way, encoded in the generator (`levels/build.mjs`) and the tests:

- The ridge is continuous from the first ramp to the finish; stage pads are bridges 350 units above it that arrivals surf under and standing starts drop off. A pad in the line is never at a safe height, because a rider sits anywhere from the ridge to a ramp-height below it.
- A surfer can only recover toward the ridge at ~500 u/s² of lateral acceleration, and a concave pitch change shoves a face-rider outward by about `0.46 · v · Δ`. So pitch changes are eased along a ~4,500-unit radius, nothing eases out of a steep ramp at 4,000 u/s, and a landing ramp is pitched to the angle the dive arrives at.
- Crossing the ridge always hops you off it; on a climbing straight the hop comes straight back down, on a descent it becomes a long float into a steep landing. The racing line hugs one face through each straight and flips at the end of the straight before a bend.
- A banked face holds a turn up to `v² ≈ r · g · tanφ` (about 15% over); the course profiles (56° and 66° faces, all 1,280 wide) and bend radii are sized for 3,000 u/s. Never morph the line onto a narrower ramp: riders low on the face lose their floor.
- Climbs bleed speed; boosters at the pad make standing starts viable on stages that need speed.

## Architecture notes

- **Movement is client-authoritative** for perfect feel. The server validates runs (checkpoint order, a max-speed displacement check, teleports only to earned spawns, a per-level `minRunMs` floor) and measures times itself. A modified client can still fake a run inside those limits; server-authoritative movement would close that. Painting a wall requires the server to see you inside that wall's volume.
- **Interest management:** players are bucketed into 2048-unit cells; each 3×3×3 neighbourhood is encoded once per 20 Hz tick, capped with a rotating window, and shared by everyone in the cell. Positions go over the wire as `i16` in 2-unit steps. Slow clients drop frames instead of buffering.
- **Ghost:** the server records each in-progress run at 10 Hz only while it could still beat the record; a new record's recording becomes the ghost (persisted as `data/ghost.bin`).
- **NPCs** are server-side players without a socket, advanced along the racing line each tick with per-bot skill, wobble and occasional fails; they respect the lobby and show up in snapshots, the roster, placement and the podium.
- **Chat** is relayed as-is (200 characters, 3 messages per 5 s per player, no filter); mutes are client-side.

### Load test

`cargo run --release --bin bots -- <count> ws://host/ws <seconds> levels/meridian.json` with the server started with `MAX_CONN_PER_IP=100000`. Bots ride the racing line at surf speeds. On an M3 Pro: 2,000 bots ≈ 1.1 cores, 305 MB, 22 KB/s per client, 43 MB/s total out. Bandwidth, not CPU, is the ceiling on a small droplet.

## Deploy (second Kamal service on the blog droplet)

1. DNS: `A` record `surf.akdarrah.com → 142.93.201.166`.
2. `export SURFING_ADMIN_TOKEN=$(openssl rand -hex 24)`.
3. `kamal setup` the first time, then `kamal deploy`. The image cross-compiles natively into `scratch`. Set `NPC_COUNT` in the service env if you want something other than 6 bots.
4. Embed in a post (the blog's CSP needs akdarrah/akdarrah#8):

   ```html
   <iframe src="https://surf.akdarrah.com/" title="Sky Surf" allow="pointer-lock; fullscreen"
     style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px"></iframe>
   ```

Moderation (players can also hide all player sprays or mute individuals from the menu):

```sh
A="Authorization: Bearer $SURFING_ADMIN_TOKEN"
curl -H "$A" https://surf.akdarrah.com/admin/walls                           # list walls + record (image URL, owner, IP)
curl -X POST -H "$A" https://surf.akdarrah.com/admin/walls/3/remove
curl -X POST -H "$A" "https://surf.akdarrah.com/admin/ban?ip=1.2.3.4"        # kicks, bans, clears their walls
curl -X POST -H "$A" https://surf.akdarrah.com/admin/clear-images            # resets everyone's spray
```

Leaderboards, walls, record and bans persist in the `surfing_data` volume.
