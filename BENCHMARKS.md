# Yatta Benchmarks

> Last run: `2026-11-10T17:11:14Z` · commit [`dabfd94`](https://github.com/psrockstar098/yatta.js/commit/dabfd941e7c92afc80336f5a002f4b275cd4e775) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 130.6 ms
  • End-to-End Runtime Task Cost    : 0.0429 ms/op
  • Peak RSS Memory        : 209.0 MB
  • RSS Heap Memory             : 77.20 MB
  • Raw Worker IPC Round-Trip      : 0.0288 ms/op
  • Scheduler + Graph Overhead     : 0.0141 ms/op
  • Settled Cooldown RSS   : 142.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      43,832 |     1.00x |    15% | 2.01ms | 3.63ms | 4.18ms |
| Raw Bun   |      43,047 |     0.98x |    14% | 2.19ms | 4.68ms | 4.80ms |
| Hono      |      44,092 |     1.01x |    15% | 1.85ms | 3.39ms | 4.16ms |
| Elysia    |      49,471 |     1.13x |    16% | 2.13ms | 4.70ms | 4.83ms |
| Express   |      15,614 |     0.36x |     2% | 5.99ms | 10.05ms | 11.11ms |
| Fastify   |      19,908 |     0.45x |    33% | 4.20ms | 8.18ms | 9.42ms |
| Koa       |      16,600 |     0.38x |     5% | 6.24ms | 9.87ms | 11.57ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,697 |       0.48 |       0.53 |       0.53 |       0.53 |
|         100 |     0.9 ms |              107,751 |       0.29 |       0.46 |       0.52 |       0.52 |
|         500 |     2.7 ms |              183,268 |       1.30 |       2.07 |       2.15 |       2.20 |
|        1000 |     5.0 ms |              201,812 |       2.51 |       3.65 |       3.74 |       3.77 |
|        5000 |    30.5 ms |              163,857 |      16.22 |      22.82 |      22.90 |      22.93 |
|       10000 |    54.4 ms |              183,798 |      27.34 |      43.29 |      44.21 |      44.30 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,286 |     4.46 |     5.95 |     6.95 |       7.06 |     7.06 |
|        5000 |   21.6 ms |            231,735 |    10.47 |    14.27 |    14.73 |      14.74 |    14.75 |
|       10000 |   49.5 ms |            202,165 |    26.38 |    38.87 |    40.02 |      40.04 |    40.04 |
|       25000 |  101.0 ms |            247,520 |    51.46 |    75.98 |    80.75 |      80.80 |    80.81 |
|       50000 |  187.9 ms |            266,124 |    93.21 |   147.17 |   157.43 |     158.00 |   158.04 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.9 ms |             77,622 |     6.22 |     9.78 |    11.56 |      11.88 |    11.88 |
|        5000 |   48.1 ms |            103,979 |    22.66 |    34.93 |    35.92 |      35.97 |    35.97 |
|       10000 |  104.6 ms |             95,590 |    52.01 |    87.00 |    89.42 |      89.97 |    89.97 |
|       25000 |  256.1 ms |             97,614 |   133.49 |   221.75 |   236.00 |     236.51 |   236.53 |
|       50000 |  488.8 ms |            102,297 |   268.00 |   418.80 |   446.43 |     447.44 |   447.51 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.0 ms |             38,420 |    13.73 |    22.37 |    24.50 |      24.83 |    24.83 |
|        5000 |  101.7 ms |             49,154 |    50.41 |    87.70 |    97.46 |      99.01 |    99.15 |
|       10000 |  207.3 ms |             48,237 |    98.16 |   178.08 |   196.70 |     200.17 |   200.62 |

## Full logs

<details>
<summary>Worker runtime deep profile (full log)</summary>

```

=======================================================
   🚀 YATTA WORKER RUNTIME — DEEP PROFILE & STRESS TEST
=======================================================

[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[1] Layer Overhead Decomposition (Micro-benchmarking 2,000 calls each):
  • Raw Worker IPC Round-Trip      : 0.0288 ms/op
  • End-to-End Runtime Task Cost    : 0.0429 ms/op
  • Scheduler + Graph Overhead     : 0.0141 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,697 |       0.48 |       0.53 |       0.53 |       0.53 |
|         100 |     0.9 ms |              107,751 |       0.29 |       0.46 |       0.52 |       0.52 |
|         500 |     2.7 ms |              183,268 |       1.30 |       2.07 |       2.15 |       2.20 |
|        1000 |     5.0 ms |              201,812 |       2.51 |       3.65 |       3.74 |       3.77 |
|        5000 |    30.5 ms |              163,857 |      16.22 |      22.82 |      22.90 |      22.93 |
|       10000 |    54.4 ms |              183,798 |      27.34 |      43.29 |      44.21 |      44.30 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.20 MB
  • V8/JSC Heap Used             : 0.78 MB

=======================================================
   ✅ BENCHMARK COMPLETE
=======================================================

```
</details>

<details>
<summary>Topology & tail tuning (full log)</summary>

```

=======================================================
   🧪 YATTA WORKER RUNTIME — TOPOLOGY & TAIL TUNING    
=======================================================

[1] Hardware Topology Matrix Sweep (10,000 tasks on 2 physical cores):
| Configuration | Threads | Duration  | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
|:--------------|:-------:|:---------:|:------------------:|:--------:|:--------:|:--------:|:--------:|
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 2
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   56.6 ms |            176,607 |    26.48 |    44.22 |    45.81 |    45.91 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   46.4 ms |            215,614 |    24.69 |    32.38 |    32.54 |    32.56 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   32.9 ms |            304,073 |    16.59 |    24.08 |    24.83 |    25.13 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.9 ms |            244,223 |    20.25 |    31.97 |    32.02 |    32.12 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 130.6 ms
  • Peak Throughput Rate       : 191,441 ops/sec
  • Latency Distribution       : p50: 62.32ms | p90: 107.92ms | p99: 109.62ms | p99.9: 109.71ms | Max: 109.80ms
  • Memory (RSS)               : Baseline: 101.4 MB | Peak: 127.9 MB | Cooldown: 83.9 MB

=======================================================
   ✅ TUNING BENCHMARK COMPLETE
=======================================================

```
</details>

<details>
<summary>Comprehensive workload benchmark (full log)</summary>

```

=========================================================================
   🚀 YATTA WORKER RUNTIME — MULTI-WORKLOAD & DEEP STRESS BENCHMARK     
=========================================================================

[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
📊 [WORKLOAD 1] Zero-Delay FastPing (IPC & Scheduler Baseline):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,286 |     4.46 |     5.95 |     6.95 |       7.06 |     7.06 |
|        5000 |   21.6 ms |            231,735 |    10.47 |    14.27 |    14.73 |      14.74 |    14.75 |
|       10000 |   49.5 ms |            202,165 |    26.38 |    38.87 |    40.02 |      40.04 |    40.04 |
|       25000 |  101.0 ms |            247,520 |    51.46 |    75.98 |    80.75 |      80.80 |    80.81 |
|       50000 |  187.9 ms |            266,124 |    93.21 |   147.17 |   157.43 |     158.00 |   158.04 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.9 ms |             77,622 |     6.22 |     9.78 |    11.56 |      11.88 |    11.88 |
|        5000 |   48.1 ms |            103,979 |    22.66 |    34.93 |    35.92 |      35.97 |    35.97 |
|       10000 |  104.6 ms |             95,590 |    52.01 |    87.00 |    89.42 |      89.97 |    89.97 |
|       25000 |  256.1 ms |             97,614 |   133.49 |   221.75 |   236.00 |     236.51 |   236.53 |
|       50000 |  488.8 ms |            102,297 |   268.00 |   418.80 |   446.43 |     447.44 |   447.51 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.0 ms |             38,420 |    13.73 |    22.37 |    24.50 |      24.83 |    24.83 |
|        5000 |  101.7 ms |             49,154 |    50.41 |    87.70 |    97.46 |      99.01 |    99.15 |
|       10000 |  207.3 ms |             48,237 |    98.16 |   178.08 |   196.70 |     200.17 |   200.62 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 209.0 MB
  • Settled Cooldown RSS   : 142.8 MB (Clean GC release)

=========================================================================
   ✅ COMPREHENSIVE WORKLOAD BENCHMARK COMPLETE
=========================================================================

```
</details>

<details>
<summary>Framework comparison (full log)</summary>

```

=======================================================
   YATTA vs EXPRESS vs FASTIFY vs HONO vs ELYSIA vs KOA
=======================================================

Route:  GET /json
Load:   20,000 requests, 100 concurrent, keep-alive
Method: one process per framework, 3 repetitions each, median reported

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      43,832 |     1.00x |    15% | 2.01ms | 3.63ms | 4.18ms |
| Raw Bun   |      43,047 |     0.98x |    14% | 2.19ms | 4.68ms | 4.80ms |
| Hono      |      44,092 |     1.01x |    15% | 1.85ms | 3.39ms | 4.16ms |
| Elysia    |      49,471 |     1.13x |    16% | 2.13ms | 4.70ms | 4.83ms |
| Express   |      15,614 |     0.36x |     2% | 5.99ms | 10.05ms | 11.11ms |
| Fastify   |      19,908 |     0.45x |    33% | 4.20ms | 8.18ms | 9.42ms |
| Koa       |      16,600 |     0.38x |     5% | 6.24ms | 9.87ms | 11.57ms |

  Yatta dispatch adds about -0.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
