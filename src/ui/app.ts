import { RaftCluster } from '../raft/cluster';
import { drawCluster } from './render';

export function mountApp(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('#canvas')!;
  const ctx = canvas.getContext('2d')!;
  const tickEl = root.querySelector('#tick')!;
  const leaderEl = root.querySelector('#leader-badge')!;
  const eventsEl = root.querySelector('#events')!;
  const tableEl = root.querySelector('#node-table')!;
  const speedEl = root.querySelector<HTMLInputElement>('#speed')!;
  const cmdEl = root.querySelector<HTMLInputElement>('#cmd')!;
  const nodeSelect = root.querySelector<HTMLSelectElement>('#node-select')!;

  const cluster = new RaftCluster();
  let auto = false;
  let raf = 0;
  let acc = 0;
  let lastTs = 0;

  function selectedNode(): number {
    return Number(nodeSelect.value);
  }

  function render(): void {
    drawCluster(ctx, cluster, canvas.width, canvas.height);
    tickEl.textContent = `tick ${cluster.tick}`;
    const leader = cluster.leader();
    leaderEl.textContent = leader
      ? `leader N${leader.id} · term ${leader.currentTerm}`
      : 'no leader';

    // Events (newest first)
    const recent = [...cluster.events].slice(-40).reverse();
    eventsEl.innerHTML = recent
      .map(
        (e) =>
          `<li><strong>t${e.tick}</strong> [${e.kind}] ${escapeHtml(e.detail)}</li>`,
      )
      .join('');

    tableEl.innerHTML = cluster
      .snapshots()
      .map((s) => {
        const roleClass = s.alive ? s.role : 'down';
        const roleLabel = s.alive ? s.role : 'Crashed';
        const log = s.log
          .map((e) => {
            const cls = e.index <= s.commitIndex ? 'c' : '';
            return `<span class="${cls}">[${e.index}:${e.term} ${escapeHtml(e.command)}]</span>`;
          })
          .join(' ');
        return `<div class="card">
          <div><strong>N${s.id}</strong> · <span class="role ${roleClass}">${roleLabel}</span></div>
          <div>term ${s.currentTerm} · votedFor ${s.votedFor ?? '—'} · commit ${s.commitIndex}</div>
          <div class="log-line">${log || '(empty log)'}</div>
        </div>`;
      })
      .join('');
  }

  function escapeHtml(s: string): string {
    return s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function stepOnce(): void {
    cluster.step();
    render();
  }

  function loop(ts: number): void {
    if (!auto) return;
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const speed = Number(speedEl.value); // steps per second-ish
    acc += (dt / 1000) * speed;
    while (acc >= 1) {
      cluster.step();
      acc -= 1;
    }
    render();
    raf = requestAnimationFrame(loop);
  }

  root.querySelector('#btn-step')!.addEventListener('click', () => {
    auto = false;
    cancelAnimationFrame(raf);
    root.querySelector('#btn-auto')!.textContent = 'Auto ▶';
    stepOnce();
  });

  root.querySelector('#btn-auto')!.addEventListener('click', (ev) => {
    auto = !auto;
    (ev.target as HTMLButtonElement).textContent = auto ? 'Pause ⏸' : 'Auto ▶';
    if (auto) {
      lastTs = 0;
      acc = 0;
      raf = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(raf);
    }
  });

  root.querySelector('#btn-reset')!.addEventListener('click', () => {
    auto = false;
    cancelAnimationFrame(raf);
    root.querySelector('#btn-auto')!.textContent = 'Auto ▶';
    cluster.reset();
    render();
  });

  root.querySelector('#btn-submit')!.addEventListener('click', () => {
    const cmd = cmdEl.value.trim() || undefined;
    cluster.submit(cmd);
    cmdEl.value = '';
    render();
  });

  cmdEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = cmdEl.value.trim() || undefined;
      cluster.submit(cmd);
      cmdEl.value = '';
      render();
    }
  });

  root.querySelector('#btn-crash')!.addEventListener('click', () => {
    cluster.crash(selectedNode());
    render();
  });

  root.querySelector('#btn-restart')!.addEventListener('click', () => {
    cluster.restart(selectedNode());
    render();
  });

  root.querySelector('#btn-isolate')!.addEventListener('click', () => {
    cluster.isolate(selectedNode(), true);
    render();
  });

  root.querySelector('#btn-heal')!.addEventListener('click', () => {
    cluster.clearPartitions();
    render();
  });

  // Kick a few steps so the UI isn't empty on first paint.
  cluster.run(1);
  render();
}
