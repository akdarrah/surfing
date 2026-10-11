# Sky Surf — Meridian

Counter-Strike surf, reborn as a browser racing game. You are a **hovering sailboat** with your spray on the sail. Every two minutes everyone on the server launches together and surfs the same course, built the way classic surf maps are: short ramps, real gaps you need speed to clear, and two forks where a risky fast line and a safe one split and rejoin. The whole thing floats above a sea of cloud in a clean cream-and-blue toy look, with a **robot colossus** standing waist-deep in the clouds beside the course, head turning to follow the leader. Dotted around are **spray walls**: reach one, press `T`, and your spray stays on it for everyone until someone paints over it. The server record run is rendered as a ghost boat so there is always a second to shave.

- **Client:** TypeScript, Three.js on **WebGPU** (automatic WebGL2 fallback). Default post stack is bloom + SMAA; ambient occlusion and motion blur are a High setting. Static level geometry is merged per section, clouds/islands/birds/wind are instanced and animated in the vertex shader, DPR is capped at 1.5 with adaptive render scale, and the frame loop allocates nothing. `F3` shows frame time, draw calls, triangles, physics time and heap. Synthesized audio; full-screen play.
- **Server:** Rust (tokio + axum). One game-loop task owns all state; sockets talk to it over channels; 2,000 players on ~1 core.
- **Physics:** the movement code is a port of Source's `gamemovement.cpp`, so it feels like CS surf; collision is Quake-style brush tracing with seam handling for curved ramps.
- **Level:** `levels/build.mjs` walks the course with a turtle (`ramp`, `jump`, `land`, `bowl`, `fork`, `stage`, `wall`, `perch`), emitting mitered ramp prisms, the ideal racing line, trim strips, spray walls and both branches of every fork.

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
| `Esc` | settings |
| `F3` | performance overlay |

Mouse sensitivity uses CS units (`sensitivity × 0.022°` per count).

## A round

Exactly two minutes, repeating:

1. **Lobby (15 s)** — nobody can surf. A flythrough of the course, the previous round's podium, then 3-2-1-GO.
2. **Race (1:45)** — everyone launches from the start pad at once. Leave the pad and your clock starts. Fall off and you restart the stage (with your speed gone). First valid finisher wins the round; late joiners race for a personal time but can't place.

Joining asks for two things, a callsign (anything up to 24 characters) and a spray: eight built-ins (skull, bolt, flame, GG, cat, smiley, crossed boards, SURF) or upload your own PNG. Sprays are re-encoded in the browser to 128×128 and served content-addressed from `/img/<hash>`. Everything else (sensitivity, music, effects, quality, hide sprays, change spray, mutes) lives in the settings overlay: press `Esc` in game, or the gear button.

## Spray walls

Thirteen walls. Eight sit beside the racing line (painting one mid-race costs you speed, so it's a choice between the clock and the wall); the rest are the reason to leave it:

| | How to get there |
|---|---|
| Long Gap Ledge | take the fast line at The Split; the ledge is beside the landing |
| Spiral Wall | take the fast line at The Pipe; it's at the bottom of the loop |
| Over the Gap | over-jump the speed gap to the left ledge |
| Run-in Ledge | drift right off the last landing |
| Finish Lookout | carry your speed through the finish gate and fly off to the column |

Every wall is free-for-all: whoever reaches it and presses `T` owns it until someone paints over it. `/?wall=N` opens the game looking at wall N.

## The course: Meridian

Built the way classic CS surf maps are: short ramps, real gaps, more than one way through. Every ramp is a short dive into a climb, you loft off its end across a gap (sized so you make it at 92% of the design speed and a walking start never does) and come down on the next ramp's face. Five sections, with checkpoints between them:

1. **Start** — two warm-up ramps that build you to speed.
2. **The Split** — the first fork. Safe: another ramp and gap. Fast: a bigger loft over **The Long Gap**, with a ledge wall beside the landing. Both lines come down on one wide catcher ramp.
3. **Transfers** — ramp, gap, ramp, gap, then the course turns back on itself.
4. **The Pipe** — the second fork. Safe: ramp and gap. Fast: **The Spiral**, a full loop away from the safe track with a wall at the bottom.
5. **Speed Gaps** — the gap only the full line makes; a ledge over the gap for the brave.
6. **The Run-in** — last ramp, a ledge off the right edge, then the finish gate; carry speed through it and fly off to the **Finish Lookout** column.

The generator (`levels/build.mjs`) does the physics so the layout stays honest:

- **Speed is tracked by energy** (`v² = v₀² + 2g·drop`, minus a small loss per landing). Each ramp sizes its own climb to bring the speed back to the section's target, and deepens its dive if you are slow, so no section runs away or dies.
- **Gaps are solved, not guessed:** the landing ramp starts where the 92%-speed parabola comes down and is pitched to its arrival angle; it is made long enough for a full-speed rider, who lands further along at a flatter angle.
- **Forks** split with a 900-unit strafe each way, run parallel 1,800 apart, and both strafe back onto a 3,200-wide catcher; dry runs measure each branch so the shorter is padded, the lower climbs on its lead-in, and the fast line's launch is solved to come down 250 units into the catcher. A branch that cannot land fails the build.
- **What the physics allows** (measured with the autopilot): a rider can strafe back toward the ridge at ~800 u/s² on the 51° course profile; every concave pitch change shoves a face-rider outward by ≈0.46·v²/R, so pitch changes are eased on a 5,000-unit radius and kept small (−10° landing → +10° climb); a full loop must drop more than its ramp is deep; checkpoint gates are wider than their pads because riders arrive anywhere across a catcher.

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
