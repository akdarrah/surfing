import levelJson from '../../levels/meridian.json';
import { loadLevel, playerMove, touching, applyBoost, hullMax, trace, add, scale, TICK, EYE, DUCK_EYE, type PlayerState, type LevelJSON, type V3 } from './physics.ts';
import { World, Glider, imageTexture, textureFromCanvas, fmtMs, type WallInfo } from './render.ts';
import { Net, encodeImage, encodeState, samplePose, type GhostFrame } from './net.ts';
import { Audio } from './audio.ts';
import { autopilot } from './autopilot.ts';
import { SPRAYS, sprayDataUrl } from './sprays.ts';

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const json = levelJson as unknown as LevelJSON & { props: any[]; walls: any[]; line: any[] };
const level = loadLevel(json);
const HULL: V3 = [16, 16, 72];
const LOBBY_MS = 15000;

// --- profile (localStorage) -------------------------------------------------
const callsign = () => {
  const a = ['NOVA', 'VECTOR', 'GHOST', 'DELTA', 'ZERO', 'KILO', 'ORBIT', 'RAZOR', 'FLUX', 'NEON'];
  const r = (x: string[]) => x[Math.floor(Math.random() * x.length)];
  return `${r(a)}${Math.floor(Math.random() * 90 + 10)}`;
};
const prof = {
  name: localStorage.getItem('name') || callsign(),
  spray: localStorage.getItem('spray') || sprayDataUrl(SPRAYS[Math.floor(Math.random() * SPRAYS.length)].key),
  sprayKey: localStorage.getItem('sprayKey') || '',
  hide: localStorage.getItem('hideImages') === '1',
  high: localStorage.getItem('quality') !== 'low',
};
input('name').value = prof.name;
input('sens').value = localStorage.getItem('sens') || '2';
input('hideImages').checked = prof.hide;
input('quality').checked = prof.high;
const audio = new Audio();
input('volMusic').value = String(audio.volumes.music);
input('volSfx').value = String(audio.volumes.sfx);
input('volMusic').oninput = () => { audio.volumes.music = Number(input('volMusic').value); audio.setVolumes(); };
input('volSfx').oninput = () => { audio.volumes.sfx = Number(input('volSfx').value); audio.setVolumes(); };
input('quality').onchange = () => { localStorage.setItem('quality', input('quality').checked ? 'high' : 'low'); location.reload(); };

// Spray picker: the built-ins, plus a custom upload.
const picker = $('sprayPicker');
for (const s of SPRAYS) {
  const img = new Image();
  img.src = sprayDataUrl(s.key);
  img.title = s.name;
  img.onclick = () => { prof.spray = img.src; prof.sprayKey = s.key; saveSpray(); };
  picker.appendChild(img);
}
function saveSpray(upload = true) {
  localStorage.setItem('spray', prof.spray);
  localStorage.setItem('sprayKey', prof.sprayKey);
  ($('sprayPreview') as HTMLImageElement).src = prof.spray;
  for (const img of picker.querySelectorAll('img')) img.classList.toggle('on', img.src === prof.spray);
  if (upload) { uploaded = ''; uploadSpray(); ownFlag(); }
}
saveSpray(false); // `net` and the glider don't exist yet at module load
async function processImage(file: File) {
  const bmp = await createImageBitmap(file);
  for (const s of [1, 0.75, 0.5]) {
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(128 * s);
    const k = Math.min(c.width / bmp.width, c.height / bmp.height);
    c.getContext('2d')!.drawImage(bmp, (c.width - bmp.width * k) / 2, (c.height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    const url = c.toDataURL('image/png');
    if (url.length * 0.75 < 46 * 1024) return url;
  }
  throw new Error('too detailed');
}
input('sprayFile').onchange = async () => {
  const f = input('sprayFile').files?.[0];
  if (!f) return;
  try { prof.spray = await processImage(f); prof.sprayKey = 'custom'; saveSpray(); }
  catch { banner('THAT IMAGE DIDN\'T WORK, TRY ANOTHER', 2500); }
};
const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0));

// --- world ------------------------------------------------------------------
const world = new World($('game'), prof.high);
const me: PlayerState = { pos: [...level.spawns[0].pos] as V3, vel: [0, 0, 0], onGround: false, ducked: false };
let prevPos: V3 = [...me.pos] as V3;
let yaw = level.spawns[0].yaw, pitch = 0;
let stage = 0, teleported = false, thirdPerson = false;
let runStart: number | null = null, finished = false, finishMs = 0;
let myId = -1;
let phase: 'solo' | 'lobby' | 'race' = 'solo';
let phaseEndsAt = 0, goAt = 0, lastCount = -1;
let board: { best: { name: string; ms: number }[]; wins: { name: string; wins: number }[] } = { best: [], wins: [] };
let record: { name: string; ms: number; spray?: string | null } | null = null;
let ghostFrames: GhostFrame[] = [];
let ghostOn = true;
let introWall = Number(new URLSearchParams(location.search).get('wall')) || 0;
let introUntil = 0;
let fly = { on: false };
const keys = new Set<string>();
type Profile = { id: number; name: string; color: string; spray?: string | null; bot?: boolean };
const profiles = new Map<number, Profile>();
const roster = new Map<number, [number, number, number, boolean, boolean]>(); // stage, finishedMs, place, late, bot
const gliders = new Map<number, Glider>();
const walls = new Map<number, WallInfo>();
const sprays = new Map<number, { pos: V3; normal: V3; hash: string }>();
const muted = new Set<number>();
const feed: { text: string; until: number }[] = [];
let uploaded = '';
let lastContact = 0, wasAirborne = true, shakeT = 0;
let auto: ReturnType<typeof autopilot> | null = null;
let chatting = false;

const myGlider = new Glider('#ffb000', prof.name);
const ghost = new Glider(0xffffff, '', '', true);
myGlider.addTo(world.scene);
ghost.addTo(world.scene);
ghost.visible = false;

const say = (text: string) => { feed.push({ text, until: performance.now() + 6500 }); if (feed.length > 6) feed.shift(); };
function banner(text: string, ms = 3000) {
  const el = $('banner');
  el.textContent = text;
  el.hidden = false;
  clearTimeout((banner as any).t);
  (banner as any).t = setTimeout(() => (el.hidden = true), ms);
}
// CS-style chat log: last 7 lines, bottom-left, fading out.
const chatLines: { el: HTMLElement; at: number }[] = [];
function chatLog(html: string, sys = false) {
  const el = document.createElement('div');
  el.innerHTML = html;
  if (sys) el.className = 'sys';
  $('chatLog').appendChild(el);
  chatLines.push({ el, at: performance.now() });
  while (chatLines.length > 7) chatLines.shift()!.el.remove();
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
  myGlider.resetTrail();
  if (auto) auto = autopilot(json.line, stage);
}

function newRound() {
  respawn(0);
  runStart = null;
  finished = false;
}

// --- images: sprays on gliders, walls and the level --------------------------
const showImages = (id: number) => !prof.hide && !muted.has(id);
function defaultSprayFor(id: number) { return sprayDataUrl(SPRAYS[id % SPRAYS.length].key); }
function applyFlag(id: number) {
  const g = gliders.get(id), p = profiles.get(id);
  if (!g) return;
  if (p?.spray && showImages(id)) imageTexture(p.spray).then(({ tex }) => gliders.get(id)?.setFlag(tex), () => {});
  else if (p?.bot) dataUrlTexture(defaultSprayFor(id)).then(t => gliders.get(id)?.setFlag(t));
  else g.setFlag(null);
}
function dataUrlTexture(url: string) {
  return new Promise<ReturnType<typeof textureFromCanvas>>(res => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d')!.drawImage(img, 0, 0); res(textureFromCanvas(c)); };
    img.src = url;
  });
}
function ownFlag() { dataUrlTexture(prof.spray).then(t => myGlider.setFlag(t)); }
function uploadSpray() {
  if (prof.spray && uploaded !== prof.spray && net.connected) { net.send(encodeImage(dataUrlBytes(prof.spray))); uploaded = prof.spray; }
}
function paintWall(id: number) {
  const w = walls.get(id) ?? null;
  if (w && !prof.hide) imageTexture(w.hash).then(({ bmp }) => world.setWall(id, w, bmp), () => world.setWall(id, null));
  else world.setWall(id, null);
}
function applySpray(id: number) {
  const s = sprays.get(id);
  if (!s || !showImages(id)) return world.removeDecal(`s${id}`);
  imageTexture(s.hash).then(({ tex }) => sprays.get(id) === s && world.setDecal(`s${id}`, tex, s.pos, s.normal, 96), () => {});
}
function refreshImages() {
  for (const id of gliders.keys()) applyFlag(id);
  for (const w of json.walls) paintWall(w.id);
  for (const id of sprays.keys()) applySpray(id);
  ownFlag();
}

// --- networking -------------------------------------------------------------
const net = new Net({
  onJson(m) {
    switch (m.t) {
      case 'welcome': {
        myId = m.id;
        board = m.board; record = m.record;
        profiles.clear(); walls.clear(); sprays.clear();
        for (const p of m.players) profiles.set(p.id, p);
        for (const w of m.walls) walls.set(w.id, w);
        for (const s of m.sprays) sprays.set(s.id, s);
        setPhase(m.round.phase, m.round.endsAt, m.round.go, m.round.now, m.round.results, true);
        refreshImages();
        uploaded = ''; uploadSpray();
        if (introWall && world.wallInfo(introWall)) { introUntil = performance.now() + 7000; const w = walls.get(introWall); banner(w ? `${w.name.toUpperCase()}'S SPRAY · ${world.wallInfo(introWall)!.name.toUpperCase()}` : world.wallInfo(introWall)!.name.toUpperCase(), 7000); }
        break;
      }
      case 'join': profiles.set(m.id, m); if (m.id !== myId) chatLog(`${esc(m.name)} joined`, true); break;
      case 'profile': profiles.set(m.id, m); applyFlag(m.id); break;
      case 'leave': { const g = gliders.get(m.id); if (g) g.removeFrom(world.scene); gliders.delete(m.id); profiles.delete(m.id); roster.delete(m.id); sprays.delete(m.id); world.removeDecal(`s${m.id}`); break; }
      case 'round': setPhase(m.phase, m.endsAt, m.go, m.now, m.results); break;
      case 'placed': chatLog(`${esc(m.name)} finished ${ordinal(m.place)} · ${fmtMs(m.ms)}`, true); break;
      case 'finish':
        finished = true; finishMs = m.ms;
        if (m.record) banner(`SERVER RECORD  ${fmtMs(m.ms)}`, 5000);
        else if (m.place) banner(`${ordinal(m.place).toUpperCase()}  ${fmtMs(m.ms)}`, 4000);
        else banner(`FINISHED  ${fmtMs(m.ms)}${m.late ? '  (PRACTICE)' : ''}`, 3000);
        audio.finish();
        break;
      case 'record': record = m.record; if (record && myId !== -1) chatLog(`new record: ${esc(record.name)} ${fmtMs(record.ms)}`, true); break;
      case 'wall': walls.set(m.wall.id, m.wall); paintWall(m.wall.id); chatLog(`${esc(m.name)} sprayed ${esc(m.wallName)}`, true); if (m.by !== myId) audio.claim(); else { audio.claim(); banner(`${String(m.wallName).toUpperCase()} IS YOURS`, 2500); } break;
      case 'unwall': for (const id of m.ids) { walls.delete(id); paintWall(id); } break;
      case 'spray': sprays.set(m.id, { pos: m.pos, normal: m.normal, hash: m.hash }); applySpray(m.id); world.puff(m.pos, 14, 0x555555, 0.5); if (m.id === myId) audio.whoosh(); break;
      case 'chat': if (!muted.has(m.id)) { chatLog(`<b style="color:${esc(m.color)}">${esc(m.name)}</b>: ${esc(m.text)}`); } break;
      case 'clearImages': for (const p of profiles.values()) p.spray = null; sprays.clear(); refreshImages(); break;
      case 'roster': roster.clear(); for (const [id, st, ms, pl, late, bot] of m.p) roster.set(id, [st, ms, pl, late, bot]); break;
      case 'board': board = m; break;
      case 'split': say(`STAGE ${m.stage} ✓ ${fmtMs(m.ms)}`); break;
      case 'invalid': say(`RUN NOT COUNTED: ${m.reason}`); break;
      case 'notice': banner(String(m.text).toUpperCase(), 3000); break;
    }
  },
  onGhost(frames) { ghostFrames = frames; },
});

function setPhase(p: 'lobby' | 'race', endsAt: number, go: number, serverNow: number, results?: any, first = false) {
  const was = phase;
  phase = p;
  phaseEndsAt = endsAt;
  goAt = go;
  if (net.offset === -Infinity && serverNow) net.offset = serverNow - performance.now();
  if (p === 'lobby') {
    newRound();
    fly.on = true;
    lastCount = -1;
    if (!first && results) showPodium(results);
  } else if (p === 'race') {
    fly.on = false;
    if (was !== 'race') { newRound(); if (!first) { $('countdown').hidden = true; banner('GO', 900); audio.countdown(true); } }
  }
}

function ordinal(n: number) { return `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4)] ?? 'th'}`; }

// Results of the race that just ended, shown for the first seconds of the lobby.
function showPodium(results: { top: { id: number; place: number; ms: number; name: string; spray?: string; bot?: boolean }[]; finishers: number }) {
  const el = $('podium');
  const rows = results.top ?? [];
  const winner = rows[0];
  el.innerHTML = `<div class="brand"><span class="logo">${winner ? 'ROUND OVER' : 'NO FINISHERS'}</span><span class="level">${results.finishers ?? 0} FINISHED</span></div>`
    + `<div class="rows">${rows.map(r => `<div class="p${r.place === 1 ? ' first' : ''}"><div class="place">${ordinal(r.place).toUpperCase()}</div>${r.spray && !prof.hide ? `<img src="/img/${esc(r.spray)}">` : r.bot ? `<img src="${defaultSprayFor(r.id)}">` : ''}<div class="name">${esc(r.name)}</div>${r.bot ? '<div class="bot">BOT</div>' : ''}<div class="ms">${fmtMs(r.ms)}</div></div>`).join('')}</div>`
    + `<p>Next launch in a few seconds.</p>`;
  el.hidden = false;
  if (winner?.id === myId) audio.fanfare();
  setTimeout(() => (el.hidden = true), 6000);
}

// --- input + full screen -----------------------------------------------------
const canvas = world.renderer.domElement;
function launch(fullscreen: boolean) {
  if (fullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => canvas.requestPointerLock());
  else canvas.requestPointerLock();
  prof.name = input('name').value.trim() || callsign();
  prof.hide = input('hideImages').checked;
  localStorage.setItem('name', prof.name);
  localStorage.setItem('sens', input('sens').value);
  localStorage.setItem('hideImages', prof.hide ? '1' : '');
  myGlider.setName(prof.name);
  audio.start();
  refreshImages();
  if (!net.ws) net.connect(() => ({ name: prof.name }));
  else uploadSpray();
  $('hud').hidden = false;
}
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement && document.pointerLockElement !== canvas) canvas.requestPointerLock(); });
document.addEventListener('pointerlockerror', () => { $('menu').hidden = true; banner('CLICK THE GAME TO GRAB THE MOUSE', 4000); });
$('play').onclick = () => launch(false);
$('playFs').onclick = () => launch(true);
canvas.onclick = () => { if (!$('menu').hidden) return; canvas.requestPointerLock(); };
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  $('menu').hidden = locked || chatting;
  if (!locked) { keys.clear(); renderPlayers(); }
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas || chatting) return;
  const k = (Number(input('sens').value) || 2) * 0.022 * (Math.PI / 180);
  yaw -= e.movementX * k;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * k));
});
const chatInput = input('chatInput');
function openChat() {
  chatting = true;
  $('chatLine').hidden = false;
  chatInput.value = '';
  keys.clear();
  setTimeout(() => chatInput.focus(), 0);
}
function closeChat(send: boolean) {
  const text = chatInput.value.trim();
  chatting = false;
  $('chatLine').hidden = true;
  chatInput.blur();
  if (send && text) { if (net.connected) net.send({ t: 'chat', text }); else chatLog(`<b style="color:#ffb000">${esc(prof.name)}</b>: ${esc(text)}`); }
  canvas.focus();
}
chatInput.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') closeChat(true); else if (e.key === 'Escape') closeChat(false); });
addEventListener('keydown', e => {
  if (chatting) return;
  if (e.code === 'F11' || (e.altKey && e.code === 'Enter')) { e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); return; }
  if (!$('podium').hidden && e.code !== 'Tab') $('podium').hidden = true;
  if ($('hud').hidden) return;
  if (e.code === 'KeyY' && !e.repeat) { e.preventDefault(); openChat(); return; }
  if (document.pointerLockElement !== canvas) return;
  if (['Tab', 'Space', 'ControlLeft', 'KeyW', 'KeyS'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyF' && phase !== 'lobby') { respawn(stage); audio.fail(); }
  if (e.code === 'KeyV') thirdPerson = !thirdPerson;
  if (e.code === 'KeyG') { ghostOn = !ghostOn; banner(ghostOn ? 'GHOST ON' : 'GHOST OFF', 900); }
  if (e.code === 'KeyT') spray();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function renderPlayers() {
  const rows = [...profiles].filter(([id]) => id !== myId);
  $('players').innerHTML = rows.length
    ? `<h3>PLAYERS ONLINE</h3>` + rows.map(([id, p]) => `<div><span>${esc(p.name)}${p.bot ? ' <i>[BOT]</i>' : ''}</span><button type="button" data-mute="${id}">${muted.has(id) ? 'UNMUTE' : 'MUTE'}</button></div>`).join('')
    : '';
}
$('players').onclick = e => {
  const t = e.target as HTMLElement;
  if (t.dataset.mute === undefined) return;
  const id = Number(t.dataset.mute);
  muted.has(id) ? muted.delete(id) : muted.add(id);
  applyFlag(id); applySpray(id);
  renderPlayers();
};

// --- spraying -----------------------------------------------------------------
const eye = (): V3 => add(me.pos, [0, 0, me.ducked ? DUCK_EYE : EYE]);
const aim = (): V3 => [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];

// T: inside a wall's zone it paints the wall; anywhere else it's a CS spray on whatever you're looking at.
function spray() {
  const maxs = hullMax(me);
  const wall = level.triggers.find(t => t.type === 'wall' && touching(t, me.pos, maxs)) as (typeof level.triggers[number] & { id?: number }) | undefined;
  if (wall) { net.send({ t: 'wall', id: wall.id }); world.sparks(me.pos, [0, 0, 1], 12, 0xff2bd6); return; }
  const o = eye();
  const tr = trace(level, o, add(o, scale(aim(), 400)), [0, 0, 0], [0, 0, 0]);
  if (tr.fraction === 1 || !tr.normal) return banner('GET CLOSER TO A SURFACE', 1000);
  net.send({ t: 'spray', pos: tr.end, normal: tr.normal });
}

// --- simulation -------------------------------------------------------------
function tick(now: number) {
  const locked = phase === 'lobby' || introUntil > now || chatting;
  const k = (c: string) => (!locked && keys.has(c) ? 1 : 0);
  prevPos = [...me.pos] as V3;
  if (auto && !locked) { const inp = auto(me); yaw = inp.yaw; playerMove(level, me, inp); }
  else playerMove(level, me, { forward: k('KeyW') - k('KeyS'), side: k('KeyD') - k('KeyA'), jump: !!k('Space'), duck: !!(k('ControlLeft') || k('KeyC')), yaw });
  const maxs = hullMax(me);
  for (const t of level.triggers) {
    if (!touching(t, me.pos, maxs)) continue;
    if (t.type === 'start') { runStart = now; finished = false; }
    else if (t.type === 'teleport' && t.stage === stage) { respawn(stage); audio.fail(); shakeT = 0.4; }
    else if (t.type === 'checkpoint' && t.stage === stage + 1) { stage++; audio.gate(); world.sparks(me.pos, [0, 0, 1], 24, 0x35f0ff); if (auto) auto = autopilot(json.line, stage); }
    else if (t.type === 'end' && !finished && runStart !== null) { finished = true; finishMs = now - runStart; if (phase === 'solo') { banner(`FINISHED  ${fmtMs(finishMs)}`, 4000); audio.finish(); } }
    else if (t.type === 'boost') { const before = Math.hypot(me.vel[0], me.vel[1]); applyBoost(me, t); if (Math.hypot(me.vel[0], me.vel[1]) > before + 50) { audio.boost(); world.sparks(me.pos, t.dir!, 30, 0xffb000); } }
  }
  const onRamp = !!me.contact && me.contact[2] < 0.7 && me.contact[2] > -0.5;
  if (onRamp) {
    if (wasAirborne && now - lastContact > 150) { audio.touchdown(); shakeT = Math.max(shakeT, 0.15); world.sparks(me.pos, [0, 0, 1], 6); }
    lastContact = now; wasAirborne = false;
  } else if (!wasAirborne && !me.onGround && now - lastContact > 60) { wasAirborne = true; if (Math.hypot(me.vel[0], me.vel[1]) > 600) audio.liftoff(); }
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
      net.send(encodeState(me.pos, yaw, pitch, (me.ducked ? 1 : 0) | (teleported ? 2 : 0)));
      teleported = false;
    }
  }
  const t = now / 1000;
  const alpha = acc / TICK;
  const pos = [0, 1, 2].map(i => prevPos[i] + (me.pos[i] - prevPos[i]) * alpha) as V3;
  const speed = Math.hypot(me.vel[0], me.vel[1]);
  const cam = world.camera;
  const look = aim();

  const introW = introUntil > now ? world.wallInfo(introWall) : null;
  if (introW) {
    const yawR = introW.yaw * Math.PI / 180;
    const d = introW.w * 1.1;
    cam.position.set(introW.pos[0] + Math.cos(yawR) * d, introW.pos[1] + Math.sin(yawR) * d, introW.pos[2] + 80 + Math.sin(t) * 20);
    cam.lookAt(introW.pos[0], introW.pos[1], introW.pos[2]);
    myGlider.visible = false;
  } else if (fly.on && phase === 'lobby') {
    flythrough();
    myGlider.visible = true;
  } else {
    if (thirdPerson) { cam.position.set(...add(pos, add(scale(look, -240), [0, 0, 80]))); myGlider.visible = true; }
    else { cam.position.set(pos[0], pos[1], pos[2] + (me.ducked ? DUCK_EYE : EYE)); myGlider.visible = false; }
    cam.lookAt(cam.position.x + look[0], cam.position.y + look[1], cam.position.z + look[2]);
    if (shakeT > 0) { shakeT -= dt; cam.position.x += (Math.random() - 0.5) * shakeT * 14; cam.position.z += (Math.random() - 0.5) * shakeT * 14; }
  }
  world.shadowTarget.position.set(...pos);
  world.speedFx(fly.on ? 0 : speed, dt);
  myGlider.pose(pos, yaw, t, finished);
  if (speed > 900 && Math.random() < speed / 6000) world.puff(add(pos, [0, 0, 20]), 4 + Math.random() * 6, 0x8fa8c8, 0.5);

  const rt = net.renderTime();
  for (const r of net.remotes.values()) {
    if (r.id === myId) continue;
    let g = gliders.get(r.id);
    if (!g) {
      const p = profiles.get(r.id);
      g = new Glider(p?.color ?? '#888', p?.name ?? '?');
      gliders.set(r.id, g);
      g.addTo(world.scene);
      applyFlag(r.id);
    }
    const p = samplePose(r, rt);
    g.visible = !!p;
    if (p) g.pose(p.pos, p.yaw, t, !!(p.flags & 2));
  }
  for (const [id, g] of gliders) if (!net.remotes.has(id)) { g.removeFrom(world.scene); gliders.delete(id); }

  const gStart = runStart ?? (phase === 'race' ? goAt - net.offset : null);
  if (ghostOn && ghostFrames.length && gStart !== null && !finished) {
    const gt = (now - gStart) / 100;
    const i = Math.floor(gt), f = gt - i;
    if (i + 1 < ghostFrames.length) {
      const a = ghostFrames[i], b = ghostFrames[i + 1];
      ghost.visible = true;
      ghost.pose([0, 1, 2].map(j => a.pos[j] + (b.pos[j] - a.pos[j]) * f) as V3, a.yaw, t);
    } else ghost.visible = false;
  } else ghost.visible = false;

  audio.update(speed, !!me.contact && me.contact[2] < 0.7 && me.contact[2] > -0.5, phase === 'race' || phase === 'solo');
  world.tickSky(t, dt, fly.on ? 0 : speed, fly.on ? [0, 0, 0] : me.vel);
  world.tickFx(t, dt);
  world.render();
  hud(now, speed);
}

// Lobby flythrough along the racing line for the first 12 s, then the start gate for the countdown.
function flythrough() {
  const line = json.line;
  const total = Math.max(0, phaseEndsAt - net.serverNow());
  const prog = 1 - Math.min(1, Math.max(0, (total - 3000) / (LOBBY_MS - 3000)));
  const cam = world.camera;
  if (total <= 3000) {
    const sp = level.spawns[0];
    cam.position.set(sp.pos[0] - Math.cos(sp.yaw) * 700, sp.pos[1] - Math.sin(sp.yaw) * 700, sp.pos[2] + 320);
    cam.lookAt(sp.pos[0] + Math.cos(sp.yaw) * 1500, sp.pos[1] + Math.sin(sp.yaw) * 1500, sp.pos[2] - 200);
    return;
  }
  const i = Math.min(line.length - 2, Math.floor(prog * (line.length - 1)));
  const f = prog * (line.length - 1) - i;
  const a = line[i], b = line[i + 1], c = line[Math.min(line.length - 1, i + 10)];
  const p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const dx = c[0] - p[0], dy = c[1] - p[1], L = Math.hypot(dx, dy) || 1;
  cam.position.set(p[0] - dx / L * 900 - dy / L * 700, p[1] - dy / L * 900 + dx / L * 700, p[2] + 900);
  cam.lookAt(c[0], c[1], c[2] - 100);
}

// --- HUD ----------------------------------------------------------------------
function hud(now: number, speed: number) {
  ($('speed').firstElementChild as HTMLElement).textContent = String(Math.round(speed));
  $('timer').textContent = runStart === null ? '' : finished ? fmtMs(finishMs) : fmtMs(Math.max(0, now - runStart));
  $('stage').textContent = `${level.spawns[stage]?.name ?? ''}  ·  ${stage + 1} / ${level.spawns.length}`;
  const left = Math.max(0, phaseEndsAt - net.serverNow());
  if (phase === 'lobby') {
    const s = Math.ceil(left / 1000);
    $('round').innerHTML = `LOBBY<br><b>${fmtMs(left).slice(0, -3)}</b>`;
    $('hint').textContent = s > 3 ? 'NEXT LAUNCH · EVERYONE GOES AT ONCE' : '';
    const cd = $('countdown');
    if (s <= 3 && s >= 1) { cd.hidden = false; cd.textContent = String(s); if (s !== lastCount) { audio.countdown(false); lastCount = s; } } else cd.hidden = true;
  } else if (phase === 'race') {
    const racing = [...roster.values()].filter(r => !r[3]);
    const ahead = racing.filter(r => (r[2] > 0 && !finished) || (r[2] === 0 && r[0] > stage && !finished)).length;
    const myPlace = finished ? (roster.get(myId)?.[2] || 0) : ahead + 1;
    $('race').innerHTML = `<b>${myPlace ? ordinal(myPlace) : '—'}</b>OF ${Math.max(racing.length, myPlace, 1)}`; // a late joiner still counts themselves
    $('round').innerHTML = `RACE<br><b>${fmtMs(left).slice(0, -3)}</b>`;
    const inWall = level.triggers.find(t => t.type === 'wall' && touching(t, me.pos, hullMax(me))) as any;
    $('hint').textContent = inWall ? `PRESS T TO SPRAY ${String(world.wallInfo(inWall.id)?.name ?? 'THIS WALL').toUpperCase()}` : runStart === null && !finished ? 'GO · LEAVE THE START GATE TO BEGIN YOUR RUN' : record && !finished ? `RECORD ${fmtMs(record.ms)} · ${record.name}` : '';
    $('countdown').hidden = true;
  } else {
    $('round').innerHTML = `OFFLINE<br><b>SOLO</b>`;
    $('hint').textContent = record ? `RECORD ${fmtMs(record.ms)}` : '';
  }
  if (phase !== 'race') $('race').innerHTML = '';
  while (feed.length && feed[0].until < now) feed.shift();
  $('feed').innerHTML = feed.map(f => `<div>${esc(f.text)}</div>`).join('');
  for (const c of chatLines) c.el.classList.toggle('faded', now - c.at > 12000 && !chatting);
  const show = keys.has('Tab');
  $('board').hidden = !show;
  if (show) scoreboard();
}

function scoreboard() {
  const rows = [...profiles].map(([id, p]) => ({ id, p, r: roster.get(id) ?? ([0, 0, 0, false, !!p.bot] as const) }))
    .sort((a, b) => (b.r[2] > 0 ? 1e6 - b.r[2] : b.r[0]) - (a.r[2] > 0 ? 1e6 - a.r[2] : a.r[0]));
  const flag = (id: number, p: Profile) => (p.spray && showImages(id) ? `<img src="/img/${esc(p.spray)}">` : p.bot ? `<img src="${defaultSprayFor(id)}">` : '<span class="flag"></span>');
  $('board').innerHTML = `<div class="title">SKY SURF <span>MERIDIAN · ${profiles.size} ONLINE</span></div>`
    + `<table><tr><th></th><th>CALLSIGN</th><th>STAGE</th><th>TIME</th><th>PLACE</th></tr>`
    + rows.map(({ id, p, r }) => `<tr${id === myId ? ' class="me"' : ''}><td>${flag(id, p)}</td><td>${esc(p.name)}${p.bot ? ' <small>BOT</small>' : ''}</td><td>${r[1] ? '✓' : r[0] + 1}</td><td>${r[1] ? fmtMs(r[1]) : '—'}</td><td>${r[2] ? ordinal(r[2]) : r[3] ? 'late' : '—'}</td></tr>`).join('')
    + `</table><div class="cols"><div><b>BEST RUNS</b><table>${board.best.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.name)}</td><td>${fmtMs(b.ms)}</td></tr>`).join('')}</table></div>`
    + `<div><b>MOST WINS</b><table>${board.wins.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.name)}</td><td>${b.wins}</td></tr>`).join('')}</table></div></div>`;
}

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// --- boot ---------------------------------------------------------------------
(async () => {
  await world.init();
  world.buildLevel(level, json);
  ownFlag();
  if (import.meta.env.DEV) (window as any).skysurf = { me, look: (y: number, p: number) => { yaw = y; pitch = p; }, cam: () => (thirdPerson = !thirdPerson), net, world, setPhase, tab: (on: boolean) => (on ? keys.add('Tab') : keys.delete('Tab')), fly: (on: boolean) => (fly.on = on), auto: (on: boolean) => (auto = on ? autopilot(json.line, stage) : null), audio, spray, openChat, closeChat, state: () => ({ phase, stage, runStart, finished, finishMs, myId, walls: [...walls.values()], record, ghostFrames: ghostFrames.length, ghostVisible: ghost.visible, locked: document.pointerLockElement === canvas, players: profiles.size }) };
  requestAnimationFrame(frame);
})();
