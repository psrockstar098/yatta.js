# Yatta Benchmarks

> Last run: `2026-10-07T01:13:19Z` · commit [`0e8c8d2`](https://github.com/psrockstar098/yatta.js/commit/0e8c8d25e697956b18ea4fc52fe9771441570599) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 96.3 ms
  • End-to-End Runtime Task Cost    : 0.0396 ms/op
  • Peak RSS Memory        : 221.8 MB
  • RSS Heap Memory             : 80.93 MB
  • Raw Worker IPC Round-Trip      : 0.0360 ms/op
  • Scheduler + Graph Overhead     : 0.0036 ms/op
  • Settled Cooldown RSS   : 74.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 12.86 MB
  • Worker Fleet Event Loop Lag : 10.17 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      51,414 | 1.00x |      1.94ms | 1.95ms | 3.85ms | 4.75ms |
| Express   |      19,502 | 0.38x |      5.12ms | 4.60ms | 8.78ms | 10.61ms |
| Fastify   |      28,335 | 0.55x |      3.52ms | 3.31ms | 6.06ms | 7.37ms |
| Hono      |      53,092 | 1.03x |      1.88ms | 1.87ms | 3.63ms | 4.27ms |
| Elysia    |      50,115 | 0.97x |      1.99ms | 1.72ms | 3.46ms | 4.38ms |
| Koa       |      19,235 | 0.37x |      5.19ms | 4.56ms | 9.15ms | 11.40ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,531 |       0.36 |       0.38 |       0.38 |       0.38 |
|         100 |     0.6 ms |              159,047 |       0.24 |       0.35 |       0.39 |       0.39 |
|         500 |     1.8 ms |              276,100 |       0.88 |       1.36 |       1.44 |       1.48 |
|        1000 |     3.1 ms |              322,866 |       1.54 |       2.35 |       2.47 |       2.50 |
|        5000 |    25.8 ms |              193,594 |      15.37 |      19.75 |      19.80 |      19.82 |
|       10000 |    54.1 ms |              184,704 |      27.69 |      44.08 |      45.13 |      45.36 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            125,725 |     3.92 |     5.58 |     6.54 |       6.67 |     6.67 |
|        5000 |   18.8 ms |            266,008 |     9.52 |    12.06 |    12.56 |      12.57 |    12.57 |
|       10000 |   43.6 ms |            229,211 |    20.06 |    29.20 |    33.30 |      33.55 |    33.58 |
|       25000 |   86.5 ms |            289,064 |    41.63 |    60.21 |    65.75 |      66.16 |    66.21 |
|       50000 |  161.5 ms |            309,579 |    82.74 |   124.35 |   131.70 |     132.15 |   132.15 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.0 ms |             83,123 |     5.50 |     9.03 |    10.59 |      10.91 |    10.91 |
|        5000 |   43.2 ms |            115,736 |    22.93 |    33.14 |    34.16 |      34.24 |    34.25 |
|       10000 |   85.9 ms |            116,443 |    44.78 |    69.42 |    75.89 |      75.95 |    75.97 |
|       25000 |  220.6 ms |            113,332 |   111.31 |   191.88 |   202.67 |     203.07 |   203.10 |
|       50000 |  411.2 ms |            121,608 |   216.57 |   347.89 |   373.78 |     374.72 |   374.77 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.7 ms |             32,572 |    12.29 |    27.79 |    29.39 |      29.71 |    29.71 |
|        5000 |   98.8 ms |             50,603 |    48.16 |    82.87 |    94.74 |      96.35 |    96.49 |
|       10000 |  188.5 ms |             53,062 |    93.91 |   165.66 |   183.08 |     184.45 |   184.66 |

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
  • Raw Worker IPC Round-Trip      : 0.0360 ms/op
  • End-to-End Runtime Task Cost    : 0.0396 ms/op
  • Scheduler + Graph Overhead     : 0.0036 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,531 |       0.36 |       0.38 |       0.38 |       0.38 |
|         100 |     0.6 ms |              159,047 |       0.24 |       0.35 |       0.39 |       0.39 |
|         500 |     1.8 ms |              276,100 |       0.88 |       1.36 |       1.44 |       1.48 |
|        1000 |     3.1 ms |              322,866 |       1.54 |       2.35 |       2.47 |       2.50 |
|        5000 |    25.8 ms |              193,594 |      15.37 |      19.75 |      19.80 |      19.82 |
|       10000 |    54.1 ms |              184,704 |      27.69 |      44.08 |      45.13 |      45.36 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.17 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.93 MB
  • V8/JSC Heap Used             : 12.86 MB

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
| 1 CPU + 1 IO  |       2 |   49.8 ms |            200,623 |    22.87 |    37.94 |    38.55 |    38.60 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   41.6 ms |            240,520 |    21.16 |    29.55 |    29.63 |    29.64 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   42.7 ms |            234,379 |    20.92 |    33.34 |    34.37 |    34.82 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   35.4 ms |            282,802 |    17.79 |    26.08 |    27.17 |    27.32 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 96.3 ms
  • Peak Throughput Rate       : 259,737 ops/sec
  • Latency Distribution       : p50: 47.09ms | p90: 69.61ms | p99: 70.47ms | p99.9: 70.93ms | Max: 70.94ms
  • Memory (RSS)               : Baseline: 100.4 MB | Peak: 129.0 MB | Cooldown: 101.4 MB

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
|        1000 |    8.0 ms |            125,725 |     3.92 |     5.58 |     6.54 |       6.67 |     6.67 |
|        5000 |   18.8 ms |            266,008 |     9.52 |    12.06 |    12.56 |      12.57 |    12.57 |
|       10000 |   43.6 ms |            229,211 |    20.06 |    29.20 |    33.30 |      33.55 |    33.58 |
|       25000 |   86.5 ms |            289,064 |    41.63 |    60.21 |    65.75 |      66.16 |    66.21 |
|       50000 |  161.5 ms |            309,579 |    82.74 |   124.35 |   131.70 |     132.15 |   132.15 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.0 ms |             83,123 |     5.50 |     9.03 |    10.59 |      10.91 |    10.91 |
|        5000 |   43.2 ms |            115,736 |    22.93 |    33.14 |    34.16 |      34.24 |    34.25 |
|       10000 |   85.9 ms |            116,443 |    44.78 |    69.42 |    75.89 |      75.95 |    75.97 |
|       25000 |  220.6 ms |            113,332 |   111.31 |   191.88 |   202.67 |     203.07 |   203.10 |
|       50000 |  411.2 ms |            121,608 |   216.57 |   347.89 |   373.78 |     374.72 |   374.77 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.7 ms |             32,572 |    12.29 |    27.79 |    29.39 |      29.71 |    29.71 |
|        5000 |   98.8 ms |             50,603 |    48.16 |    82.87 |    94.74 |      96.35 |    96.49 |
|       10000 |  188.5 ms |             53,062 |    93.91 |   165.66 |   183.08 |     184.45 |   184.66 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 221.8 MB
  • Settled Cooldown RSS   : 74.3 MB (Clean GC release)

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

  * Yatta   :  51,414 req/s | avg 1.94ms | p99 4.75ms
  * Express :  19,502 req/s | avg 5.12ms | p99 10.61ms
  * Fastify :  28,335 req/s | avg 3.52ms | p99 7.37ms
  * Hono    :  53,092 req/s | avg 1.88ms | p99 4.27ms
  * Elysia  :  50,115 req/s | avg 1.99ms | p99 4.38ms
  * Koa     :  19,235 req/s | avg 5.19ms | p99 11.40ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      51,414 | 1.00x |      1.94ms | 1.95ms | 3.85ms | 4.75ms |
| Express   |      19,502 | 0.38x |      5.12ms | 4.60ms | 8.78ms | 10.61ms |
| Fastify   |      28,335 | 0.55x |      3.52ms | 3.31ms | 6.06ms | 7.37ms |
| Hono      |      53,092 | 1.03x |      1.88ms | 1.87ms | 3.63ms | 4.27ms |
| Elysia    |      50,115 | 0.97x |      1.99ms | 1.72ms | 3.46ms | 4.38ms |
| Koa       |      19,235 | 0.37x |      5.19ms | 4.56ms | 9.15ms | 11.40ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
