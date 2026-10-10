import levelJson from '../../levels/cloud-harbor.json';
import { loadLevel, playerMove, touching, trace, hullMax, add, scale, TICK, EYE, DUCK_EYE, type PlayerState, type LevelJSON, type V3 } from './physics.ts';
import { World, Boat, imageTexture, textureFromCanvas } from './render.ts';
import { Net, encodeImage, encodeShot, encodeState, samplePose } from './net.ts';

// Shared with server/src/game.rs — keep in sync.
const WEAPONS = [
  { name: 'Flintlock', cd: 150, mag: 12, reload: 1400, pellets: 1, spread: 0.01, color: 0xffb000, selfKb: 0 },
  { name: 'Blunderbuss', cd: 900, mag: 4, reload: 2000, pellets: 8, spread: 0.08, color: 0xff5a1f, selfKb: 0 },
  { name: 'Hand Cannon', cd: 1200, mag: 2, reload: 2400, pellets: 1, spread: 0, color: 0xff2a2a, selfKb: 450 },
];

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const level = loadLevel(levelJson as LevelJSON);
const world = new World($('game'));
world.buildLevel(level);
const myBoat = new Boat('#ffb000', '');
world.scene.add(myBoat.group);

const gamertag = () => {
  const a = ['Grim', 'Rusty', 'Dead', 'Iron', 'Black', 'Salty', 'Savage', 'Rogue', 'Toxic', 'Cursed'];
  const b = ['Kraken', 'Marauder', 'Reaper', 'Gunner', 'Corsair', 'Viper', 'Jackal', 'Hook', 'Wraith', 'Buccaneer'];
  const r = (x: string[]) => x[Math.floor(Math.random() * x.length)];
  return `${r(a)}${r(b)}`;
};

// --- profile (kept in localStorage so you set it once) ----------------------
const prof = {
  name: localStorage.getItem('name') || gamertag(),
  sponsor: localStorage.getItem('sponsor') || '',
  flag: localStorage.getItem('flag') || '', // data: URL of the processed image
  spray: localStorage.getItem('spray') || '',
  hide: localStorage.getItem('hideImages') === '1',
};
input('name').value = prof.name;
input('sponsor').value = prof.sponsor;
input('sens').value = localStorage.getItem('sens') || '2';
input('hideImages').checked = prof.hide;
const preview = () => {
  ($('flagPreview') as HTMLImageElement).src = prof.flag || '';
  ($('sprayPreview') as HTMLImageElement).src = prof.spray || '';
};
preview();

// Resize/crop on a canvas: keeps uploads tiny and strips anything that isn't pixels (EXIF, GPS, payloads).
async function processImage(file: File, w: number, h: number, type: 'image/jpeg' | 'image/png') {
  const bmp = await createImageBitmap(file);
  for (const s of [1, 0.75, 0.5]) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    const k = Math.max(c.width / bmp.width, c.height / bmp.height);
    c.getContext('2d')!.drawImage(bmp, (c.width - bmp.width * k) / 2, (c.height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    const url = c.toDataURL(type, 0.82);
    if (url.length * 0.75 < 46 * 1024) return url;
  }
  throw new Error('image too detailed');
}
const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0));

for (const [id, key, w, h, type] of [['flagFile', 'flag', 128, 80, 'image/jpeg'], ['sprayFile', 'spray', 128, 128, 'image/png']] as const) {
  input(id).onchange = async () => {
    const f = input(id).files?.[0];
    if (!f) return;
    try {
      prof[key] = await processImage(f, w, h, type);
      localStorage.setItem(key, prof[key]);
      preview();
    } catch {
      banner('THAT IMAGE DIDN\'T WORK, TRY ANOTHER', 2500);
    }
  };
}

// --- game state -------------------------------------------------------------
const me: PlayerState = { pos: [...level.spawns[0].pos] as V3, vel: [0, 0, 0], onGround: false, ducked: false };
let prevPos: V3 = [...me.pos] as V3;
let yaw = level.spawns[0].yaw, pitch = 0;
let stage = 0, teleported = false, thirdPerson = false;
let owned = [true, false, false], weapon = 0, ammo = WEAPONS.map(w => w.mag), reloadUntil = 0, nextFire = 0;
let hp = 100, deadUntil = 0, myId = -1;
let runStart: number | null = null, finished = false;
let phase = 'race', phaseEndsAt = 0;
let goldPending = false, myTagId = 0;
let intro: { tag: Tag; until: number } | null = null;
let board: { best: { name: string; ms: number }[]; wins: { name: string; wins: number }[] } = { best: [], wins: [] };
const keys = new Set<string>();
let mouseDown = false;
const boats = new Map<number, { boat: Boat; last?: V3 }>();
const feed: { text: string; until: number }[] = [];

type Profile = { name: string; sponsor: string; color: string; flag?: string | null; spray?: string | null };
type Tag = { id: number; hash: string; pos: V3; normal: V3; name: string; sponsor: string; at: number };
const profiles = new Map<number, Profile>();
const roster = new Map<number, [number, number, number, boolean]>();
const sprays = new Map<number, { pos: V3; normal: V3; hash: string }>();
const tags = new Map<number, Tag>();
const muted = new Set<number>();
let uploaded = { flag: '', spray: '' };

const say = (text: string) => feed.push({ text, until: performance.now() + 6000 });
function banner(text: string, ms = 3000) {
  const el = $('banner');
  el.textContent = text;
  el.hidden = false;
  clearTimeout((banner as any).t);
  (banner as any).t = setTimeout(() => (el.hidden = true), ms);
}

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
  goldPending = false;
}

// --- images: flags, sprays, permanent tags ----------------------------------
const showImages = (id: number) => !prof.hide && !muted.has(id);

function applyFlag(id: number) {
  const b = boats.get(id), p = profiles.get(id);
  if (!b) return;
  if (p?.flag && showImages(id)) imageTexture(p.flag).then(t => boats.get(id)?.boat.setFlag(t), () => {});
  else b.boat.setFlag(null);
}

function applySpray(id: number) {
  const s = sprays.get(id);
  if (!s || !showImages(id)) return world.removeDecal(`s${id}`);
  imageTexture(s.hash).then(t => sprays.get(id) === s && world.setDecal(`s${id}`, t, s.pos, s.normal, 72), () => {});
}

function applyTag(tag: Tag) {
  if (prof.hide) return world.removeDecal(`t${tag.id}`);
  const date = new Date(tag.at * 1000).toLocaleDateString();
  imageTexture(tag.hash).then(t => tags.has(tag.id) && world.setDecal(`t${tag.id}`, t, tag.pos, tag.normal, 128, [tag.name, ...(tag.sponsor ? [tag.sponsor] : []), date]), () => {});
}

function refreshImages() {
  for (const id of boats.keys()) applyFlag(id);
  for (const id of sprays.keys()) applySpray(id);
  for (const t of tags.values()) applyTag(t);
  ownFlag();
}

function ownFlag() {
  if (!prof.flag) return myBoat.setFlag(null);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.drawImage(img, 0, 0);
    myBoat.setFlag(textureFromCanvas(c));
  };
  img.src = prof.flag;
}

function uploadImages() {
  if (prof.flag && uploaded.flag !== prof.flag) net.send(encodeImage(3, dataUrlBytes(prof.flag)));
  if (prof.spray && uploaded.spray !== prof.spray) net.send(encodeImage(4, dataUrlBytes(prof.spray)));
  uploaded = { flag: prof.flag, spray: prof.spray };
}

// --- networking -------------------------------------------------------------
const net = new Net({
  onJson(m) {
    switch (m.t) {
      case 'welcome': {
        myId = m.id;
        phase = m.round.phase; phaseEndsAt = m.round.endsAt;
        setPromo(m.promo); board = m.board;
        profiles.clear(); sprays.clear(); tags.clear();
        for (const k of world.decalKeys()) world.removeDecal(k);
        for (const p of m.players) profiles.set(p.id, p);
        for (const s of m.sprays) { sprays.set(s.id, s); applySpray(s.id); }
        for (const t of m.tags) { tags.set(t.id, t); applyTag(t); }
        uploaded = { flag: '', spray: '' };
        uploadImages();
        const want = Number(new URLSearchParams(location.search).get('tag'));
        if (want && tags.has(want) && !intro) {
          const tag = tags.get(want)!;
          intro = { tag, until: performance.now() + 6000 };
          banner(`TAGGED BY ${tag.name.toUpperCase()}${tag.sponsor ? ` [${tag.sponsor}]` : ''}`, 6000);
        }
        break;
      }
      case 'join': profiles.set(m.id, m); if (m.id !== myId) say(`${m.name} joined`); break;
      case 'profile': profiles.set(m.id, m); applyFlag(m.id); break;
      case 'leave':
        boats.get(m.id) && world.scene.remove(boats.get(m.id)!.boat.group);
        boats.delete(m.id); profiles.delete(m.id); roster.delete(m.id); sprays.delete(m.id);
        world.removeDecal(`s${m.id}`);
        break;
      case 'round':
        phase = m.phase; phaseEndsAt = m.endsAt;
        if (m.phase === 'race') { newRound(); banner('ROUND START — FIRST TO THE TOWER TAKES IT'); }
        else if (m.winner) banner(`${m.winner.toUpperCase()} TAKES THE ROUND  ${fmt(m.ms)}`, 6000);
        else banner('ROUND DRAW', 5000);
        break;
      case 'promptPromo':
        goldPending = true;
        banner('YOU WON. AIM AT A WALL AND PRESS T — YOUR SPRAY STAYS ON THE MAP', 12000);
        setTimeout(() => { if (goldPending) openPromoForm(); }, 12000);
        break;
      case 'tag':
        for (const id of m.removed) { tags.delete(id); world.removeDecal(`t${id}`); }
        tags.set(m.tag.id, m.tag);
        applyTag(m.tag);
        if (m.by === myId) {
          goldPending = false;
          myTagId = m.tag.id;
          banner('TAGGED. IT STAYS UNTIL SOMEONE PAINTS OVER IT', 3000);
          setTimeout(openPromoForm, 1200);
        } else say(`${m.tag.name} tagged the map`);
        break;
      case 'untag': for (const id of m.ids) { tags.delete(id); world.removeDecal(`t${id}`); } break;
      case 'spray':
        sprays.set(m.id, { pos: m.pos, normal: m.normal, hash: m.hash });
        applySpray(m.id);
        world.puff(m.pos, 14, performance.now() / 1000, 0x555555, 0.5);
        break;
      case 'clearImages':
        for (const p of profiles.values()) { p.flag = null; p.spray = null; }
        for (const id of sprays.keys()) world.removeDecal(`s${id}`);
        sprays.clear();
        refreshImages();
        break;
      case 'roster': roster.clear(); for (const [id, st, k, d, fin] of m.p) roster.set(id, [st, k, d, fin]); break;
      case 'promo': setPromo(m.promo); break;
      case 'board': board = m; break;
      case 'hit':
        hp = m.hp;
        me.vel = add(me.vel, m.kb);
        if (hp <= 0 && !deadUntil) deadUntil = performance.now() + 2000; // in case the 'sunk' frame got dropped
        world.puff(add(me.pos, [0, 0, 40]), 20, performance.now() / 1000, 0xb3001b, 0.4);
        break;
      case 'sunk':
        say(`${m.byName}  [${WEAPONS[m.w]?.name ?? '☠'}]  ${m.name}`);
        if (m.id === myId) { hp = 0; deadUntil = performance.now() + 2000; banner(`SUNK BY ${m.byName.toUpperCase()}`, 2000); }
        break;
      case 'hitmark':
        $('crosshair').classList.add('hit');
        setTimeout(() => $('crosshair').classList.remove('hit'), 120);
        break;
      case 'pickup': owned[m.weapon] = true; weapon = m.weapon; ammo[m.weapon] = WEAPONS[m.weapon].mag; banner(`PICKED UP ${WEAPONS[m.weapon].name.toUpperCase()}`, 1500); break;
      case 'split': say(`STAGE ${m.stage} ✓ ${fmt(m.ms)}`); break;
      case 'invalid': say(`RUN NOT COUNTED: ${m.reason}`); break;
      case 'notice': banner(m.text.toUpperCase(), 3000); if (!$('promoForm').hidden) openPromoForm(); break;
    }
  },
  onFx(shooter, w, origin, dir) {
    if (shooter === myId) return;
    tracerFrom(origin, dir, WEAPONS[w]?.color ?? 0xffffff);
  },
});

function setPromo(p: { text: string; url?: string; by: string } | null) {
  world.setPromo(p);
  const el = $('promo');
  el.hidden = !p;
  if (!p) return;
  el.textContent = `${p.by}: ${p.text} `;
  if (p.url) {
    const a = document.createElement('a');
    a.textContent = p.url;
    // Strangers write these, so never auto-link: confirm, then open with no opener/referrer.
    a.onclick = () => { if (confirm(`You're leaving Sky Surf for a link a player posted:\n\n${p.url}\n\nContinue?`)) open(p.url, '_blank', 'noopener,noreferrer'); };
    el.appendChild(a);
  }
}

function openPromoForm() {
  goldPending = false;
  document.exitPointerLock();
  const f = $('promoForm') as HTMLFormElement;
  const link = myTagId ? `${location.origin}/?tag=${myTagId}` : location.origin;
  const text = myTagId ? `I just tagged the map in Sky Surf. Come paint over me 🏴‍☠️ ${link}` : `I just took a round in Sky Surf 🏴‍☠️ ${link}`;
  ($('share') as HTMLAnchorElement).href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  f.hidden = false;
  clearTimeout((openPromoForm as any).t);
  (openPromoForm as any).t = setTimeout(() => (f.hidden = true), 25000);
}
($('promoForm') as HTMLFormElement).onsubmit = e => {
  e.preventDefault();
  net.send({ t: 'promo', text: input('promoText').value, url: input('promoUrl').value });
  $('promoForm').hidden = true;
};

// --- input ------------------------------------------------------------------
const canvas = world.renderer.domElement;
$('play').onclick = () => {
  prof.name = input('name').value.trim() || gamertag();
  prof.sponsor = input('sponsor').value.trim();
  prof.hide = input('hideImages').checked;
  localStorage.setItem('name', prof.name);
  localStorage.setItem('sponsor', prof.sponsor);
  localStorage.setItem('sens', input('sens').value);
  localStorage.setItem('hideImages', prof.hide ? '1' : '');
  myBoat.setName(prof.name, prof.sponsor);
  refreshImages();
  if (!net.ws) net.connect(() => ({ name: prof.name, sponsor: prof.sponsor }));
  else uploadImages();
  intro = null;
  canvas.requestPointerLock();
};
canvas.onclick = () => canvas.requestPointerLock();
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  $('menu').hidden = locked;
  $('hud').hidden = !locked && !net.ws;
  if (!locked) { keys.clear(); mouseDown = false; renderPlayers(); }
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  // CS: degrees = counts * sensitivity * m_yaw(0.022)
  const k = (Number(input('sens').value) || 2) * 0.022 * (Math.PI / 180);
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
  if (e.code === 'KeyT') spray();
  const n = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (n >= 0 && owned[n]) weapon = n;
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// Mute list lives on the pause menu, where you have a mouse cursor.
function renderPlayers() {
  const rows = [...profiles].filter(([id]) => id !== myId);
  $('players').innerHTML = rows.length
    ? `<h3>PLAYERS</h3>` + rows.map(([id, p]) => `<div><span>${esc(p.name)}${p.sponsor ? ` <i>[${esc(p.sponsor)}]</i>` : ''}</span><button type="button" data-mute="${id}">${muted.has(id) ? 'UNMUTE' : 'MUTE'}</button></div>`).join('')
    : '';
}
$('players').onclick = e => {
  const id = Number((e.target as HTMLElement).dataset.mute);
  if (!Number.isFinite(id) || (e.target as HTMLElement).dataset.mute === undefined) return;
  muted.has(id) ? muted.delete(id) : muted.add(id);
  applyFlag(id); applySpray(id);
  renderPlayers();
};

function startReload() {
  const w = WEAPONS[weapon];
  if (ammo[weapon] === w.mag || reloadUntil) return;
  reloadUntil = performance.now() + w.reload;
  net.send({ t: 'reload' });
}

// --- shooting + spraying ----------------------------------------------------
const eye = (): V3 => add(me.pos, [0, 0, me.ducked ? DUCK_EYE : EYE]);
const aim = (y = yaw, p = pitch): V3 => [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];

function spray() {
  const o = eye();
  const tr = trace(level, o, add(o, scale(aim(), 300)), [0, 0, 0], [0, 0, 0]);
  if (tr.fraction === 1 || !tr.normal) return banner('GET CLOSER TO A WALL', 1000);
  if (!prof.spray && !(goldPending && prof.flag)) return banner('SET A SPRAY IMAGE IN THE MENU (ESC)', 2000);
  net.send({ t: goldPending ? 'tag' : 'spray', pos: tr.end, normal: tr.normal });
}

function tracerFrom(origin: V3, dir: V3, color: number) {
  const tr = trace(level, origin, add(origin, scale(dir, 8000)), [0, 0, 0], [0, 0, 0]);
  world.tracer(add(origin, [0, 0, -8]), tr.end, color, performance.now() / 1000);
  world.puff(origin, 8, performance.now() / 1000, 0x3a3a3a, 0.3);
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
    else if (t.type === 'checkpoint' && t.stage === stage + 1) {
      // Let the server see us inside the checkpoint before we teleport away from it.
      net.send(encodeState(me.pos, yaw, pitch, (me.ducked ? 1 : 0) | (weapon << 2)));
      respawn(stage + 1);
    }
    else if (t.type === 'end' && !finished && runStart !== null) { finished = true; say(`FINISHED ${fmt(now - runStart)}`); }
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
  if (intro && now < intro.until) {
    // Arrived via a shared ?tag= link: show them the tag first.
    const { pos: tp, normal: n } = intro.tag;
    cam.position.set(tp[0] + n[0] * 280, tp[1] + n[1] * 280, tp[2] + n[2] * 280 + 40);
    cam.lookAt(...tp);
    myBoat.group.visible = false;
  } else {
    if (thirdPerson) {
      cam.position.set(...add(pos, add(scale(look, -260), [0, 0, 90])));
      myBoat.group.visible = true;
    } else {
      cam.position.set(pos[0], pos[1], pos[2] + (me.ducked ? DUCK_EYE : EYE));
      myBoat.group.visible = false;
    }
    cam.lookAt(cam.position.x + look[0], cam.position.y + look[1], cam.position.z + look[2]);
  }
  const lateral = me.vel[0] * Math.sin(yaw) - me.vel[1] * Math.cos(yaw);
  myBoat.pose(pos, yaw, speed, me.onGround ? 0 : Math.max(-0.6, Math.min(0.6, lateral / 1500)), t, !!deadUntil);
  if (speed > 700 && Math.random() < speed / 4000) world.puff(add(pos, [0, 0, 20]), 4 + Math.random() * 4, t, 0x7a7a7a, 0.9);

  const rt = net.renderTime();
  for (const r of net.remotes.values()) {
    if (r.id === myId) continue;
    let b = boats.get(r.id);
    if (!b) {
      const p = profiles.get(r.id);
      b = { boat: new Boat(p?.color ?? '#888', p?.name ?? '?', p?.sponsor ?? '') };
      boats.set(r.id, b);
      world.scene.add(b.boat.group);
      applyFlag(r.id);
    }
    const p = samplePose(r, rt);
    b.boat.group.visible = !!p;
    if (!p) continue;
    const v = b.last ? Math.hypot(p.pos[0] - b.last[0], p.pos[1] - b.last[1]) / Math.max(dt, 0.001) : 0;
    b.last = p.pos;
    b.boat.pose(p.pos, p.yaw, v, 0, t, !!(p.flags & 2));
    if (v > 700 && Math.random() < v / 6000) world.puff(add(p.pos, [0, 0, 20]), 5, t, 0x7a7a7a, 0.8);
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
  $('timer').textContent = runStart === null ? '' : finished ? 'FINISHED' : fmt(Math.max(0, performance.now() - runStart));
  $('stage').textContent = `STAGE ${stage + 1}/${level.spawns.length}`;
  $('hp').textContent = deadUntil ? 'SUNK' : `+ ${hp}`;
  const w = WEAPONS[weapon];
  $('ammo').innerHTML = `<small>${w.name.toUpperCase()}</small> ${reloadUntil ? '--' : `${ammo[weapon]} | ${w.mag}`}<br><small>${WEAPONS.map((x, i) => (owned[i] ? `${i + 1} ${x.name}` : `${i + 1} ——`)).join('  ')}</small>`;
  const left = Math.max(0, phaseEndsAt - net.serverNow());
  $('round').textContent = net.connected ? `${phase === 'race' ? 'ROUND' : 'NEXT'} ${fmt(left).slice(0, -3)}  ·  ${profiles.size} ONLINE` : 'OFFLINE';
  while (feed.length && feed[0].until < now) feed.shift();
  $('feed').innerHTML = feed.map(f => `<div>${esc(f.text)}</div>`).join('');
  const show = keys.has('Tab');
  $('board').hidden = !show;
  if (show) scoreboard();
}

function scoreboard() {
  const rows = [...profiles].map(([id, p]) => ({ id, p, r: roster.get(id) ?? ([0, 0, 0, false] as const) }))
    .sort((a, b) => b.r[0] - a.r[0] || b.r[1] - a.r[1]);
  const flag = (id: number, p: Profile) => (p.flag && showImages(id) ? `<img src="/img/${esc(p.flag)}">` : '<span class="skull">☠</span>');
  $('board').innerHTML = `<div class="title">SKY SURF <span>${esc(level.name.toUpperCase())} · ${profiles.size} PLAYERS</span></div>`
    + `<table class="players"><tr><th></th><th>NAME</th><th>SPONSOR</th><th>STAGE</th><th>K</th><th>D</th></tr>`
    + rows.map(({ id, p, r }) => `<tr${id === myId ? ' class="me"' : ''}><td>${flag(id, p)}</td><td>${esc(p.name)}</td><td class="sponsor">${esc(p.sponsor || '')}</td><td>${r[3] ? '✓' : r[0] + 1}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')
    + `</table><div class="cols"><div><b>BEST RUNS</b><table>${board.best.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.name)}</td><td>${fmt(b.ms)}</td></tr>`).join('')}</table></div>`
    + `<div><b>MOST WINS</b><table>${board.wins.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.name)}</td><td>${b.wins}</td></tr>`).join('')}</table></div></div>`;
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

ownFlag();
myBoat.setName(prof.name, prof.sponsor);
if (import.meta.env.DEV) (window as any).game = { me, look: (y: number, p: number) => { yaw = y; pitch = p; }, cam: () => (thirdPerson = !thirdPerson), spray, net, tab: (on: boolean) => (on ? keys.add('Tab') : keys.delete('Tab')) };
requestAnimationFrame(frame);
