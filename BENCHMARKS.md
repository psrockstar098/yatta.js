# Yatta Benchmarks

> Last run: `2026-10-18T01:39:23Z` · commit [`95b971d`](https://github.com/psrockstar098/yatta.js/commit/95b971daef51dc09ec1201eb5df0383c908afbdd) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 74.7 ms
  • End-to-End Runtime Task Cost    : 0.0226 ms/op
  • Peak RSS Memory        : 150.4 MB
  • RSS Heap Memory             : 96.05 MB
  • Raw Worker IPC Round-Trip      : 0.0165 ms/op
  • Scheduler + Graph Overhead     : 0.0061 ms/op
  • Settled Cooldown RSS   : 78.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.57 MB
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      68,275 |     1.00x |     6% | 1.35ms | 2.32ms | 3.02ms |
| Raw Bun   |      53,141 |     0.78x |     4% | 1.60ms | 3.31ms | 3.38ms |
| Hono      |      72,258 |     1.06x |    10% | 1.20ms | 3.36ms | 3.44ms |
| Elysia    |      58,536 |     0.86x |     5% | 1.50ms | 3.33ms | 3.49ms |
| Express   |      41,674 |     0.61x |     6% | 2.15ms | 4.06ms | 5.16ms |
| Fastify   |      53,009 |     0.78x |     3% | 1.72ms | 3.21ms | 4.80ms |
| Koa       |      45,656 |     0.67x |     5% | 2.20ms | 3.90ms | 5.30ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,255 |       0.24 |       0.27 |       0.27 |       0.27 |
|         100 |     0.3 ms |              289,892 |       0.16 |       0.21 |       0.23 |       0.23 |
|         500 |     1.2 ms |              425,943 |       0.58 |       0.88 |       0.93 |       0.95 |
|        1000 |     1.9 ms |              519,805 |       0.97 |       1.38 |       1.42 |       1.43 |
|        5000 |    12.5 ms |              399,120 |       6.88 |       8.44 |       8.56 |       8.58 |
|       10000 |    26.5 ms |              378,009 |      13.30 |      20.85 |      20.99 |      21.02 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.1 ms |            163,674 |     2.86 |     4.29 |     5.14 |       5.22 |     5.22 |
|        5000 |   14.3 ms |            350,798 |     7.39 |     8.94 |     9.26 |       9.28 |     9.29 |
|       10000 |   39.6 ms |            252,606 |    19.48 |    29.94 |    31.01 |      31.02 |    31.02 |
|       25000 |   70.3 ms |            355,838 |    33.30 |    51.92 |    54.74 |      54.76 |    54.76 |
|       50000 |  115.7 ms |            432,218 |    57.90 |    89.73 |    97.30 |      97.64 |    97.65 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.9 ms |            145,938 |     3.43 |     5.18 |     5.81 |       5.87 |     5.87 |
|        5000 |   22.6 ms |            220,816 |    11.15 |    17.49 |    18.12 |      18.15 |    18.16 |
|       10000 |   48.4 ms |            206,688 |    22.24 |    41.55 |    42.90 |      42.96 |    42.96 |
|       25000 |  163.2 ms |            153,191 |    84.18 |   139.04 |   148.44 |     148.92 |   148.94 |
|       50000 |  331.0 ms |            151,059 |   159.05 |   278.34 |   309.08 |     309.45 |   309.50 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.2 ms |             52,012 |    11.77 |    16.99 |    17.92 |      18.11 |    18.11 |
|        5000 |   69.9 ms |             71,490 |    35.87 |    62.02 |    67.92 |      68.52 |    68.61 |
|       10000 |  156.0 ms |             64,110 |    75.66 |   136.13 |   150.30 |     152.64 |   152.88 |

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
  • Raw Worker IPC Round-Trip      : 0.0165 ms/op
  • End-to-End Runtime Task Cost    : 0.0226 ms/op
  • Scheduler + Graph Overhead     : 0.0061 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,255 |       0.24 |       0.27 |       0.27 |       0.27 |
|         100 |     0.3 ms |              289,892 |       0.16 |       0.21 |       0.23 |       0.23 |
|         500 |     1.2 ms |              425,943 |       0.58 |       0.88 |       0.93 |       0.95 |
|        1000 |     1.9 ms |              519,805 |       0.97 |       1.38 |       1.42 |       1.43 |
|        5000 |    12.5 ms |              399,120 |       6.88 |       8.44 |       8.56 |       8.58 |
|       10000 |    26.5 ms |              378,009 |      13.30 |      20.85 |      20.99 |      21.02 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.05 MB
  • V8/JSC Heap Used             : 13.57 MB

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
| 1 CPU + 1 IO  |       2 |   38.0 ms |            262,905 |    19.43 |    27.51 |    28.95 |    29.01 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   35.7 ms |            280,220 |    17.20 |    26.15 |    26.99 |    27.27 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   29.2 ms |            342,997 |    14.18 |    23.48 |    23.87 |    24.11 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   26.0 ms |            384,875 |    12.33 |    19.11 |    19.44 |    19.50 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 74.7 ms
  • Peak Throughput Rate       : 334,864 ops/sec
  • Latency Distribution       : p50: 36.30ms | p90: 53.04ms | p99: 54.03ms | p99.9: 54.09ms | Max: 54.09ms
  • Memory (RSS)               : Baseline: 104.7 MB | Peak: 128.8 MB | Cooldown: 84.2 MB

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
|        1000 |    6.1 ms |            163,674 |     2.86 |     4.29 |     5.14 |       5.22 |     5.22 |
|        5000 |   14.3 ms |            350,798 |     7.39 |     8.94 |     9.26 |       9.28 |     9.29 |
|       10000 |   39.6 ms |            252,606 |    19.48 |    29.94 |    31.01 |      31.02 |    31.02 |
|       25000 |   70.3 ms |            355,838 |    33.30 |    51.92 |    54.74 |      54.76 |    54.76 |
|       50000 |  115.7 ms |            432,218 |    57.90 |    89.73 |    97.30 |      97.64 |    97.65 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.9 ms |            145,938 |     3.43 |     5.18 |     5.81 |       5.87 |     5.87 |
|        5000 |   22.6 ms |            220,816 |    11.15 |    17.49 |    18.12 |      18.15 |    18.16 |
|       10000 |   48.4 ms |            206,688 |    22.24 |    41.55 |    42.90 |      42.96 |    42.96 |
|       25000 |  163.2 ms |            153,191 |    84.18 |   139.04 |   148.44 |     148.92 |   148.94 |
|       50000 |  331.0 ms |            151,059 |   159.05 |   278.34 |   309.08 |     309.45 |   309.50 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.2 ms |             52,012 |    11.77 |    16.99 |    17.92 |      18.11 |    18.11 |
|        5000 |   69.9 ms |             71,490 |    35.87 |    62.02 |    67.92 |      68.52 |    68.61 |
|       10000 |  156.0 ms |             64,110 |    75.66 |   136.13 |   150.30 |     152.64 |   152.88 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 150.4 MB
  • Settled Cooldown RSS   : 78.7 MB (Clean GC release)

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
| Yatta     |      68,275 |     1.00x |     6% | 1.35ms | 2.32ms | 3.02ms |
| Raw Bun   |      53,141 |     0.78x |     4% | 1.60ms | 3.31ms | 3.38ms |
| Hono      |      72,258 |     1.06x |    10% | 1.20ms | 3.36ms | 3.44ms |
| Elysia    |      58,536 |     0.86x |     5% | 1.50ms | 3.33ms | 3.49ms |
| Express   |      41,674 |     0.61x |     6% | 2.15ms | 4.06ms | 5.16ms |
| Fastify   |      53,009 |     0.78x |     3% | 1.72ms | 3.21ms | 4.80ms |
| Koa       |      45,656 |     0.67x |     5% | 2.20ms | 3.90ms | 5.30ms |

  Yatta dispatch adds about -4.2µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
