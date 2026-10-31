# Yatta Benchmarks

> Last run: `2026-10-31T12:03:44Z` · commit [`126858d`](https://github.com/psrockstar098/yatta.js/commit/126858d1a084a382f583ab166629a43b9f1849e7) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 79.4 ms
  • End-to-End Runtime Task Cost    : 0.0303 ms/op
  • Peak RSS Memory        : 215.8 MB
  • RSS Heap Memory             : 92.71 MB
  • Raw Worker IPC Round-Trip      : 0.0283 ms/op
  • Scheduler + Graph Overhead     : 0.0020 ms/op
  • Settled Cooldown RSS   : 73.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.68 MB
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
| Yatta     |      65,561 |     1.00x |    15% | 1.53ms | 2.48ms | 3.45ms |
| Raw Bun   |      45,073 |     0.69x |    15% | 1.87ms | 3.84ms | 4.35ms |
| Hono      |      57,406 |     0.88x |    32% | 1.62ms | 2.59ms | 3.35ms |
| Elysia    |      49,062 |     0.75x |     4% | 1.67ms | 3.37ms | 3.94ms |
| Express   |      27,260 |     0.42x |     9% | 3.08ms | 6.23ms | 7.06ms |
| Fastify   |      38,069 |     0.58x |     8% | 2.76ms | 4.62ms | 6.04ms |
| Koa       |      28,280 |     0.43x |     3% | 3.44ms | 5.81ms | 6.90ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,799 |       0.32 |       0.34 |       0.34 |       0.34 |
|         100 |     0.8 ms |              124,447 |       0.56 |       0.69 |       0.72 |       0.72 |
|         500 |     2.8 ms |              177,265 |       1.00 |       1.72 |       1.78 |       1.79 |
|        1000 |     4.3 ms |              233,917 |       1.82 |       2.46 |       2.50 |       2.51 |
|        5000 |    22.4 ms |              222,873 |      11.96 |      15.07 |      15.19 |      15.24 |
|       10000 |    50.3 ms |              198,770 |      26.98 |      41.55 |      41.93 |      41.95 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.2 ms |            160,608 |     2.54 |     3.58 |     4.74 |       4.82 |     4.82 |
|        5000 |   18.1 ms |            276,027 |     9.54 |    12.33 |    12.73 |      12.76 |    12.76 |
|       10000 |   36.3 ms |            275,551 |    17.74 |    27.56 |    28.71 |      28.75 |    28.75 |
|       25000 |   83.2 ms |            300,513 |    41.12 |    61.20 |    62.92 |      62.98 |    62.99 |
|       50000 |  175.2 ms |            285,459 |    88.99 |   136.88 |   146.31 |     146.74 |   146.75 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.8 ms |            113,416 |     4.31 |     6.77 |     7.77 |       7.90 |     7.90 |
|        5000 |   35.2 ms |            142,010 |    16.62 |    27.32 |    28.12 |      28.16 |    28.16 |
|       10000 |   81.9 ms |            122,172 |    40.11 |    65.02 |    69.88 |      69.90 |    69.90 |
|       25000 |  212.7 ms |            117,555 |   100.94 |   185.44 |   196.94 |     197.50 |   197.51 |
|       50000 |  430.6 ms |            116,104 |   220.55 |   354.16 |   385.11 |     386.07 |   386.12 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.4 ms |             51,627 |     9.69 |    16.55 |    18.50 |      18.67 |    18.67 |
|        5000 |   91.9 ms |             54,435 |    38.46 |    75.50 |    88.56 |      89.89 |    90.00 |
|       10000 |  149.8 ms |             66,756 |    70.94 |   126.44 |   143.80 |     146.11 |   146.32 |

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
  • Raw Worker IPC Round-Trip      : 0.0283 ms/op
  • End-to-End Runtime Task Cost    : 0.0303 ms/op
  • Scheduler + Graph Overhead     : 0.0020 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,799 |       0.32 |       0.34 |       0.34 |       0.34 |
|         100 |     0.8 ms |              124,447 |       0.56 |       0.69 |       0.72 |       0.72 |
|         500 |     2.8 ms |              177,265 |       1.00 |       1.72 |       1.78 |       1.79 |
|        1000 |     4.3 ms |              233,917 |       1.82 |       2.46 |       2.50 |       2.51 |
|        5000 |    22.4 ms |              222,873 |      11.96 |      15.07 |      15.19 |      15.24 |
|       10000 |    50.3 ms |              198,770 |      26.98 |      41.55 |      41.93 |      41.95 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 92.71 MB
  • V8/JSC Heap Used             : 13.68 MB

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
| 1 CPU + 1 IO  |       2 |   40.6 ms |            246,359 |    20.10 |    30.88 |    31.61 |    31.71 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   32.3 ms |            309,736 |    17.76 |    25.21 |    25.35 |    25.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   30.3 ms |            329,936 |    13.77 |    23.62 |    25.52 |    25.64 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   32.8 ms |            305,142 |    18.58 |    26.94 |    27.27 |    27.33 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 79.4 ms
  • Peak Throughput Rate       : 314,780 ops/sec
  • Latency Distribution       : p50: 41.26ms | p90: 61.53ms | p99: 63.71ms | p99.9: 63.87ms | Max: 63.88ms
  • Memory (RSS)               : Baseline: 104.1 MB | Peak: 132.3 MB | Cooldown: 102.9 MB

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
|        1000 |    6.2 ms |            160,608 |     2.54 |     3.58 |     4.74 |       4.82 |     4.82 |
|        5000 |   18.1 ms |            276,027 |     9.54 |    12.33 |    12.73 |      12.76 |    12.76 |
|       10000 |   36.3 ms |            275,551 |    17.74 |    27.56 |    28.71 |      28.75 |    28.75 |
|       25000 |   83.2 ms |            300,513 |    41.12 |    61.20 |    62.92 |      62.98 |    62.99 |
|       50000 |  175.2 ms |            285,459 |    88.99 |   136.88 |   146.31 |     146.74 |   146.75 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.8 ms |            113,416 |     4.31 |     6.77 |     7.77 |       7.90 |     7.90 |
|        5000 |   35.2 ms |            142,010 |    16.62 |    27.32 |    28.12 |      28.16 |    28.16 |
|       10000 |   81.9 ms |            122,172 |    40.11 |    65.02 |    69.88 |      69.90 |    69.90 |
|       25000 |  212.7 ms |            117,555 |   100.94 |   185.44 |   196.94 |     197.50 |   197.51 |
|       50000 |  430.6 ms |            116,104 |   220.55 |   354.16 |   385.11 |     386.07 |   386.12 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.4 ms |             51,627 |     9.69 |    16.55 |    18.50 |      18.67 |    18.67 |
|        5000 |   91.9 ms |             54,435 |    38.46 |    75.50 |    88.56 |      89.89 |    90.00 |
|       10000 |  149.8 ms |             66,756 |    70.94 |   126.44 |   143.80 |     146.11 |   146.32 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 215.8 MB
  • Settled Cooldown RSS   : 73.6 MB (Clean GC release)

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
| Yatta     |      65,561 |     1.00x |    15% | 1.53ms | 2.48ms | 3.45ms |
| Raw Bun   |      45,073 |     0.69x |    15% | 1.87ms | 3.84ms | 4.35ms |
| Hono      |      57,406 |     0.88x |    32% | 1.62ms | 2.59ms | 3.35ms |
| Elysia    |      49,062 |     0.75x |     4% | 1.67ms | 3.37ms | 3.94ms |
| Express   |      27,260 |     0.42x |     9% | 3.08ms | 6.23ms | 7.06ms |
| Fastify   |      38,069 |     0.58x |     8% | 2.76ms | 4.62ms | 6.04ms |
| Koa       |      28,280 |     0.43x |     3% | 3.44ms | 5.81ms | 6.90ms |

  Yatta dispatch adds about -6.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 15%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
