import type {
  AppendEntriesArgs,
  AppendEntriesReply,
  ClusterConfig,
  LogEntry,
  NodeId,
  NodeSnapshot,
  RaftMessage,
  RequestVoteArgs,
  RequestVoteReply,
  Role,
} from './types';

export interface Outbound {
  to: NodeId;
  payload: RaftMessage;
}

/**
 * Single Raft peer (persistent + volatile state).
 * Simulation drives time via `tick(now)`; RPCs via `receive`.
 */
export class RaftNode {
  readonly id: NodeId;
  private readonly peers: NodeId[];
  private readonly cfg: ClusterConfig;

  role: Role = 'Follower';
  currentTerm = 0;
  votedFor: NodeId | null = null;
  log: LogEntry[] = [];
  commitIndex = 0;
  lastApplied = 0;

  nextIndex: Record<NodeId, number> | null = null;
  matchIndex: Record<NodeId, number> | null = null;

  electionDeadline = 0;
  heartbeatDeadline = 0;
  alive = true;
  votesReceived = new Set<NodeId>();

  constructor(id: NodeId, peers: NodeId[], cfg: ClusterConfig, now = 0) {
    this.id = id;
    this.peers = peers;
    this.cfg = cfg;
    this.resetElectionDeadline(now);
  }

  private lastLogIndex(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.index;
  }

  private lastLogTerm(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.term;
  }

  private majority(): number {
    return Math.floor((this.peers.length + 1) / 2) + 1;
  }

  private resetElectionDeadline(now: number): void {
    const span = this.cfg.electionTimeoutMax - this.cfg.electionTimeoutMin;
    const jitter = Math.floor(Math.random() * (span + 1));
    this.electionDeadline = now + this.cfg.electionTimeoutMin + jitter;
  }

  private becomeFollower(term: number, now: number): void {
    this.role = 'Follower';
    this.currentTerm = term;
    this.votedFor = null;
    this.nextIndex = null;
    this.matchIndex = null;
    this.votesReceived.clear();
    this.resetElectionDeadline(now);
  }

  private becomeCandidate(now: number): Outbound[] {
    this.role = 'Candidate';
    this.currentTerm += 1;
    this.votedFor = this.id;
    this.votesReceived = new Set([this.id]);
    this.nextIndex = null;
    this.matchIndex = null;
    this.resetElectionDeadline(now);

    const out: Outbound[] = [];
    for (const peer of this.peers) {
      out.push({
        to: peer,
        payload: {
          type: 'RequestVote',
          term: this.currentTerm,
          candidateId: this.id,
          lastLogIndex: this.lastLogIndex(),
          lastLogTerm: this.lastLogTerm(),
        },
      });
    }

    // Single-node cluster wins immediately.
    if (this.votesReceived.size >= this.majority()) {
      return [...out, ...this.becomeLeader(now)];
    }
    return out;
  }

  private becomeLeader(now: number): Outbound[] {
    this.role = 'Leader';
    this.nextIndex = {};
    this.matchIndex = {};
    const next = this.lastLogIndex() + 1;
    for (const peer of this.peers) {
      this.nextIndex[peer] = next;
      this.matchIndex[peer] = 0;
    }
    this.heartbeatDeadline = now; // send immediately
    return this.sendHeartbeats(now);
  }

  private sendHeartbeats(_now: number): Outbound[] {
    if (this.role !== 'Leader' || !this.nextIndex) return [];
    const out: Outbound[] = [];
    for (const peer of this.peers) {
      const ni = this.nextIndex[peer] ?? this.lastLogIndex() + 1;
      const prevLogIndex = ni - 1;
      const prevLogTerm =
        prevLogIndex === 0
          ? 0
          : (this.log.find((e) => e.index === prevLogIndex)?.term ?? 0);
      const entries = this.log.filter((e) => e.index >= ni);
      out.push({
        to: peer,
        payload: {
          type: 'AppendEntries',
          term: this.currentTerm,
          leaderId: this.id,
          prevLogIndex,
          prevLogTerm,
          entries: entries.map((e) => ({ ...e })),
          leaderCommit: this.commitIndex,
        },
      });
    }
    this.heartbeatDeadline = _now + this.cfg.heartbeatInterval;
    return out;
  }

  /** Advance commitIndex if a majority of matchIndex covers an entry from this term. */
  private maybeAdvanceCommit(): void {
    if (this.role !== 'Leader' || !this.matchIndex) return;
    for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
      const entry = this.log.find((e) => e.index === n);
      if (!entry || entry.term !== this.currentTerm) continue;
      let count = 1; // self
      for (const peer of this.peers) {
        if ((this.matchIndex[peer] ?? 0) >= n) count++;
      }
      if (count >= this.majority()) {
        this.commitIndex = n;
        break;
      }
    }
  }

  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
    }
  }

  /** Client command — only leaders accept; returns AppendEntries fan-out. */
  clientAppend(command: string, now: number): Outbound[] {
    if (!this.alive || this.role !== 'Leader') return [];
    const entry: LogEntry = {
      term: this.currentTerm,
      command,
      index: this.lastLogIndex() + 1,
    };
    this.log.push(entry);
    return this.sendHeartbeats(now);
  }

  crash(): void {
    this.alive = false;
  }

  /** Restart: lose volatile state, keep "persistent" term/vote/log. */
  restart(now: number): void {
    this.alive = true;
    this.role = 'Follower';
    this.commitIndex = 0;
    this.lastApplied = 0;
    this.nextIndex = null;
    this.matchIndex = null;
    this.votesReceived.clear();
    this.resetElectionDeadline(now);
  }

  tick(now: number): Outbound[] {
    if (!this.alive) return [];
    if (this.role === 'Leader') {
      if (now >= this.heartbeatDeadline) {
        return this.sendHeartbeats(now);
      }
      return [];
    }
    if (now >= this.electionDeadline) {
      return this.becomeCandidate(now);
    }
    return [];
  }

  receive(msg: RaftMessage, now: number): Outbound[] {
    if (!this.alive) return [];

    switch (msg.type) {
      case 'RequestVote':
        return this.onRequestVote(msg, now);
      case 'RequestVoteReply':
        return this.onRequestVoteReply(msg, now);
      case 'AppendEntries':
        return this.onAppendEntries(msg, now);
      case 'AppendEntriesReply':
        return this.onAppendEntriesReply(msg, now);
      default:
        return [];
    }
  }

  private onRequestVote(msg: RequestVoteArgs, now: number): Outbound[] {
    if (msg.term > this.currentTerm) {
      this.becomeFollower(msg.term, now);
    }

    let voteGranted = false;
    if (msg.term === this.currentTerm) {
      const upToDate =
        msg.lastLogTerm > this.lastLogTerm() ||
        (msg.lastLogTerm === this.lastLogTerm() &&
          msg.lastLogIndex >= this.lastLogIndex());
      if (
        (this.votedFor === null || this.votedFor === msg.candidateId) &&
        upToDate
      ) {
        this.votedFor = msg.candidateId;
        voteGranted = true;
        this.resetElectionDeadline(now);
      }
    }

    const reply: RequestVoteReply = {
      type: 'RequestVoteReply',
      term: this.currentTerm,
      voteGranted,
      voterId: this.id,
      candidateId: msg.candidateId,
    };
    return [{ to: msg.candidateId, payload: reply }];
  }

  private onRequestVoteReply(msg: RequestVoteReply, now: number): Outbound[] {
    if (msg.term > this.currentTerm) {
      this.becomeFollower(msg.term, now);
      return [];
    }
    if (
      this.role !== 'Candidate' ||
      msg.term !== this.currentTerm ||
      msg.candidateId !== this.id
    ) {
      return [];
    }
    if (msg.voteGranted) {
      this.votesReceived.add(msg.voterId);
      if (this.votesReceived.size >= this.majority()) {
        return this.becomeLeader(now);
      }
    }
    return [];
  }

  private onAppendEntries(msg: AppendEntriesArgs, now: number): Outbound[] {
    if (msg.term > this.currentTerm) {
      this.becomeFollower(msg.term, now);
    }

    if (msg.term < this.currentTerm) {
      const reply: AppendEntriesReply = {
        type: 'AppendEntriesReply',
        term: this.currentTerm,
        success: false,
        followerId: this.id,
        leaderId: msg.leaderId,
        matchIndex: 0,
        entriesCount: msg.entries.length,
      };
      return [{ to: msg.leaderId, payload: reply }];
    }

    // Valid leader heartbeat / append — step down if candidate.
    if (this.role !== 'Follower') {
      this.role = 'Follower';
      this.nextIndex = null;
      this.matchIndex = null;
      this.votesReceived.clear();
    }
    this.resetElectionDeadline(now);

    // Log consistency check.
    if (msg.prevLogIndex > 0) {
      const prev = this.log.find((e) => e.index === msg.prevLogIndex);
      if (!prev || prev.term !== msg.prevLogTerm) {
        const reply: AppendEntriesReply = {
          type: 'AppendEntriesReply',
          term: this.currentTerm,
          success: false,
          followerId: this.id,
          leaderId: msg.leaderId,
          matchIndex: 0,
          entriesCount: msg.entries.length,
        };
        return [{ to: msg.leaderId, payload: reply }];
      }
    }

    // Append new entries, truncating conflicts (Figure 2).
    for (const entry of msg.entries) {
      const existing = this.log.find((e) => e.index === entry.index);
      if (existing) {
        if (existing.term !== entry.term) {
          this.log = this.log.filter((e) => e.index < entry.index);
          this.log.push({ ...entry });
        }
      } else {
        this.log.push({ ...entry });
      }
    }
    this.log.sort((a, b) => a.index - b.index);

    if (msg.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(msg.leaderCommit, this.lastLogIndex());
    }
    this.applyCommitted();

    const matchIndex =
      msg.entries.length > 0
        ? msg.entries[msg.entries.length - 1]!.index
        : msg.prevLogIndex;

    const reply: AppendEntriesReply = {
      type: 'AppendEntriesReply',
      term: this.currentTerm,
      success: true,
      followerId: this.id,
      leaderId: msg.leaderId,
      matchIndex,
      entriesCount: msg.entries.length,
    };
    return [{ to: msg.leaderId, payload: reply }];
  }

  private onAppendEntriesReply(msg: AppendEntriesReply, now: number): Outbound[] {
    if (msg.term > this.currentTerm) {
      this.becomeFollower(msg.term, now);
      return [];
    }
    if (this.role !== 'Leader' || !this.nextIndex || !this.matchIndex) {
      return [];
    }
    if (msg.leaderId !== this.id || msg.term !== this.currentTerm) {
      return [];
    }

    const follower = msg.followerId;
    if (msg.success) {
      this.matchIndex[follower] = Math.max(
        this.matchIndex[follower] ?? 0,
        msg.matchIndex,
      );
      this.nextIndex[follower] = (this.matchIndex[follower] ?? 0) + 1;
      this.maybeAdvanceCommit();
      this.applyCommitted();
      return [];
    }

    // Back off nextIndex and retry.
    this.nextIndex[follower] = Math.max(1, (this.nextIndex[follower] ?? 1) - 1);
    return this.sendHeartbeats(now);
  }

  snapshot(): NodeSnapshot {
    return {
      id: this.id,
      role: this.role,
      currentTerm: this.currentTerm,
      votedFor: this.votedFor,
      log: this.log.map((e) => ({ ...e })),
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      nextIndex: this.nextIndex ? { ...this.nextIndex } : null,
      matchIndex: this.matchIndex ? { ...this.matchIndex } : null,
      electionDeadline: this.electionDeadline,
      heartbeatDeadline: this.heartbeatDeadline,
      alive: this.alive,
      votesReceived: new Set(this.votesReceived),
    };
  }
}
