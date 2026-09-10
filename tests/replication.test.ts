import { describe, it, expect, beforeEach } from 'vitest';
import { RaftCluster } from '../src/raft/cluster';

describe('Raft log replication', () => {
  let cluster: RaftCluster;

  beforeEach(() => {
    cluster = new RaftCluster({
      nodeCount: 5,
      electionTimeoutMin: 5,
      electionTimeoutMax: 12,
      heartbeatInterval: 3,
      networkDelayMin: 1,
      networkDelayMax: 1,
    });
  });

  function electLeader(): void {
    cluster.run(80);
    expect(cluster.leader()).toBeDefined();
  }

  it('replicates and commits a client command on majority', () => {
    electLeader();
    const ok = cluster.submit('set-x=1');
    expect(ok).toBe(true);

    cluster.run(40);

    const leader = cluster.leader();
    expect(leader).toBeDefined();
    expect(leader!.commitIndex).toBeGreaterThanOrEqual(1);

    const committed = leader!.log.find((e) => e.index === 1);
    expect(committed?.command).toBe('set-x=1');

    // Majority of nodes should have the entry and matching commit.
    const withEntry = cluster.nodes.filter(
      (n) => n.alive && n.log.some((e) => e.command === 'set-x=1'),
    );
    expect(withEntry.length).toBeGreaterThanOrEqual(3);

    const committedCount = cluster.nodes.filter(
      (n) => n.alive && n.commitIndex >= 1,
    ).length;
    expect(committedCount).toBeGreaterThanOrEqual(3);
  });

  it('replicates multiple entries in order', () => {
    electLeader();
    expect(cluster.submit('a')).toBe(true);
    cluster.run(15);
    expect(cluster.submit('b')).toBe(true);
    cluster.run(15);
    expect(cluster.submit('c')).toBe(true);
    cluster.run(40);

    const leader = cluster.leader()!;
    expect(leader.commitIndex).toBeGreaterThanOrEqual(3);
    const cmds = leader.log
      .filter((e) => e.index <= leader.commitIndex)
      .map((e) => e.command);
    expect(cmds).toEqual(['a', 'b', 'c']);
  });

  it('rejects client appends when there is no leader', () => {
    // Fresh cluster, before election settles — crash everyone briefly.
    for (const n of cluster.nodes) n.crash();
    expect(cluster.submit('nope')).toBe(false);
  });

  it('follower catches up after brief isolation', () => {
    electLeader();
    const leader = cluster.leader()!;
    const followerId = cluster.nodes.find(
      (n) => n.id !== leader.id && n.alive,
    )!.id;

    cluster.isolate(followerId, true);
    expect(cluster.submit('during-partition')).toBe(true);
    cluster.run(40);

    // Leader majority (4) should still commit.
    expect(cluster.leader()!.commitIndex).toBeGreaterThanOrEqual(1);

    cluster.isolate(followerId, false);
    cluster.run(50);

    const follower = cluster.nodes[followerId]!;
    expect(follower.log.some((e) => e.command === 'during-partition')).toBe(
      true,
    );
    expect(follower.commitIndex).toBeGreaterThanOrEqual(1);
  });
});
