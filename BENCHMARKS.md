# Yatta Benchmarks

> Last run: `2026-10-07T00:27:01Z` · commit [`c8e0862`](https://github.com/psrockstar098/yatta.js/commit/c8e08622a5d4076895325f165031c6fd648767eb) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 81.9 ms
  • End-to-End Runtime Task Cost    : 0.0287 ms/op
  • Peak RSS Memory        : 194.9 MB
  • RSS Heap Memory             : 93.21 MB
  • Raw Worker IPC Round-Trip      : 0.0211 ms/op
  • Scheduler + Graph Overhead     : 0.0076 ms/op
  • Settled Cooldown RSS   : 79.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.67 MB
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      56,177 | 1.00x |      1.78ms | 1.76ms | 2.80ms | 3.59ms |
| Express   |      25,677 | 0.46x |      3.89ms | 3.29ms | 6.90ms | 8.15ms |
| Fastify   |      32,740 | 0.58x |      3.05ms | 2.93ms | 4.75ms | 6.05ms |
| Hono      |      56,311 | 1.00x |      1.77ms | 1.79ms | 2.97ms | 4.15ms |
| Elysia    |      48,558 | 0.86x |      2.06ms | 2.01ms | 3.99ms | 4.77ms |
| Koa       |      24,803 | 0.44x |      4.03ms | 3.97ms | 6.68ms | 8.85ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,826 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.7 ms |              140,019 |       0.22 |       0.42 |       0.44 |       0.44 |
|         500 |     1.5 ms |              341,077 |       0.74 |       1.13 |       1.21 |       1.23 |
|        1000 |     2.7 ms |              375,059 |       1.27 |       2.06 |       2.14 |       2.18 |
|        5000 |    16.5 ms |              303,291 |       8.93 |      11.50 |      11.60 |      11.65 |
|       10000 |    31.2 ms |              320,223 |      15.99 |      24.05 |      24.37 |      24.54 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.5 ms |            154,413 |     2.91 |     4.22 |     5.34 |       5.58 |     5.58 |
|        5000 |   17.6 ms |            283,442 |     8.50 |    11.75 |    11.82 |      11.83 |    11.83 |
|       10000 |   38.1 ms |            262,298 |    18.17 |    28.25 |    30.14 |      30.17 |    30.18 |
|       25000 |   85.8 ms |            291,369 |    42.27 |    63.92 |    67.01 |      68.15 |    68.18 |
|       50000 |  170.8 ms |            292,794 |    87.28 |   136.51 |   146.04 |     146.44 |   146.44 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,003 |     4.00 |     6.07 |     6.99 |       7.07 |     7.07 |
|        5000 |   34.1 ms |            146,551 |    17.63 |    27.13 |    27.94 |      27.99 |    27.99 |
|       10000 |   75.4 ms |            132,637 |    39.62 |    62.90 |    64.78 |      64.81 |    64.82 |
|       25000 |  182.7 ms |            136,857 |    95.83 |   155.27 |   165.28 |     165.78 |   165.80 |
|       50000 |  350.5 ms |            142,634 |   187.56 |   292.82 |   319.03 |     320.02 |   320.08 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   21.5 ms |             46,421 |    12.04 |    18.93 |    20.31 |      20.78 |    20.78 |
|        5000 |   77.6 ms |             64,408 |    38.27 |    67.93 |    74.85 |      75.95 |    76.04 |
|       10000 |  181.0 ms |             55,261 |    85.41 |   156.36 |   174.53 |     176.75 |   176.96 |

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
  • Raw Worker IPC Round-Trip      : 0.0211 ms/op
  • End-to-End Runtime Task Cost    : 0.0287 ms/op
  • Scheduler + Graph Overhead     : 0.0076 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,826 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.7 ms |              140,019 |       0.22 |       0.42 |       0.44 |       0.44 |
|         500 |     1.5 ms |              341,077 |       0.74 |       1.13 |       1.21 |       1.23 |
|        1000 |     2.7 ms |              375,059 |       1.27 |       2.06 |       2.14 |       2.18 |
|        5000 |    16.5 ms |              303,291 |       8.93 |      11.50 |      11.60 |      11.65 |
|       10000 |    31.2 ms |              320,223 |      15.99 |      24.05 |      24.37 |      24.54 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.21 MB
  • V8/JSC Heap Used             : 13.67 MB

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
| 1 CPU + 1 IO  |       2 |   45.1 ms |            221,489 |    24.15 |    32.97 |    33.59 |    34.48 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   33.6 ms |            298,019 |    19.51 |    23.26 |    23.61 |    23.62 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.6 ms |            390,234 |    12.51 |    19.63 |    20.50 |    20.90 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   30.3 ms |            330,116 |    14.54 |    23.91 |    24.11 |    24.14 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 81.9 ms
  • Peak Throughput Rate       : 305,377 ops/sec
  • Latency Distribution       : p50: 40.47ms | p90: 65.66ms | p99: 66.71ms | p99.9: 66.85ms | Max: 66.87ms
  • Memory (RSS)               : Baseline: 97.7 MB | Peak: 131.3 MB | Cooldown: 103.2 MB

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
|        1000 |    6.5 ms |            154,413 |     2.91 |     4.22 |     5.34 |       5.58 |     5.58 |
|        5000 |   17.6 ms |            283,442 |     8.50 |    11.75 |    11.82 |      11.83 |    11.83 |
|       10000 |   38.1 ms |            262,298 |    18.17 |    28.25 |    30.14 |      30.17 |    30.18 |
|       25000 |   85.8 ms |            291,369 |    42.27 |    63.92 |    67.01 |      68.15 |    68.18 |
|       50000 |  170.8 ms |            292,794 |    87.28 |   136.51 |   146.04 |     146.44 |   146.44 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,003 |     4.00 |     6.07 |     6.99 |       7.07 |     7.07 |
|        5000 |   34.1 ms |            146,551 |    17.63 |    27.13 |    27.94 |      27.99 |    27.99 |
|       10000 |   75.4 ms |            132,637 |    39.62 |    62.90 |    64.78 |      64.81 |    64.82 |
|       25000 |  182.7 ms |            136,857 |    95.83 |   155.27 |   165.28 |     165.78 |   165.80 |
|       50000 |  350.5 ms |            142,634 |   187.56 |   292.82 |   319.03 |     320.02 |   320.08 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   21.5 ms |             46,421 |    12.04 |    18.93 |    20.31 |      20.78 |    20.78 |
|        5000 |   77.6 ms |             64,408 |    38.27 |    67.93 |    74.85 |      75.95 |    76.04 |
|       10000 |  181.0 ms |             55,261 |    85.41 |   156.36 |   174.53 |     176.75 |   176.96 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 194.9 MB
  • Settled Cooldown RSS   : 79.0 MB (Clean GC release)

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

Route: GET /json
Load: 20,000 requests, 100 concurrent, keep-alive

  * Yatta   :  56,177 req/s | avg 1.78ms | p99 3.59ms
  * Express :  25,677 req/s | avg 3.89ms | p99 8.15ms
  * Fastify :  32,740 req/s | avg 3.05ms | p99 6.05ms
  * Hono    :  56,311 req/s | avg 1.77ms | p99 4.15ms
  * Elysia  :  48,558 req/s | avg 2.06ms | p99 4.77ms
  * Koa     :  24,803 req/s | avg 4.03ms | p99 8.85ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      56,177 | 1.00x |      1.78ms | 1.76ms | 2.80ms | 3.59ms |
| Express   |      25,677 | 0.46x |      3.89ms | 3.29ms | 6.90ms | 8.15ms |
| Fastify   |      32,740 | 0.58x |      3.05ms | 2.93ms | 4.75ms | 6.05ms |
| Hono      |      56,311 | 1.00x |      1.77ms | 1.79ms | 2.97ms | 4.15ms |
| Elysia    |      48,558 | 0.86x |      2.06ms | 2.01ms | 3.99ms | 4.77ms |
| Koa       |      24,803 | 0.44x |      4.03ms | 3.97ms | 6.68ms | 8.85ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
