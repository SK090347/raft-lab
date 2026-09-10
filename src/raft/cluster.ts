import { RaftNode } from './node';
import type {
  ClusterConfig,
  Envelope,
  NodeId,
  NodeSnapshot,
  RaftMessage,
} from './types';

export const DEFAULT_CONFIG: ClusterConfig = {
  nodeCount: 5,
  electionTimeoutMin: 15,
  electionTimeoutMax: 30,
  heartbeatInterval: 5,
  networkDelayMin: 1,
  networkDelayMax: 3,
};

export interface ClusterEvent {
  tick: number;
  kind: string;
  detail: string;
}

/**
 * Discrete-time Raft cluster with in-flight messages, partitions, and crashes.
 */
export class RaftCluster {
  readonly cfg: ClusterConfig;
  readonly nodes: RaftNode[];
  tick = 0;
  private nextMsgId = 1;
  private inbox: Envelope[] = [];
  /** Undirected partition edges: "a-b" with a < b means a and b cannot talk. */
  private partitions = new Set<string>();
  events: ClusterEvent[] = [];
  private commandCounter = 0;

  constructor(cfg: Partial<ClusterConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    const ids = Array.from({ length: this.cfg.nodeCount }, (_, i) => i);
    this.nodes = ids.map(
      (id) =>
        new RaftNode(
          id,
          ids.filter((p) => p !== id),
          this.cfg,
          0,
        ),
    );
  }

  private edgeKey(a: NodeId, b: NodeId): string {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  isPartitioned(a: NodeId, b: NodeId): boolean {
    return this.partitions.has(this.edgeKey(a, b));
  }

  setPartition(a: NodeId, b: NodeId, partitioned: boolean): void {
    const key = this.edgeKey(a, b);
    if (partitioned) this.partitions.add(key);
    else this.partitions.delete(key);
    this.logEvent(
      partitioned ? 'partition' : 'heal',
      `nodes ${a} ↔ ${b} ${partitioned ? 'cut' : 'healed'}`,
    );
  }

  /** Partition node from everyone else (island). */
  isolate(node: NodeId, isolated: boolean): void {
    for (const other of this.nodes) {
      if (other.id === node) continue;
      this.setPartition(node, other.id, isolated);
    }
  }

  clearPartitions(): void {
    this.partitions.clear();
    this.logEvent('heal', 'all partitions cleared');
  }

  private logEvent(kind: string, detail: string): void {
    this.events.push({ tick: this.tick, kind, detail });
    if (this.events.length > 200) this.events.shift();
  }

  private delay(): number {
    const span = this.cfg.networkDelayMax - this.cfg.networkDelayMin;
    return this.cfg.networkDelayMin + Math.floor(Math.random() * (span + 1));
  }

  private enqueue(from: NodeId, to: NodeId, payload: RaftMessage): void {
    if (this.isPartitioned(from, to)) return;
    const env: Envelope = {
      id: this.nextMsgId++,
      from,
      to,
      sentAt: this.tick,
      deliverAt: this.tick + this.delay(),
      payload,
    };
    this.inbox.push(env);
  }

  private dispatchOutbound(
    from: NodeId,
    outs: { to: NodeId; payload: RaftMessage }[],
  ): void {
    for (const o of outs) this.enqueue(from, o.to, o.payload);
  }

  step(): void {
    this.tick += 1;
    const now = this.tick;

    // Deliver due messages first (stable order by id).
    const due = this.inbox
      .filter((m) => m.deliverAt <= now)
      .sort((a, b) => a.id - b.id);
    this.inbox = this.inbox.filter((m) => m.deliverAt > now);

    for (const env of due) {
      if (this.isPartitioned(env.from, env.to)) continue;
      const node = this.nodes[env.to];
      if (!node) continue;
      const outs = node.receive(env.payload, now);
      this.dispatchOutbound(env.to, outs);
      this.logEvent(
        'deliver',
        `${env.from}→${env.to} ${env.payload.type} term=${'term' in env.payload ? env.payload.term : '?'}`,
      );
    }

    // Then tick each alive node (elections / heartbeats).
    for (const node of this.nodes) {
      const outs = node.tick(now);
      this.dispatchOutbound(node.id, outs);
    }
  }

  /** Run N simulation steps. */
  run(steps: number): void {
    for (let i = 0; i < steps; i++) this.step();
  }

  crash(id: NodeId): void {
    this.nodes[id]?.crash();
    this.logEvent('crash', `node ${id} crashed`);
  }

  restart(id: NodeId): void {
    this.nodes[id]?.restart(this.tick);
    this.logEvent('restart', `node ${id} restarted`);
  }

  /** Submit a client command to the current leader (if any). */
  submit(command?: string): boolean {
    const leader = this.leader();
    if (!leader) return false;
    const cmd = command ?? `cmd-${++this.commandCounter}`;
    const outs = leader.clientAppend(cmd, this.tick);
    this.dispatchOutbound(leader.id, outs);
    this.logEvent('client', `leader ${leader.id} accepted "${cmd}"`);
    return true;
  }

  leader(): RaftNode | undefined {
    return this.nodes.find((n) => n.alive && n.role === 'Leader');
  }

  messagesInFlight(): Envelope[] {
    return this.inbox.map((m) => ({
      ...m,
      payload: structuredClone(m.payload),
    }));
  }

  snapshots(): NodeSnapshot[] {
    return this.nodes.map((n) => n.snapshot());
  }

  reset(): void {
    const ids = Array.from({ length: this.cfg.nodeCount }, (_, i) => i);
    this.nodes.length = 0;
    for (const id of ids) {
      this.nodes.push(
        new RaftNode(
          id,
          ids.filter((p) => p !== id),
          this.cfg,
          0,
        ),
      );
    }
    this.tick = 0;
    this.nextMsgId = 1;
    this.inbox = [];
    this.partitions.clear();
    this.events = [];
    this.commandCounter = 0;
  }
}
