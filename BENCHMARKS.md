# Yatta Benchmarks

> Last run: `2026-10-09T14:24:14Z` · commit [`0c1959d`](https://github.com/psrockstar098/yatta.js/commit/0c1959d421c215e9c6b2e6c2dff04ef82ada108d) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 64.8 ms
  • End-to-End Runtime Task Cost    : 0.0207 ms/op
  • Peak RSS Memory        : 216.7 MB
  • RSS Heap Memory             : 87.93 MB
  • Raw Worker IPC Round-Trip      : 0.0162 ms/op
  • Scheduler + Graph Overhead     : 0.0045 ms/op
  • Settled Cooldown RSS   : 73.5 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.39 MB
  • Worker Fleet Event Loop Lag : 10.09 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      65,894 |     1.00x |    10% | 1.25ms | 2.83ms | 3.80ms |
| Raw Bun   |      51,845 |     0.79x |     4% | 1.62ms | 3.40ms | 3.46ms |
| Hono      |      59,750 |     0.91x |     7% | 1.54ms | 3.19ms | 3.37ms |
| Elysia    |      55,136 |     0.84x |     9% | 1.46ms | 3.16ms | 3.31ms |
| Express   |      43,366 |     0.66x |     2% | 2.24ms | 3.57ms | 4.86ms |
| Fastify   |      56,636 |     0.86x |    14% | 1.75ms | 2.61ms | 4.04ms |
| Koa       |      47,332 |     0.72x |     6% | 1.80ms | 3.62ms | 5.23ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,485 |       0.20 |       0.21 |       0.21 |       0.21 |
|         100 |     0.5 ms |              220,801 |       0.15 |       0.27 |       0.28 |       0.28 |
|         500 |     1.1 ms |              446,399 |       0.52 |       0.66 |       0.70 |       0.71 |
|        1000 |     2.1 ms |              483,726 |       1.10 |       1.62 |       1.65 |       1.66 |
|        5000 |    13.5 ms |              370,540 |       7.71 |       9.23 |       9.67 |       9.70 |
|       10000 |    23.2 ms |              430,816 |      11.35 |      17.27 |      17.54 |      17.56 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.0 ms |            246,927 |     1.80 |     2.24 |     2.57 |       2.64 |     2.64 |
|        5000 |   11.7 ms |            427,197 |     5.78 |     7.90 |     8.23 |       8.24 |     8.24 |
|       10000 |   27.2 ms |            367,561 |    13.50 |    21.01 |    21.34 |      21.36 |    21.36 |
|       25000 |   56.9 ms |            439,549 |    26.85 |    40.14 |    45.11 |      45.66 |    45.67 |
|       50000 |  114.4 ms |            437,142 |    56.58 |    89.84 |    97.26 |      97.41 |    97.42 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.0 ms |            141,947 |     3.40 |     5.11 |     5.65 |       5.70 |     5.70 |
|        5000 |   25.5 ms |            195,704 |    12.65 |    19.41 |    20.02 |      20.04 |    20.04 |
|       10000 |   52.5 ms |            190,351 |    24.96 |    43.58 |    45.71 |      45.76 |    45.76 |
|       25000 |  147.2 ms |            169,889 |    76.37 |   126.91 |   134.13 |     134.60 |   134.62 |
|       50000 |  257.3 ms |            194,351 |   135.91 |   217.36 |   234.85 |     236.11 |   236.20 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.6 ms |             51,047 |    12.12 |    17.28 |    18.55 |      18.78 |    18.78 |
|        5000 |   72.0 ms |             69,401 |    36.62 |    60.67 |    69.50 |      70.59 |    70.67 |
|       10000 |  157.8 ms |             63,365 |    77.92 |   135.43 |   151.36 |     153.59 |   153.81 |

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[1] Layer Overhead Decomposition (Micro-benchmarking 2,000 calls each):
  • Raw Worker IPC Round-Trip      : 0.0162 ms/op
  • End-to-End Runtime Task Cost    : 0.0207 ms/op
  • Scheduler + Graph Overhead     : 0.0045 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,485 |       0.20 |       0.21 |       0.21 |       0.21 |
|         100 |     0.5 ms |              220,801 |       0.15 |       0.27 |       0.28 |       0.28 |
|         500 |     1.1 ms |              446,399 |       0.52 |       0.66 |       0.70 |       0.71 |
|        1000 |     2.1 ms |              483,726 |       1.10 |       1.62 |       1.65 |       1.66 |
|        5000 |    13.5 ms |              370,540 |       7.71 |       9.23 |       9.67 |       9.70 |
|       10000 |    23.2 ms |              430,816 |      11.35 |      17.27 |      17.54 |      17.56 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.09 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 87.93 MB
  • V8/JSC Heap Used             : 13.39 MB

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   30.2 ms |            330,753 |    15.22 |    23.18 |    23.61 |    23.63 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   30.6 ms |            327,164 |    14.90 |    21.00 |    21.73 |    21.75 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.2 ms |            397,538 |    10.69 |    20.14 |    20.60 |    20.91 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   22.0 ms |            454,543 |    10.50 |    17.03 |    17.17 |    17.20 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 64.8 ms
  • Peak Throughput Rate       : 386,016 ops/sec
  • Latency Distribution       : p50: 29.01ms | p90: 48.15ms | p99: 49.28ms | p99.9: 49.37ms | Max: 49.39ms
  • Memory (RSS)               : Baseline: 105.0 MB | Peak: 124.0 MB | Cooldown: 61.0 MB

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
📊 [WORKLOAD 1] Zero-Delay FastPing (IPC & Scheduler Baseline):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.0 ms |            246,927 |     1.80 |     2.24 |     2.57 |       2.64 |     2.64 |
|        5000 |   11.7 ms |            427,197 |     5.78 |     7.90 |     8.23 |       8.24 |     8.24 |
|       10000 |   27.2 ms |            367,561 |    13.50 |    21.01 |    21.34 |      21.36 |    21.36 |
|       25000 |   56.9 ms |            439,549 |    26.85 |    40.14 |    45.11 |      45.66 |    45.67 |
|       50000 |  114.4 ms |            437,142 |    56.58 |    89.84 |    97.26 |      97.41 |    97.42 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.0 ms |            141,947 |     3.40 |     5.11 |     5.65 |       5.70 |     5.70 |
|        5000 |   25.5 ms |            195,704 |    12.65 |    19.41 |    20.02 |      20.04 |    20.04 |
|       10000 |   52.5 ms |            190,351 |    24.96 |    43.58 |    45.71 |      45.76 |    45.76 |
|       25000 |  147.2 ms |            169,889 |    76.37 |   126.91 |   134.13 |     134.60 |   134.62 |
|       50000 |  257.3 ms |            194,351 |   135.91 |   217.36 |   234.85 |     236.11 |   236.20 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.6 ms |             51,047 |    12.12 |    17.28 |    18.55 |      18.78 |    18.78 |
|        5000 |   72.0 ms |             69,401 |    36.62 |    60.67 |    69.50 |      70.59 |    70.67 |
|       10000 |  157.8 ms |             63,365 |    77.92 |   135.43 |   151.36 |     153.59 |   153.81 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 216.7 MB
  • Settled Cooldown RSS   : 73.5 MB (Clean GC release)

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
| Yatta     |      65,894 |     1.00x |    10% | 1.25ms | 2.83ms | 3.80ms |
| Raw Bun   |      51,845 |     0.79x |     4% | 1.62ms | 3.40ms | 3.46ms |
| Hono      |      59,750 |     0.91x |     7% | 1.54ms | 3.19ms | 3.37ms |
| Elysia    |      55,136 |     0.84x |     9% | 1.46ms | 3.16ms | 3.31ms |
| Express   |      43,366 |     0.66x |     2% | 2.24ms | 3.57ms | 4.86ms |
| Fastify   |      56,636 |     0.86x |    14% | 1.75ms | 2.61ms | 4.04ms |
| Koa       |      47,332 |     0.72x |     6% | 1.80ms | 3.62ms | 5.23ms |

  Yatta dispatch adds about -4.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
