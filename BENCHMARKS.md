# Yatta Benchmarks

> Last run: `2026-11-05T04:18:47Z` · commit [`c583c34`](https://github.com/psrockstar098/yatta.js/commit/c583c34a893a0d8e154d86fac826fb70719d8e6b) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 81.0 ms
  • End-to-End Runtime Task Cost    : 0.0293 ms/op
  • Peak RSS Memory        : 164.6 MB
  • RSS Heap Memory             : 83.06 MB
  • Raw Worker IPC Round-Trip      : 0.0233 ms/op
  • Scheduler + Graph Overhead     : 0.0060 ms/op
  • Settled Cooldown RSS   : 72.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.64 MB
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
| Yatta     |      61,585 |     1.00x |     7% | 1.59ms | 2.86ms | 3.78ms |
| Raw Bun   |      47,748 |     0.78x |     2% | 1.83ms | 3.81ms | 4.02ms |
| Hono      |      56,518 |     0.92x |    15% | 1.54ms | 3.31ms | 3.91ms |
| Elysia    |      51,106 |     0.83x |    18% | 1.55ms | 3.28ms | 3.77ms |
| Express   |      25,341 |     0.41x |     6% | 3.69ms | 6.04ms | 6.98ms |
| Fastify   |      35,754 |     0.58x |    13% | 2.79ms | 5.04ms | 5.70ms |
| Koa       |      29,375 |     0.48x |    15% | 2.91ms | 6.22ms | 7.17ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,548 |       0.29 |       0.32 |       0.32 |       0.32 |
|         100 |     0.7 ms |              149,650 |       0.24 |       0.36 |       0.37 |       0.37 |
|         500 |     1.6 ms |              313,881 |       0.79 |       1.20 |       1.29 |       1.31 |
|        1000 |     3.0 ms |              338,404 |       1.52 |       2.31 |       2.43 |       2.45 |
|        5000 |    19.2 ms |              260,859 |      10.34 |      13.67 |      14.16 |      14.20 |
|       10000 |    38.6 ms |              259,294 |      19.39 |      30.68 |      31.41 |      31.49 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.0 ms |            166,471 |     2.69 |     3.81 |     4.51 |       4.62 |     4.62 |
|        5000 |   17.0 ms |            293,967 |     8.56 |    11.08 |    11.52 |      11.53 |    11.53 |
|       10000 |   36.2 ms |            275,953 |    17.99 |    27.84 |    28.48 |      28.49 |    28.49 |
|       25000 |   84.5 ms |            295,941 |    41.44 |    64.43 |    67.39 |      67.73 |    67.75 |
|       50000 |  164.3 ms |            304,273 |    83.43 |   130.45 |   135.41 |     136.33 |   137.89 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,135 |     3.93 |     6.47 |     7.56 |       7.68 |     7.68 |
|        5000 |   32.8 ms |            152,448 |    15.62 |    24.40 |    25.35 |      25.41 |    25.41 |
|       10000 |   79.4 ms |            125,895 |    43.43 |    67.02 |    69.65 |      69.77 |    69.78 |
|       25000 |  190.1 ms |            131,501 |   101.44 |   163.93 |   172.35 |     172.97 |   172.99 |
|       50000 |  395.9 ms |            126,287 |   202.83 |   337.69 |   359.94 |     360.80 |   360.86 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.7 ms |             59,758 |     9.44 |    14.58 |    15.92 |      16.15 |    16.15 |
|        5000 |   69.5 ms |             71,941 |    34.96 |    59.37 |    65.31 |      66.49 |    66.59 |
|       10000 |  152.6 ms |             65,543 |    65.79 |   130.50 |   144.57 |     146.91 |   147.14 |

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
  • Raw Worker IPC Round-Trip      : 0.0233 ms/op
  • End-to-End Runtime Task Cost    : 0.0293 ms/op
  • Scheduler + Graph Overhead     : 0.0060 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,548 |       0.29 |       0.32 |       0.32 |       0.32 |
|         100 |     0.7 ms |              149,650 |       0.24 |       0.36 |       0.37 |       0.37 |
|         500 |     1.6 ms |              313,881 |       0.79 |       1.20 |       1.29 |       1.31 |
|        1000 |     3.0 ms |              338,404 |       1.52 |       2.31 |       2.43 |       2.45 |
|        5000 |    19.2 ms |              260,859 |      10.34 |      13.67 |      14.16 |      14.20 |
|       10000 |    38.6 ms |              259,294 |      19.39 |      30.68 |      31.41 |      31.49 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 83.06 MB
  • V8/JSC Heap Used             : 13.64 MB

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
| 1 CPU + 1 IO  |       2 |   38.1 ms |            262,560 |    18.31 |    25.46 |    27.83 |    28.08 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   36.3 ms |            275,369 |    19.22 |    28.92 |    29.08 |    29.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   29.5 ms |            338,959 |    12.51 |    22.87 |    23.67 |    24.06 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   29.2 ms |            342,988 |    14.43 |    23.45 |    23.64 |    23.66 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 81.0 ms
  • Peak Throughput Rate       : 308,580 ops/sec
  • Latency Distribution       : p50: 40.69ms | p90: 61.07ms | p99: 62.10ms | p99.9: 62.18ms | Max: 62.19ms
  • Memory (RSS)               : Baseline: 102.0 MB | Peak: 132.5 MB | Cooldown: 103.5 MB

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
|        1000 |    6.0 ms |            166,471 |     2.69 |     3.81 |     4.51 |       4.62 |     4.62 |
|        5000 |   17.0 ms |            293,967 |     8.56 |    11.08 |    11.52 |      11.53 |    11.53 |
|       10000 |   36.2 ms |            275,953 |    17.99 |    27.84 |    28.48 |      28.49 |    28.49 |
|       25000 |   84.5 ms |            295,941 |    41.44 |    64.43 |    67.39 |      67.73 |    67.75 |
|       50000 |  164.3 ms |            304,273 |    83.43 |   130.45 |   135.41 |     136.33 |   137.89 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,135 |     3.93 |     6.47 |     7.56 |       7.68 |     7.68 |
|        5000 |   32.8 ms |            152,448 |    15.62 |    24.40 |    25.35 |      25.41 |    25.41 |
|       10000 |   79.4 ms |            125,895 |    43.43 |    67.02 |    69.65 |      69.77 |    69.78 |
|       25000 |  190.1 ms |            131,501 |   101.44 |   163.93 |   172.35 |     172.97 |   172.99 |
|       50000 |  395.9 ms |            126,287 |   202.83 |   337.69 |   359.94 |     360.80 |   360.86 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.7 ms |             59,758 |     9.44 |    14.58 |    15.92 |      16.15 |    16.15 |
|        5000 |   69.5 ms |             71,941 |    34.96 |    59.37 |    65.31 |      66.49 |    66.59 |
|       10000 |  152.6 ms |             65,543 |    65.79 |   130.50 |   144.57 |     146.91 |   147.14 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 164.6 MB
  • Settled Cooldown RSS   : 72.3 MB (Clean GC release)

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
| Yatta     |      61,585 |     1.00x |     7% | 1.59ms | 2.86ms | 3.78ms |
| Raw Bun   |      47,748 |     0.78x |     2% | 1.83ms | 3.81ms | 4.02ms |
| Hono      |      56,518 |     0.92x |    15% | 1.54ms | 3.31ms | 3.91ms |
| Elysia    |      51,106 |     0.83x |    18% | 1.55ms | 3.28ms | 3.77ms |
| Express   |      25,341 |     0.41x |     6% | 3.69ms | 6.04ms | 6.98ms |
| Fastify   |      35,754 |     0.58x |    13% | 2.79ms | 5.04ms | 5.70ms |
| Koa       |      29,375 |     0.48x |    15% | 2.91ms | 6.22ms | 7.17ms |

  Yatta dispatch adds about -4.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
