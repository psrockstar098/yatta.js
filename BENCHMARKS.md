# Yatta Benchmarks

> Last run: `2026-11-05T03:48:35Z` · commit [`9c84113`](https://github.com/psrockstar098/yatta.js/commit/9c841135ef01bc9eff699625d0ced4c4d6bf4f2c) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 74.2 ms
  • End-to-End Runtime Task Cost    : 0.0153 ms/op
  • Peak RSS Memory        : 212.9 MB
  • RSS Heap Memory             : 96.68 MB
  • Raw Worker IPC Round-Trip      : 0.0092 ms/op
  • Scheduler + Graph Overhead     : 0.0061 ms/op
  • Settled Cooldown RSS   : 84.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.63 MB
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      98,886 |     1.00x |     3% | 1.11ms | 1.61ms | 2.30ms |
| Raw Bun   |     111,886 |     1.13x |    14% | 0.92ms | 1.12ms | 1.53ms |
| Hono      |     102,599 |     1.04x |     7% | 1.05ms | 1.52ms | 1.89ms |
| Elysia    |     118,957 |     1.20x |     7% | 0.94ms | 1.53ms | 1.93ms |
| Express   |      43,938 |     0.44x |     5% | 2.12ms | 3.99ms | 5.45ms |
| Fastify   |      54,144 |     0.55x |     4% | 1.75ms | 3.50ms | 4.47ms |
| Koa       |      47,909 |     0.48x |     6% | 1.93ms | 3.83ms | 4.72ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               21,875 |       0.24 |       0.24 |       0.24 |       0.24 |
|         100 |     0.4 ms |              239,844 |       0.21 |       0.29 |       0.30 |       0.30 |
|         500 |     1.3 ms |              393,554 |       0.62 |       0.94 |       0.98 |       1.01 |
|        1000 |     2.5 ms |              395,212 |       1.19 |       1.68 |       1.71 |       1.72 |
|        5000 |    16.2 ms |              309,207 |       8.74 |      11.41 |      11.45 |      11.47 |
|       10000 |    27.1 ms |              369,077 |      13.87 |      21.00 |      21.28 |      21.38 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.1 ms |            162,745 |     2.64 |     3.17 |     3.36 |       3.43 |     3.43 |
|        5000 |   16.9 ms |            295,618 |     9.42 |    12.15 |    12.24 |      12.27 |    12.27 |
|       10000 |   41.1 ms |            243,156 |    21.67 |    31.54 |    33.84 |      33.86 |    33.87 |
|       25000 |   74.2 ms |            337,079 |    33.98 |    51.67 |    55.73 |      55.97 |    55.99 |
|       50000 |  118.1 ms |            423,381 |    58.56 |    90.60 |    94.59 |      94.91 |    94.93 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.3 ms |            107,619 |     4.60 |     6.89 |     7.80 |       8.08 |     8.08 |
|        5000 |   39.5 ms |            126,426 |    21.69 |    30.71 |    31.51 |      31.54 |    31.54 |
|       10000 |   75.3 ms |            132,774 |    36.46 |    60.16 |    62.47 |      62.62 |    62.63 |
|       25000 |  181.6 ms |            137,663 |    90.65 |   153.01 |   162.78 |     163.27 |   163.29 |
|       50000 |  351.0 ms |            142,449 |   164.15 |   293.00 |   321.91 |     324.57 |   324.64 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.8 ms |             84,544 |     6.75 |    10.26 |    10.93 |      11.06 |    11.06 |
|        5000 |   43.9 ms |            113,970 |    22.74 |    38.24 |    41.69 |      42.36 |    42.43 |
|       10000 |   94.3 ms |            106,058 |    48.83 |    80.95 |    90.09 |      91.11 |    91.20 |

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
  • Raw Worker IPC Round-Trip      : 0.0092 ms/op
  • End-to-End Runtime Task Cost    : 0.0153 ms/op
  • Scheduler + Graph Overhead     : 0.0061 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               21,875 |       0.24 |       0.24 |       0.24 |       0.24 |
|         100 |     0.4 ms |              239,844 |       0.21 |       0.29 |       0.30 |       0.30 |
|         500 |     1.3 ms |              393,554 |       0.62 |       0.94 |       0.98 |       1.01 |
|        1000 |     2.5 ms |              395,212 |       1.19 |       1.68 |       1.71 |       1.72 |
|        5000 |    16.2 ms |              309,207 |       8.74 |      11.41 |      11.45 |      11.47 |
|       10000 |    27.1 ms |              369,077 |      13.87 |      21.00 |      21.28 |      21.38 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.68 MB
  • V8/JSC Heap Used             : 13.63 MB

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
| 1 CPU + 1 IO  |       2 |   42.7 ms |            234,462 |    19.94 |    32.83 |    34.32 |    34.34 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   33.1 ms |            302,182 |    18.29 |    24.40 |    24.91 |    25.02 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   28.6 ms |            349,615 |    14.28 |    21.12 |    21.76 |    22.04 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   26.9 ms |            371,233 |    12.61 |    20.50 |    21.31 |    21.50 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 74.2 ms
  • Peak Throughput Rate       : 336,740 ops/sec
  • Latency Distribution       : p50: 33.84ms | p90: 57.11ms | p99: 57.91ms | p99.9: 58.24ms | Max: 58.28ms
  • Memory (RSS)               : Baseline: 107.4 MB | Peak: 135.0 MB | Cooldown: 106.9 MB

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
|        1000 |    6.1 ms |            162,745 |     2.64 |     3.17 |     3.36 |       3.43 |     3.43 |
|        5000 |   16.9 ms |            295,618 |     9.42 |    12.15 |    12.24 |      12.27 |    12.27 |
|       10000 |   41.1 ms |            243,156 |    21.67 |    31.54 |    33.84 |      33.86 |    33.87 |
|       25000 |   74.2 ms |            337,079 |    33.98 |    51.67 |    55.73 |      55.97 |    55.99 |
|       50000 |  118.1 ms |            423,381 |    58.56 |    90.60 |    94.59 |      94.91 |    94.93 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.3 ms |            107,619 |     4.60 |     6.89 |     7.80 |       8.08 |     8.08 |
|        5000 |   39.5 ms |            126,426 |    21.69 |    30.71 |    31.51 |      31.54 |    31.54 |
|       10000 |   75.3 ms |            132,774 |    36.46 |    60.16 |    62.47 |      62.62 |    62.63 |
|       25000 |  181.6 ms |            137,663 |    90.65 |   153.01 |   162.78 |     163.27 |   163.29 |
|       50000 |  351.0 ms |            142,449 |   164.15 |   293.00 |   321.91 |     324.57 |   324.64 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.8 ms |             84,544 |     6.75 |    10.26 |    10.93 |      11.06 |    11.06 |
|        5000 |   43.9 ms |            113,970 |    22.74 |    38.24 |    41.69 |      42.36 |    42.43 |
|       10000 |   94.3 ms |            106,058 |    48.83 |    80.95 |    90.09 |      91.11 |    91.20 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 212.9 MB
  • Settled Cooldown RSS   : 84.1 MB (Clean GC release)

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
| Yatta     |      98,886 |     1.00x |     3% | 1.11ms | 1.61ms | 2.30ms |
| Raw Bun   |     111,886 |     1.13x |    14% | 0.92ms | 1.12ms | 1.53ms |
| Hono      |     102,599 |     1.04x |     7% | 1.05ms | 1.52ms | 1.89ms |
| Elysia    |     118,957 |     1.20x |     7% | 0.94ms | 1.53ms | 1.93ms |
| Express   |      43,938 |     0.44x |     5% | 2.12ms | 3.99ms | 5.45ms |
| Fastify   |      54,144 |     0.55x |     4% | 1.75ms | 3.50ms | 4.47ms |
| Koa       |      47,909 |     0.48x |     6% | 1.93ms | 3.83ms | 4.72ms |

  Yatta dispatch adds about 1.2µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
