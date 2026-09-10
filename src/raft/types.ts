/** Raft role per Figure 4 in Ongaro & Ousterhout, "In Search of an Understandable Consensus Algorithm". */
export type Role = 'Follower' | 'Candidate' | 'Leader';

export type NodeId = number;

export interface LogEntry {
  term: number;
  command: string;
  /** Index in the log (1-based, matching the Raft paper). */
  index: number;
}

export interface RequestVoteArgs {
  type: 'RequestVote';
  term: number;
  candidateId: NodeId;
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface RequestVoteReply {
  type: 'RequestVoteReply';
  term: number;
  voteGranted: boolean;
  /** Echo so the candidate knows who replied. */
  voterId: NodeId;
  candidateId: NodeId;
}

export interface AppendEntriesArgs {
  type: 'AppendEntries';
  term: number;
  leaderId: NodeId;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: LogEntry[];
  leaderCommit: number;
}

export interface AppendEntriesReply {
  type: 'AppendEntriesReply';
  term: number;
  success: boolean;
  /** Follower id that replied. */
  followerId: NodeId;
  leaderId: NodeId;
  /** For conflict optimization / nextIndex backoff (simplified). */
  matchIndex: number;
  /** Echo of how many entries were in the request (0 = heartbeat). */
  entriesCount: number;
}

export type RaftMessage =
  | RequestVoteArgs
  | RequestVoteReply
  | AppendEntriesArgs
  | AppendEntriesReply;

export interface Envelope {
  id: number;
  from: NodeId;
  to: NodeId;
  sentAt: number;
  deliverAt: number;
  payload: RaftMessage;
}

export interface NodeSnapshot {
  id: NodeId;
  role: Role;
  currentTerm: number;
  votedFor: NodeId | null;
  log: LogEntry[];
  commitIndex: number;
  lastApplied: number;
  /** Leader-only volatile state. */
  nextIndex: Record<NodeId, number> | null;
  matchIndex: Record<NodeId, number> | null;
  electionDeadline: number;
  heartbeatDeadline: number;
  alive: boolean;
  votesReceived: Set<NodeId>;
}

export interface ClusterConfig {
  nodeCount: number;
  /** Inclusive election timeout range in simulation ticks. */
  electionTimeoutMin: number;
  electionTimeoutMax: number;
  heartbeatInterval: number;
  /** Base network latency in ticks. */
  networkDelayMin: number;
  networkDelayMax: number;
}
