import levelJson from '../../levels/cloud-harbor.json';
import { loadLevel, playerMove, touching, trace, hullMax, add, scale, len, TICK, EYE, DUCK_EYE, type PlayerState, type LevelJSON, type V3 } from './physics.ts';
import { World, Boat } from './render.ts';
import { Net, encodeShot, encodeState, samplePose } from './net.ts';

// Shared with server/src/game.rs — keep in sync.
const WEAPONS = [
  { name: 'Popgun', cd: 150, mag: 12, reload: 1400, pellets: 1, spread: 0.01, color: 0x9b5de5, selfKb: 0 },
  { name: 'Blunderbuss', cd: 900, mag: 4, reload: 2000, pellets: 8, spread: 0.08, color: 0xf15bb5, selfKb: 0 },
  { name: 'Cannon', cd: 1200, mag: 2, reload: 2400, pellets: 1, spread: 0, color: 0x00bbf9, selfKb: 450 },
];

const $ = (id: string) => document.getElementById(id)!;
const level = loadLevel(levelJson as LevelJSON);
const world = new World($('game'));
world.buildLevel(level);
const myBoat = new Boat('#ffd166', '');
world.scene.add(myBoat.group);

const sillyName = () => {
  const a = ['Captain', 'Admiral', 'Skipper', 'Commodore', 'First Mate', 'Bosun'];
  const b = ['Soggy', 'Breezy', 'Wobbly', 'Salty', 'Fluffy', 'Gusty', 'Puffy', 'Zippy'];
  const c = ['Biscuit', 'Pickle', 'Noodle', 'Barnacle', 'Muffin', 'Teacup', 'Walrus', 'Crumpet'];
  const r = (x: string[]) => x[Math.floor(Math.random() * x.length)];
  return `${r(a)} ${r(b)} ${r(c)}`;
};
const nameInput = $('name') as HTMLInputElement;
const sensInput = $('sens') as HTMLInputElement;
nameInput.value = localStorage.getItem('name') || sillyName();
sensInput.value = localStorage.getItem('sens') || '2';

// --- game state -------------------------------------------------------------
const me: PlayerState = { pos: [...level.spawns[0].pos] as V3, vel: [0, 0, 0], onGround: false, ducked: false };
let prevPos: V3 = [...me.pos] as V3;
let yaw = level.spawns[0].yaw, pitch = 0;
let stage = 0, teleported = false, thirdPerson = false;
let owned = [true, false, false], weapon = 0, ammo = WEAPONS.map(w => w.mag), reloadUntil = 0, nextFire = 0;
let hp = 100, deadUntil = 0, myId = -1;
let runStart: number | null = null, finished = false;
let phase = 'race', phaseEndsAt = 0;
let promo: { text: string; url?: string; by: string } | null = null;
let board: { best: { name: string; ms: number }[]; wins: { name: string; wins: number }[] } = { best: [], wins: [] };
const keys = new Set<string>();
let mouseDown = false;
const boats = new Map<number, { boat: Boat; last?: V3 }>();
const feed: { text: string; until: number }[] = [];

const say = (text: string) => feed.push({ text, until: performance.now() + 6000 });
const banner = (text: string, ms = 3000) => {
  const el = $('banner');
  el.textContent = text;
  el.hidden = false;
  clearTimeout((banner as any).t);
  (banner as any).t = setTimeout(() => (el.hidden = true), ms);
};

function respawn(s: number) {
  stage = s;
  const sp = level.spawns[s];
  me.pos = [...sp.pos] as V3;
  me.vel = [0, 0, 0];
  prevPos = [...me.pos] as V3;
  yaw = sp.yaw;
  pitch = 0;
  teleported = true;
}

function newRound() {
  respawn(0);
  owned = [true, false, false];
  weapon = 0;
  ammo = WEAPONS.map(w => w.mag);
  hp = 100;
  deadUntil = 0;
  runStart = null;
  finished = false;
}

// --- networking -------------------------------------------------------------
const net = new Net({
  onJson(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.id;
        phase = m.round.phase; phaseEndsAt = m.round.endsAt;
        setPromo(m.promo); board = m.board;
        break;
      case 'join': say(`⛵ ${m.name} set sail`); break;
      case 'leave': boats.get(m.id) && world.scene.remove(boats.get(m.id)!.boat.group); boats.delete(m.id); break;
      case 'round':
        phase = m.phase; phaseEndsAt = m.endsAt;
        if (m.phase === 'race') { newRound(); banner('New round — race to the lighthouse! 🏁'); }
        else if (m.winner) banner(`🏆 ${m.winner} wins in ${fmt(m.ms)}!`, 6000);
        else banner('Time! Nobody reached the lighthouse.', 5000);
        break;
      case 'promptPromo': openPromoForm(); break;
      case 'promo': setPromo(m.promo); break;
      case 'board': board = m; break;
      case 'hit':
        hp = m.hp;
        me.vel = add(me.vel, m.kb);
        world.puff(add(me.pos, [0, 0, 40]), 20, performance.now() / 1000, 0xff4d6d, 0.4);
        break;
      case 'sunk':
        say(`💥 ${m.byName} sank ${m.name}`);
        if (m.id === myId) { hp = 0; deadUntil = performance.now() + 2000; banner(`Sunk by ${m.byName}! 🫧`, 2000); }
        break;
      case 'hitmark':
        $('crosshair').classList.add('hit');
        setTimeout(() => $('crosshair').classList.remove('hit'), 120);
        break;
      case 'pickup': owned[m.weapon] = true; weapon = m.weapon; ammo[m.weapon] = WEAPONS[m.weapon].mag; banner(`Got the ${WEAPONS[m.weapon].name}!`, 1500); break;
      case 'split': say(`Stage ${m.stage} ✓ ${fmt(m.ms)}`); break;
      case 'invalid': say(`⚠️ run not counted: ${m.reason}`); break;
    }
  },
  onFx(shooter, w, origin, dir) {
    if (shooter === myId) return;
    tracerFrom(origin, dir, WEAPONS[w]?.color ?? 0xffffff);
  },
});

function setPromo(p: typeof promo) {
  promo = p;
  world.setPromo(p);
  const el = $('promo');
  el.hidden = !p;
  if (!p) return;
  el.textContent = `🏆 ${p.by}: ${p.text} `;
  if (p.url) {
    const a = document.createElement('a');
    a.textContent = p.url;
    // Strangers write these, so never auto-link: confirm, then open with no opener/referrer.
    a.onclick = () => { if (confirm(`You're leaving Sky Surf for a link a player posted:\n\n${p.url}\n\nContinue?`)) open(p.url, '_blank', 'noopener,noreferrer'); };
    el.appendChild(a);
  }
}

function openPromoForm() {
  document.exitPointerLock();
  const f = $('promoForm') as HTMLFormElement;
  const share = $('share') as HTMLAnchorElement;
  const page = window.top === window ? location.href : document.referrer || location.href;
  share.href = `https://x.com/intent/post?text=${encodeURIComponent(`I just won a round of Sky Surf ⛵ ${page}`)}`;
  f.hidden = false;
  setTimeout(() => (f.hidden = true), 15000);
}
($('promoForm') as HTMLFormElement).onsubmit = e => {
  e.preventDefault();
  net.send({ t: 'promo', text: ($('promoText') as HTMLInputElement).value, url: ($('promoUrl') as HTMLInputElement).value });
  $('promoForm').hidden = true;
};

// --- input ------------------------------------------------------------------
const canvas = world.renderer.domElement;
$('play').onclick = () => {
  localStorage.setItem('name', nameInput.value.trim() || sillyName());
  localStorage.setItem('sens', sensInput.value);
  myBoat.setName(nameInput.value);
  if (!net.ws) net.connect(localStorage.getItem('name')!);
  canvas.requestPointerLock();
};
canvas.onclick = () => canvas.requestPointerLock();
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  $('menu').hidden = locked;
  $('hud').hidden = !locked && !net.ws;
  if (!locked) { keys.clear(); mouseDown = false; }
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  // CS: degrees = counts * sensitivity * m_yaw(0.022)
  const k = (Number(sensInput.value) || 2) * 0.022 * (Math.PI / 180);
  yaw -= e.movementX * k;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * k));
});
document.addEventListener('mousedown', e => { if (document.pointerLockElement === canvas && e.button === 0) mouseDown = true; });
document.addEventListener('mouseup', e => { if (e.button === 0) mouseDown = false; });
addEventListener('keydown', e => {
  if (document.pointerLockElement !== canvas) return;
  if (['Tab', 'Space', 'ControlLeft', 'KeyW', 'KeyS'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyF' && !deadUntil) respawn(stage);
  if (e.code === 'KeyV') thirdPerson = !thirdPerson;
  if (e.code === 'KeyR') startReload();
  const n = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (n >= 0 && owned[n]) weapon = n;
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function startReload() {
  const w = WEAPONS[weapon];
  if (ammo[weapon] === w.mag || reloadUntil) return;
  reloadUntil = performance.now() + w.reload;
  net.send({ t: 'reload' });
}

// --- shooting ---------------------------------------------------------------
const eye = (): V3 => add(me.pos, [0, 0, me.ducked ? DUCK_EYE : EYE]);
const aim = (y = yaw, p = pitch): V3 => [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];

function tracerFrom(origin: V3, dir: V3, color: number) {
  const tr = trace(level, origin, add(origin, scale(dir, 8000)), [0, 0, 0], [0, 0, 0]);
  world.tracer(add(origin, [0, 0, -8]), tr.end, color, performance.now() / 1000);
  world.puff(origin, 8, performance.now() / 1000, color, 0.3);
}

function fire(now: number) {
  const w = WEAPONS[weapon];
  if (now < nextFire || reloadUntil || deadUntil || phase !== 'race') return;
  if (ammo[weapon] <= 0) return startReload();
  nextFire = now + w.cd;
  ammo[weapon]--;
  const o = eye(), d = aim();
  for (let i = 0; i < w.pellets; i++) {
    const r = (): number => (Math.random() - 0.5) * 2 * w.spread;
    tracerFrom(o, aim(yaw + r(), pitch + r()), w.color);
  }
  if (w.selfKb) me.vel = add(me.vel, scale(d, -w.selfKb));
  net.send(encodeShot(o, d, net.renderTime(), weapon));
  if (ammo[weapon] === 0) startReload();
}

// --- simulation -------------------------------------------------------------
function tick(now: number) {
  const dead = deadUntil > 0;
  if (dead && now > deadUntil) { deadUntil = 0; hp = 100; respawn(stage); }
  const k = (c: string) => (!dead && keys.has(c) ? 1 : 0);
  prevPos = [...me.pos] as V3;
  playerMove(level, me, {
    forward: k('KeyW') - k('KeyS'),
    side: k('KeyD') - k('KeyA'),
    jump: !!k('Space'),
    duck: !!(k('ControlLeft') || k('KeyC')),
    yaw,
  });
  const maxs = hullMax(me);
  for (const t of level.triggers) {
    if (!touching(t, me.pos, maxs)) continue;
    if (t.type === 'start') { runStart = now; finished = false; }
    else if (t.type === 'teleport' && t.stage === stage) respawn(stage);
    else if (t.type === 'checkpoint' && t.stage === stage + 1) { respawn(stage + 1); }
    else if (t.type === 'end' && !finished && runStart !== null) { finished = true; say(`🏁 Finished in ${fmt(now - runStart)}!`); }
    else if (t.type === 'pickup' && !owned[t.weapon!]) { owned[t.weapon!] = true; weapon = t.weapon!; ammo[weapon] = WEAPONS[weapon].mag; }
  }
}

let acc = 0, last = performance.now(), sendAcc = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  acc += dt;
  while (acc >= TICK) {
    tick(performance.now());
    acc -= TICK;
    if (++sendAcc >= 5) {
      sendAcc = 0;
      const flags = (me.ducked ? 1 : 0) | (teleported ? 2 : 0) | (weapon << 2);
      net.send(encodeState(me.pos, yaw, pitch, flags));
      teleported = false;
    }
  }
  if (reloadUntil && now > reloadUntil) { reloadUntil = 0; ammo[weapon] = WEAPONS[weapon].mag; }
  if (mouseDown) fire(now);

  const alpha = acc / TICK;
  const pos = [0, 1, 2].map(i => prevPos[i] + (me.pos[i] - prevPos[i]) * alpha) as V3;
  const speed = Math.hypot(me.vel[0], me.vel[1]);
  const t = now / 1000;
  const cam = world.camera;
  const look = aim();
  if (thirdPerson) {
    const back = add(pos, add(scale(look, -260), [0, 0, 90]));
    cam.position.set(...back);
    myBoat.group.visible = true;
  } else {
    cam.position.set(pos[0], pos[1], pos[2] + (me.ducked ? DUCK_EYE : EYE));
    myBoat.group.visible = false;
  }
  cam.lookAt(cam.position.x + look[0], cam.position.y + look[1], cam.position.z + look[2]);
  const lateral = me.vel[0] * Math.sin(yaw) - me.vel[1] * Math.cos(yaw);
  myBoat.pose(pos, yaw, speed, me.onGround ? 0 : Math.max(-0.6, Math.min(0.6, lateral / 1500)), t, !!deadUntil);
  if (speed > 700 && Math.random() < speed / 4000) world.puff(add(pos, [0, 0, 20]), 4 + Math.random() * 4, t, 0xffffff, 0.9);

  const rt = net.renderTime();
  for (const r of net.remotes.values()) {
    if (r.id === myId) continue;
    let b = boats.get(r.id);
    if (!b) { b = { boat: new Boat(r.color, r.name) }; boats.set(r.id, b); world.scene.add(b.boat.group); }
    const p = samplePose(r, rt);
    b.boat.group.visible = !!p;
    if (!p) continue;
    const v = b.last ? Math.hypot(p.pos[0] - b.last[0], p.pos[1] - b.last[1]) / Math.max(dt, 0.001) : 0;
    b.last = p.pos;
    b.boat.pose(p.pos, p.yaw, v, 0, t, !!(p.flags & 2));
    if (v > 700 && Math.random() < v / 6000) world.puff(add(p.pos, [0, 0, 20]), 5, t, 0xffffff, 0.8);
  }
  for (const [id, b] of boats) if (!net.remotes.has(id)) { world.scene.remove(b.boat.group); boats.delete(id); }

  world.showPickups(owned, t);
  world.tickFx(t);
  world.render();
  hud(now, speed);
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${((ms / 1000) % 60).toFixed(2).padStart(5, '0')}`;

function hud(now: number, speed: number) {
  $('speed').textContent = String(Math.round(speed));
  $('timer').textContent = runStart === null ? '' : finished ? '🏁' : fmt(Math.max(0, performance.now() - runStart));
  $('stage').textContent = `Stage ${stage + 1} / ${level.spawns.length}`;
  $('hp').textContent = deadUntil ? '🫧 sunk' : `❤️ ${hp}`;
  const w = WEAPONS[weapon];
  $('ammo').innerHTML = `${w.name} ${reloadUntil ? 'reloading…' : `${ammo[weapon]}/${w.mag}`}<br><small>${WEAPONS.map((x, i) => (owned[i] ? `${i + 1}:${x.name}` : `${i + 1}:🔒`)).join(' ')}</small>`;
  const left = Math.max(0, phaseEndsAt - net.serverNow());
  $('round').textContent = net.connected ? `${phase === 'race' ? 'Round' : 'Next round'} ${fmt(left).slice(0, -3)} · ${net.remotes.size} online` : 'offline (solo)';
  while (feed.length && feed[0].until < now) feed.shift();
  $('feed').innerHTML = feed.map(f => esc(f.text)).join('<br>');
  const show = keys.has('Tab');
  $('board').hidden = !show;
  if (show) {
    $('board').innerHTML = `<b>Best runs</b><table>${board.best.map((b, i) => `<tr><td>${i + 1}.</td><td>${esc(b.name)}</td><td>${fmt(b.ms)}</td></tr>`).join('')}</table>`
      + `<b>Most wins</b><table>${board.wins.map((b, i) => `<tr><td>${i + 1}.</td><td>${esc(b.name)}</td><td>${b.wins}</td></tr>`).join('')}</table>`;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

if (import.meta.env.DEV) (window as any).game = { me, look: (y: number, p: number) => { yaw = y; pitch = p; }, cam: () => (thirdPerson = !thirdPerson) };
requestAnimationFrame(frame);
