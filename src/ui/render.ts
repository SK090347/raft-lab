import type { RaftCluster } from '../raft/cluster';
import type { Envelope, NodeSnapshot, Role } from '../raft/types';

const ROLE_COLOR: Record<Role | 'down', string> = {
  Leader: '#3ddc97',
  Candidate: '#ffb020',
  Follower: '#6ea8fe',
  down: '#ff5d6c',
};

interface Point {
  x: number;
  y: number;
}

function nodePositions(count: number, w: number, h: number): Point[] {
  const cx = w / 2;
  const cy = h / 2 - 10;
  const r = Math.min(w, h) * 0.32;
  return Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

function progress(env: Envelope, now: number): number {
  const span = Math.max(1, env.deliverAt - env.sentAt);
  return Math.min(1, Math.max(0, (now - env.sentAt) / span));
}

export function drawCluster(
  ctx: CanvasRenderingContext2D,
  cluster: RaftCluster,
  width: number,
  height: number,
): void {
  const snaps = cluster.snapshots();
  const msgs = cluster.messagesInFlight();
  const pts = nodePositions(snaps.length, width, height);

  ctx.clearRect(0, 0, width, height);

  // Soft grid
  ctx.strokeStyle = 'rgba(36,48,85,0.45)';
  ctx.lineWidth = 1;
  for (let x = 40; x < width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 40; y < height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Partition chords
  ctx.lineWidth = 2;
  for (let i = 0; i < snaps.length; i++) {
    for (let j = i + 1; j < snaps.length; j++) {
      if (!cluster.isPartitioned(i, j)) continue;
      const a = pts[i]!;
      const b = pts[j]!;
      ctx.strokeStyle = 'rgba(255,93,108,0.35)';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Messages in flight
  for (const env of msgs) {
    const from = pts[env.from];
    const to = pts[env.to];
    if (!from || !to) continue;
    const t = progress(env, cluster.tick);
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const isVote = env.payload.type.startsWith('RequestVote');
    ctx.fillStyle = isVote ? '#ffb020' : '#c4b5fd';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(232,238,252,0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(shortMsg(env), x + 7, y - 7);
  }

  // Nodes
  snaps.forEach((snap, i) => {
    const p = pts[i]!;
    drawNode(ctx, snap, p.x, p.y);
  });

  // Legend
  ctx.font = '12px IBM Plex Sans, sans-serif';
  const legend = [
    ['Leader', ROLE_COLOR.Leader],
    ['Candidate', ROLE_COLOR.Candidate],
    ['Follower', ROLE_COLOR.Follower],
    ['Crashed', ROLE_COLOR.down],
    ['Vote msg', '#ffb020'],
    ['AE msg', '#c4b5fd'],
  ] as const;
  let lx = 16;
  const ly = height - 18;
  for (const [label, color] of legend) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, ly, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#93a0c0';
    ctx.fillText(label, lx + 10, ly + 4);
    lx += ctx.measureText(label).width + 28;
  }
}

function shortMsg(env: Envelope): string {
  const t = env.payload.type;
  if (t === 'RequestVote') return 'RV';
  if (t === 'RequestVoteReply') return 'RVr';
  if (t === 'AppendEntries') {
    const n = env.payload.entries.length;
    return n ? `AE×${n}` : 'HB';
  }
  return 'AEr';
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  snap: NodeSnapshot,
  x: number,
  y: number,
): void {
  const roleKey: Role | 'down' = snap.alive ? snap.role : 'down';
  const color = ROLE_COLOR[roleKey];
  const r = 34;

  if (snap.role === 'Leader' && snap.alive) {
    ctx.strokeStyle = 'rgba(61,220,151,0.35)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(x, y, r + 8, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#0d1428';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 14px IBM Plex Sans, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`N${snap.id}`, x, y - 6);

  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = color;
  ctx.fillText(snap.alive ? snap.role[0]! : 'X', x, y + 10);

  ctx.fillStyle = '#93a0c0';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText(`t=${snap.currentTerm} c=${snap.commitIndex}`, x, y + r + 14);

  // Mini log bars under node
  const maxShow = 8;
  const entries = snap.log.slice(-maxShow);
  const bw = 8;
  const gap = 2;
  const totalW = entries.length * (bw + gap) - gap;
  let bx = x - totalW / 2;
  const by = y + r + 22;
  for (const e of entries) {
    ctx.fillStyle = e.index <= snap.commitIndex ? '#34d399' : '#5b8cff';
    ctx.fillRect(bx, by, bw, 10);
    bx += bw + gap;
  }

  ctx.textAlign = 'left';
}
