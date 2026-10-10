// Built-in sprays, drawn procedurally so there are no image assets. Each renders onto a 128×128 transparent canvas.
export type Spray = { key: string; name: string; draw: (g: CanvasRenderingContext2D) => void };

const C = { ink: '#0b0d12', cyan: '#35f0ff', magenta: '#ff2bd6', amber: '#ffb000', bone: '#eef2f7', red: '#ff3b3b', green: '#80ed99' };
const FONT = '"Rajdhani", "Bahnschrift", "DIN Alternate", Impact, "Arial Black", sans-serif';

function stencil(g: CanvasRenderingContext2D, text: string, y: number, size: number, color: string) {
  g.font = `700 ${size}px ${FONT}`;
  g.textAlign = 'center';
  g.lineWidth = 6; g.strokeStyle = C.ink;
  g.strokeText(text, 64, y);
  g.fillStyle = color;
  g.fillText(text, 64, y);
}

export const SPRAYS: Spray[] = [
  { key: 'skull', name: 'Skull', draw: g => {
    g.fillStyle = C.bone;
    g.beginPath(); g.arc(64, 54, 34, 0, Math.PI * 2); g.fill();
    g.fillRect(42, 70, 44, 24);
    g.fillStyle = C.ink;
    g.beginPath(); g.arc(50, 52, 9, 0, Math.PI * 2); g.arc(78, 52, 9, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(64, 62); g.lineTo(58, 72); g.lineTo(70, 72); g.closePath(); g.fill();
    for (let i = 0; i < 4; i++) g.fillRect(46 + i * 10, 82, 4, 12);
    g.strokeStyle = C.bone; g.lineWidth = 8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(20, 100); g.lineTo(108, 118); g.moveTo(108, 100); g.lineTo(20, 118); g.stroke();
  } },
  { key: 'bolt', name: 'Bolt', draw: g => {
    g.fillStyle = C.amber; g.strokeStyle = C.ink; g.lineWidth = 5; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(74, 6); g.lineTo(34, 70); g.lineTo(60, 70); g.lineTo(48, 122); g.lineTo(96, 52); g.lineTo(70, 52); g.lineTo(84, 6); g.closePath();
    g.fill(); g.stroke();
  } },
  { key: 'flame', name: 'Flame', draw: g => {
    const flame = (col: string, k: number) => {
      g.fillStyle = col;
      g.beginPath(); g.moveTo(64, 120 - k * 10); g.bezierCurveTo(20 + k * 8, 110, 24 + k * 8, 60, 50, 40 + k * 10);
      g.bezierCurveTo(52, 60, 60, 60, 60, 44 + k * 8); g.bezierCurveTo(70, 56, 68, 70, 64, 12 + k * 14);
      g.bezierCurveTo(78, 40, 110 - k * 8, 70, 104 - k * 8, 100); g.bezierCurveTo(100, 115, 80, 124, 64, 120 - k * 10); g.fill();
    };
    flame(C.red, 0); flame(C.amber, 1); flame('#fff3b0', 2);
  } },
  { key: 'gg', name: 'GG', draw: g => { g.fillStyle = C.magenta; g.fillRect(8, 30, 112, 68); stencil(g, 'GG', 86, 64, C.bone); } },
  { key: 'cat', name: 'Cat', draw: g => {
    g.fillStyle = C.ink;
    g.beginPath(); g.moveTo(24, 50); g.lineTo(30, 14); g.lineTo(54, 36); g.lineTo(74, 36); g.lineTo(98, 14); g.lineTo(104, 50); g.bezierCurveTo(112, 90, 90, 112, 64, 112); g.bezierCurveTo(38, 112, 16, 90, 24, 50); g.fill();
    g.fillStyle = C.green;
    g.beginPath(); g.ellipse(48, 64, 9, 11, 0, 0, Math.PI * 2); g.ellipse(80, 64, 9, 11, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.ink; g.fillRect(46, 56, 4, 16); g.fillRect(78, 56, 4, 16);
    g.fillStyle = C.magenta; g.beginPath(); g.moveTo(58, 80); g.lineTo(70, 80); g.lineTo(64, 88); g.fill();
    g.strokeStyle = C.bone; g.lineWidth = 2;
    for (const d of [-1, 1]) for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(64 + d * 14, 84 + i * 4); g.lineTo(64 + d * 44, 78 + i * 8); g.stroke(); }
  } },
  { key: 'smiley', name: 'Smiley', draw: g => {
    g.fillStyle = C.amber; g.strokeStyle = C.ink; g.lineWidth = 5;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = C.ink; g.beginPath(); g.arc(46, 50, 7, 0, Math.PI * 2); g.arc(82, 50, 7, 0, Math.PI * 2); g.fill();
    g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.arc(64, 68, 30, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    g.fillStyle = C.ink; g.fillRect(30, 40, 30, 8); g.fillRect(68, 40, 30, 8); // sunglasses bar
  } },
  { key: 'boards', name: 'Crossed boards', draw: g => {
    const board = (a: number, col: string) => {
      g.save(); g.translate(64, 64); g.rotate(a);
      g.fillStyle = col; g.strokeStyle = C.ink; g.lineWidth = 4;
      g.beginPath(); g.ellipse(0, 0, 14, 56, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.strokeStyle = C.bone; g.lineWidth = 3; g.beginPath(); g.moveTo(0, -46); g.lineTo(0, 46); g.stroke();
      g.restore();
    };
    board(-0.6, C.cyan); board(0.6, C.magenta);
  } },
  { key: 'surf', name: 'SURF', draw: g => {
    for (const [dx, col] of [[-4, C.magenta], [4, C.cyan], [0, C.bone]] as const) { g.save(); g.translate(dx, 0); stencil(g, 'SURF', 80, 54, col); g.restore(); }
    g.fillStyle = C.ink; for (let y = 20; y < 110; y += 7) g.fillRect(8, y, 112, 2);
  } },
];

export function sprayDataUrl(key: string) {
  const s = SPRAYS.find(x => x.key === key) ?? SPRAYS[0];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  s.draw(c.getContext('2d')!);
  return c.toDataURL('image/png');
}
