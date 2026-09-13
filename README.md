# raft-lab

I wanted to stop nodding along to Raft blog posts and actually *feel* elections break under partitions. This is a small TypeScript cluster you can step, crash, isolate, and heal — with a canvas UI and Vitest coverage on the state machine.

[![CI](https://github.com/SK090347/raft-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/SK090347/raft-lab/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE)

Sumit Kumar Ta ([SK090347](https://github.com/SK090347)) · MIT OR Apache-2.0

## How it works

Raft elects a leader and replicates a totally ordered log. With cluster size \(n\), a majority quorum is

\[
q = \left\lfloor \frac{n}{2} \right\rfloor + 1
\]

**Election.** A candidate wins term \(T\) with \(q\) votes. Vote grant needs: candidate term ≥ voter term, no prior vote in \(T\), and an at-least-as-up-to-date log (last term, then last index). At most one leader per term.

**Replication & commit.** The leader appends \((\mathrm{term}, \mathrm{index}, \mathrm{command})\). Index \(i\) commits when a majority reports `matchIndex` covering it *and* the entry’s term equals the leader’s current term:

\[
\mathrm{commitIndex} = \max\bigl\{ i : |\{p : \mathrm{matchIndex}[p] \ge i\}| \ge q\ \wedge\ \mathrm{log}[i].\mathrm{term} = T_{\mathrm{leader}} \bigr\}
\]

| Field | Role |
|-------|------|
| `currentTerm` | Logical clock |
| `commitIndex` | Highest index durable on a majority |
| Log matching | Same index+term ⇒ identical prefix |

Majority quorums intersect — that’s the safety heart. Watching it under crash/partition makes the paper less abstract. Based on [Ongaro & Ousterhout, USENIX ATC 2014](https://raft.github.io/raft.pdf).

## Quick start

```bash
npm install
npm test          # Raft unit tests
npm run dev       # Vite → http://localhost:5173
npm run build
```

### Simulator controls

| Control | Effect |
|--------|--------|
| **Step** | One discrete tick (RPCs, then timers) |
| **Auto** | Continuous ticking; Speed ≈ ticks/sec |
| **Submit** | Client command → current leader (no-op if none) |
| **Crash / Restart** | Kill or revive a peer |
| **Isolate / Heal** | Partition a node, or clear cuts |

## Layout

```
src/raft/
  types.ts      # Role, LogEntry, RPC payloads
  node.ts       # Single-peer state machine (Figure 2)
  cluster.ts    # Clock, network, partitions, client submit
src/ui/         # Canvas + controls
tests/          # Vitest: election + replication
```

## What’s implemented

Election timeout → candidate, `RequestVote` rules, majority → leader + heartbeat, log match/truncate/append, current-term commit rule, crash/restart (volatile wipe), partitions (minority can’t elect).

This is a **teaching simulator** — no disk persistence, snapshots, or membership changes. Goal is clarity of the Figure 2 machine under fault injection.

## License

**MIT** OR **Apache-2.0** — see [LICENSE](LICENSE), [LICENSE-APACHE](LICENSE-APACHE), [NOTICE](NOTICE).
