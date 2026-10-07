# Yatta Benchmarks

> Last run: `2026-10-07T16:14:06Z` · commit [`a610c61`](https://github.com/psrockstar098/yatta.js/commit/a610c614c17b08baefeb847202395ea78955ba5b) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 60.6 ms
  • End-to-End Runtime Task Cost    : 0.0218 ms/op
  • Peak RSS Memory        : 187.7 MB
  • RSS Heap Memory             : 87.52 MB
  • Raw Worker IPC Round-Trip      : 0.0211 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op
  • Settled Cooldown RSS   : 74.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.26 MB
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
| Yatta     |      71,426 |     1.00x |    12% | 1.32ms | 2.70ms | 3.21ms |
| Raw Bun   |      56,795 |     0.80x |     2% | 1.47ms | 3.04ms | 3.11ms |
| Hono      |      61,718 |     0.86x |    26% | 1.49ms | 3.07ms | 3.20ms |
| Elysia    |      60,086 |     0.84x |     5% | 1.43ms | 2.99ms | 3.07ms |
| Express   |      44,751 |     0.63x |     0% | 2.06ms | 3.65ms | 5.72ms |
| Fastify   |      52,106 |     0.73x |    13% | 1.56ms | 2.84ms | 4.32ms |
| Koa       |      48,852 |     0.68x |     8% | 1.72ms | 3.51ms | 5.15ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,172 |       0.20 |       0.22 |       0.22 |       0.22 |
|         100 |     0.7 ms |              140,589 |       0.17 |       0.52 |       0.52 |       0.52 |
|         500 |     1.2 ms |              403,093 |       0.56 |       0.71 |       0.72 |       0.73 |
|        1000 |     2.0 ms |              498,591 |       1.08 |       1.62 |       1.66 |       1.69 |
|        5000 |    11.7 ms |              426,435 |       6.34 |       7.98 |       8.23 |       8.30 |
|       10000 |    22.7 ms |              440,501 |      11.36 |      17.59 |      17.73 |      17.76 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.5 ms |            153,706 |     2.49 |     4.47 |     5.50 |       5.71 |     5.71 |
|        5000 |   11.9 ms |            421,830 |     5.60 |     6.53 |     6.83 |       6.84 |     6.84 |
|       10000 |   27.1 ms |            368,482 |    14.43 |    20.05 |    21.43 |      21.44 |    21.44 |
|       25000 |   62.6 ms |            399,470 |    28.01 |    47.05 |    48.70 |      48.72 |    48.72 |
|       50000 |  109.3 ms |            457,506 |    50.24 |    83.43 |    90.06 |      90.45 |    90.48 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.1 ms |            140,380 |     3.32 |     4.75 |     5.46 |       5.53 |     5.53 |
|        5000 |   28.9 ms |            173,207 |    14.04 |    20.96 |    21.62 |      21.66 |    21.67 |
|       10000 |   53.9 ms |            185,612 |    27.26 |    46.54 |    48.45 |      48.52 |    48.58 |
|       25000 |  152.2 ms |            164,210 |    75.64 |   130.98 |   139.88 |     140.33 |   140.35 |
|       50000 |  304.0 ms |            164,461 |   163.36 |   257.88 |   280.52 |     281.37 |   281.41 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,396 |     7.87 |    12.69 |    14.23 |      14.43 |    14.43 |
|        5000 |   64.0 ms |             78,137 |    33.14 |    56.62 |    61.95 |      62.61 |    62.70 |
|       10000 |  144.6 ms |             69,142 |    76.10 |   126.27 |   138.57 |     141.79 |   142.01 |

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
  • End-to-End Runtime Task Cost    : 0.0218 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,172 |       0.20 |       0.22 |       0.22 |       0.22 |
|         100 |     0.7 ms |              140,589 |       0.17 |       0.52 |       0.52 |       0.52 |
|         500 |     1.2 ms |              403,093 |       0.56 |       0.71 |       0.72 |       0.73 |
|        1000 |     2.0 ms |              498,591 |       1.08 |       1.62 |       1.66 |       1.69 |
|        5000 |    11.7 ms |              426,435 |       6.34 |       7.98 |       8.23 |       8.30 |
|       10000 |    22.7 ms |              440,501 |      11.36 |      17.59 |      17.73 |      17.76 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 87.52 MB
  • V8/JSC Heap Used             : 13.26 MB

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
| 1 CPU + 1 IO  |       2 |   33.3 ms |            300,063 |    16.27 |    24.93 |    25.62 |    25.66 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   30.4 ms |            329,214 |    15.51 |    22.98 |    23.13 |    23.13 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.5 ms |            392,855 |    13.36 |    19.26 |    19.69 |    19.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   21.0 ms |            475,695 |     9.99 |    15.90 |    16.04 |    16.06 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 60.6 ms
  • Peak Throughput Rate       : 412,521 ops/sec
  • Latency Distribution       : p50: 30.76ms | p90: 48.37ms | p99: 48.68ms | p99.9: 48.74ms | Max: 48.74ms
  • Memory (RSS)               : Baseline: 107.7 MB | Peak: 130.9 MB | Cooldown: 102.0 MB

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
|        1000 |    6.5 ms |            153,706 |     2.49 |     4.47 |     5.50 |       5.71 |     5.71 |
|        5000 |   11.9 ms |            421,830 |     5.60 |     6.53 |     6.83 |       6.84 |     6.84 |
|       10000 |   27.1 ms |            368,482 |    14.43 |    20.05 |    21.43 |      21.44 |    21.44 |
|       25000 |   62.6 ms |            399,470 |    28.01 |    47.05 |    48.70 |      48.72 |    48.72 |
|       50000 |  109.3 ms |            457,506 |    50.24 |    83.43 |    90.06 |      90.45 |    90.48 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.1 ms |            140,380 |     3.32 |     4.75 |     5.46 |       5.53 |     5.53 |
|        5000 |   28.9 ms |            173,207 |    14.04 |    20.96 |    21.62 |      21.66 |    21.67 |
|       10000 |   53.9 ms |            185,612 |    27.26 |    46.54 |    48.45 |      48.52 |    48.58 |
|       25000 |  152.2 ms |            164,210 |    75.64 |   130.98 |   139.88 |     140.33 |   140.35 |
|       50000 |  304.0 ms |            164,461 |   163.36 |   257.88 |   280.52 |     281.37 |   281.41 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,396 |     7.87 |    12.69 |    14.23 |      14.43 |    14.43 |
|        5000 |   64.0 ms |             78,137 |    33.14 |    56.62 |    61.95 |      62.61 |    62.70 |
|       10000 |  144.6 ms |             69,142 |    76.10 |   126.27 |   138.57 |     141.79 |   142.01 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 187.7 MB
  • Settled Cooldown RSS   : 74.0 MB (Clean GC release)

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
| Yatta     |      71,426 |     1.00x |    12% | 1.32ms | 2.70ms | 3.21ms |
| Raw Bun   |      56,795 |     0.80x |     2% | 1.47ms | 3.04ms | 3.11ms |
| Hono      |      61,718 |     0.86x |    26% | 1.49ms | 3.07ms | 3.20ms |
| Elysia    |      60,086 |     0.84x |     5% | 1.43ms | 2.99ms | 3.07ms |
| Express   |      44,751 |     0.63x |     0% | 2.06ms | 3.65ms | 5.72ms |
| Fastify   |      52,106 |     0.73x |    13% | 1.56ms | 2.84ms | 4.32ms |
| Koa       |      48,852 |     0.68x |     8% | 1.72ms | 3.51ms | 5.15ms |

  Yatta dispatch adds about -3.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
