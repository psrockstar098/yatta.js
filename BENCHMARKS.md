# Yatta Benchmarks

> Last run: `2026-10-07T02:51:36Z` · commit [`9a1978c`](https://github.com/psrockstar098/yatta.js/commit/9a1978c124dd7d3528a27a2e227461305f475c42) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 110.3 ms
  • End-to-End Runtime Task Cost    : 0.0455 ms/op
  • Peak RSS Memory        : 130.4 MB
  • RSS Heap Memory             : 77.21 MB
  • Raw Worker IPC Round-Trip      : 0.0377 ms/op
  • Scheduler + Graph Overhead     : 0.0078 ms/op
  • Settled Cooldown RSS   : 72.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      33,646 | 1.00x |      2.97ms | 2.52ms | 4.62ms | 5.36ms |
| Express   |      14,560 | 0.43x |      6.86ms | 6.28ms | 11.14ms | 13.02ms |
| Fastify   |      19,439 | 0.58x |      5.14ms | 4.72ms | 8.26ms | 8.90ms |
| Hono      |      38,604 | 1.15x |      2.59ms | 2.27ms | 4.39ms | 5.97ms |
| Elysia    |      49,966 | 1.49x |      2.00ms | 1.92ms | 3.20ms | 4.40ms |
| Koa       |      14,889 | 0.44x |      6.71ms | 6.85ms | 10.31ms | 11.74ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,307 |       0.35 |       0.38 |       0.38 |       0.38 |
|         100 |     0.8 ms |              132,018 |       0.31 |       0.43 |       0.47 |       0.47 |
|         500 |     2.2 ms |              226,774 |       1.05 |       1.77 |       1.83 |       1.89 |
|        1000 |     4.9 ms |              205,333 |       2.29 |       3.35 |       3.48 |       3.52 |
|        5000 |    25.0 ms |              200,266 |      13.50 |      18.59 |      18.73 |      18.76 |
|       10000 |    44.8 ms |              223,032 |      23.72 |      35.99 |      36.71 |      36.75 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            102,653 |     4.33 |     6.17 |     7.36 |       7.48 |     7.48 |
|        5000 |   28.9 ms |            173,033 |    15.27 |    16.93 |    18.14 |      18.16 |    18.16 |
|       10000 |   53.7 ms |            186,278 |    27.63 |    40.01 |    41.90 |      41.91 |    41.92 |
|       25000 |  120.0 ms |            208,402 |    60.06 |    84.72 |    87.61 |      88.00 |    88.06 |
|       50000 |  195.5 ms |            255,707 |   101.13 |   151.41 |   162.66 |     163.64 |   163.73 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.8 ms |             63,339 |     6.91 |    12.59 |    14.12 |      14.39 |    14.39 |
|        5000 |   52.2 ms |             95,839 |    27.43 |    40.95 |    41.89 |      42.02 |    42.03 |
|       10000 |  106.6 ms |             93,795 |    57.44 |    88.71 |    92.41 |      92.59 |    92.59 |
|       25000 |  278.0 ms |             89,917 |   139.09 |   233.41 |   245.63 |     247.45 |   247.49 |
|       50000 |  507.0 ms |             98,628 |   265.66 |   427.08 |   465.85 |     466.70 |   466.97 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.3 ms |             30,990 |    16.43 |    26.89 |    30.64 |      31.07 |    31.07 |
|        5000 |  147.8 ms |             33,834 |    70.02 |   130.49 |   142.02 |     144.06 |   144.25 |
|       10000 |  293.5 ms |             34,076 |   153.29 |   254.52 |   278.80 |     283.43 |   283.88 |

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
  • Raw Worker IPC Round-Trip      : 0.0377 ms/op
  • End-to-End Runtime Task Cost    : 0.0455 ms/op
  • Scheduler + Graph Overhead     : 0.0078 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,307 |       0.35 |       0.38 |       0.38 |       0.38 |
|         100 |     0.8 ms |              132,018 |       0.31 |       0.43 |       0.47 |       0.47 |
|         500 |     2.2 ms |              226,774 |       1.05 |       1.77 |       1.83 |       1.89 |
|        1000 |     4.9 ms |              205,333 |       2.29 |       3.35 |       3.48 |       3.52 |
|        5000 |    25.0 ms |              200,266 |      13.50 |      18.59 |      18.73 |      18.76 |
|       10000 |    44.8 ms |              223,032 |      23.72 |      35.99 |      36.71 |      36.75 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.21 MB
  • V8/JSC Heap Used             : 0.75 MB

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
| 1 CPU + 1 IO  |       2 |   45.2 ms |            221,164 |    20.84 |    33.72 |    34.53 |    34.72 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   45.9 ms |            217,641 |    23.49 |    34.47 |    34.53 |    34.54 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   34.9 ms |            286,422 |    17.83 |    26.57 |    27.18 |    27.39 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.8 ms |            245,063 |    20.95 |    33.25 |    33.49 |    33.52 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 110.3 ms
  • Peak Throughput Rate       : 226,650 ops/sec
  • Latency Distribution       : p50: 51.93ms | p90: 90.48ms | p99: 91.55ms | p99.9: 91.64ms | Max: 91.66ms
  • Memory (RSS)               : Baseline: 99.6 MB | Peak: 130.2 MB | Cooldown: 103.3 MB

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
|        1000 |    9.7 ms |            102,653 |     4.33 |     6.17 |     7.36 |       7.48 |     7.48 |
|        5000 |   28.9 ms |            173,033 |    15.27 |    16.93 |    18.14 |      18.16 |    18.16 |
|       10000 |   53.7 ms |            186,278 |    27.63 |    40.01 |    41.90 |      41.91 |    41.92 |
|       25000 |  120.0 ms |            208,402 |    60.06 |    84.72 |    87.61 |      88.00 |    88.06 |
|       50000 |  195.5 ms |            255,707 |   101.13 |   151.41 |   162.66 |     163.64 |   163.73 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.8 ms |             63,339 |     6.91 |    12.59 |    14.12 |      14.39 |    14.39 |
|        5000 |   52.2 ms |             95,839 |    27.43 |    40.95 |    41.89 |      42.02 |    42.03 |
|       10000 |  106.6 ms |             93,795 |    57.44 |    88.71 |    92.41 |      92.59 |    92.59 |
|       25000 |  278.0 ms |             89,917 |   139.09 |   233.41 |   245.63 |     247.45 |   247.49 |
|       50000 |  507.0 ms |             98,628 |   265.66 |   427.08 |   465.85 |     466.70 |   466.97 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.3 ms |             30,990 |    16.43 |    26.89 |    30.64 |      31.07 |    31.07 |
|        5000 |  147.8 ms |             33,834 |    70.02 |   130.49 |   142.02 |     144.06 |   144.25 |
|       10000 |  293.5 ms |             34,076 |   153.29 |   254.52 |   278.80 |     283.43 |   283.88 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 130.4 MB
  • Settled Cooldown RSS   : 72.4 MB (Clean GC release)

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

  * Yatta   :  33,646 req/s | avg 2.97ms | p99 5.36ms
  * Express :  14,560 req/s | avg 6.86ms | p99 13.02ms
  * Fastify :  19,439 req/s | avg 5.14ms | p99 8.90ms
  * Hono    :  38,604 req/s | avg 2.59ms | p99 5.97ms
  * Elysia  :  49,966 req/s | avg 2.00ms | p99 4.40ms
  * Koa     :  14,889 req/s | avg 6.71ms | p99 11.74ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      33,646 | 1.00x |      2.97ms | 2.52ms | 4.62ms | 5.36ms |
| Express   |      14,560 | 0.43x |      6.86ms | 6.28ms | 11.14ms | 13.02ms |
| Fastify   |      19,439 | 0.58x |      5.14ms | 4.72ms | 8.26ms | 8.90ms |
| Hono      |      38,604 | 1.15x |      2.59ms | 2.27ms | 4.39ms | 5.97ms |
| Elysia    |      49,966 | 1.49x |      2.00ms | 1.92ms | 3.20ms | 4.40ms |
| Koa       |      14,889 | 0.44x |      6.71ms | 6.85ms | 10.31ms | 11.74ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
