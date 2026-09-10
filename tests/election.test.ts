import { describe, it, expect, beforeEach } from 'vitest';
import { RaftCluster } from '../src/raft/cluster';

describe('Raft election', () => {
  let cluster: RaftCluster;

  beforeEach(() => {
    // Deterministic-ish: tight timeouts, low delay for fast elections in tests.
    cluster = new RaftCluster({
      nodeCount: 5,
      electionTimeoutMin: 5,
      electionTimeoutMax: 12,
      heartbeatInterval: 3,
      networkDelayMin: 1,
      networkDelayMax: 1,
    });
  });

  it('elects exactly one leader under stable network', () => {
    cluster.run(80);
    const leaders = cluster.nodes.filter((n) => n.alive && n.role === 'Leader');
    expect(leaders.length).toBe(1);
    const term = leaders[0]!.currentTerm;
    expect(term).toBeGreaterThan(0);
    // All alive followers should be in the same (or not higher) term and following.
    for (const n of cluster.nodes) {
      expect(n.currentTerm).toBeGreaterThanOrEqual(term - 1);
    }
  });

  it('re-elects after leader crash', () => {
    cluster.run(80);
    const leader = cluster.leader();
    expect(leader).toBeDefined();
    const oldId = leader!.id;
    const oldTerm = leader!.currentTerm;

    cluster.crash(oldId);
    cluster.run(100);

    const newLeaders = cluster.nodes.filter(
      (n) => n.alive && n.role === 'Leader',
    );
    expect(newLeaders.length).toBe(1);
    expect(newLeaders[0]!.id).not.toBe(oldId);
    expect(newLeaders[0]!.currentTerm).toBeGreaterThan(oldTerm);
  });

  it('does not elect a leader in a minority partition', () => {
    // Isolate nodes 0,1 from 2,3,4 (minority of 2).
    cluster.isolate(0, true);
    cluster.isolate(1, true);
    // Also cut 0-1 so each is alone? Better: partition {0,1} vs {2,3,4}
    cluster.clearPartitions();
    for (const a of [0, 1]) {
      for (const b of [2, 3, 4]) {
        cluster.setPartition(a, b, true);
      }
    }

    cluster.run(100);

    const minorityLeaders = [0, 1]
      .map((id) => cluster.nodes[id]!)
      .filter((n) => n.role === 'Leader');
    // Minority of 2 cannot reach majority (3 of 5).
    expect(minorityLeaders.length).toBe(0);

    const majorityLeaders = [2, 3, 4]
      .map((id) => cluster.nodes[id]!)
      .filter((n) => n.role === 'Leader');
    expect(majorityLeaders.length).toBe(1);
  });
});
