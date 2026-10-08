# Yatta Benchmarks

> Last run: `2026-10-08T17:09:33Z` · commit [`c3fa27b`](https://github.com/psrockstar098/yatta.js/commit/c3fa27b7668eeb190351729df162acf99c2ee488) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 75.2 ms
  • End-to-End Runtime Task Cost    : 0.0226 ms/op
  • Peak RSS Memory        : 152.8 MB
  • RSS Heap Memory             : 93.68 MB
  • Raw Worker IPC Round-Trip      : 0.0198 ms/op
  • Scheduler + Graph Overhead     : 0.0028 ms/op
  • Settled Cooldown RSS   : 78.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.77 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      77,027 |     1.00x |     2% | 1.36ms | 1.86ms | 2.04ms |
| Raw Bun   |      55,024 |     0.71x |     9% | 1.60ms | 3.31ms | 3.43ms |
| Hono      |      63,776 |     0.83x |    20% | 1.22ms | 2.70ms | 3.25ms |
| Elysia    |      61,270 |     0.80x |    14% | 1.56ms | 3.26ms | 3.42ms |
| Express   |      37,600 |     0.49x |     8% | 2.55ms | 4.25ms | 5.71ms |
| Fastify   |      48,570 |     0.63x |    19% | 1.81ms | 3.32ms | 4.10ms |
| Koa       |      42,079 |     0.55x |     9% | 2.09ms | 4.00ms | 5.14ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,695 |       0.25 |       0.29 |       0.29 |       0.29 |
|         100 |     0.4 ms |              285,660 |       0.13 |       0.19 |       0.21 |       0.21 |
|         500 |     1.1 ms |              443,475 |       0.53 |       0.75 |       0.78 |       0.81 |
|        1000 |     2.2 ms |              463,209 |       1.04 |       1.48 |       1.50 |       1.52 |
|        5000 |    16.1 ms |              310,509 |       9.70 |      12.00 |      12.04 |      12.09 |
|       10000 |    29.9 ms |              334,340 |      14.39 |      24.30 |      24.74 |      24.77 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.9 ms |            204,775 |     2.17 |     3.20 |     3.87 |       3.92 |     3.92 |
|        5000 |   13.3 ms |            376,079 |     6.97 |     8.97 |     9.03 |       9.06 |     9.06 |
|       10000 |   30.7 ms |            325,249 |    13.98 |    23.53 |    24.73 |      24.76 |    24.76 |
|       25000 |   64.6 ms |            387,237 |    31.74 |    46.39 |    48.90 |      49.14 |    49.17 |
|       50000 |  115.0 ms |            434,868 |    57.02 |    86.46 |    94.94 |      95.37 |    95.40 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.3 ms |            119,900 |     3.30 |     6.13 |     7.19 |       7.28 |     7.28 |
|        5000 |   31.0 ms |            161,128 |    15.87 |    24.17 |    24.87 |      24.90 |    24.91 |
|       10000 |   73.5 ms |            136,020 |    31.22 |    51.71 |    65.09 |      65.17 |    65.18 |
|       25000 |  154.7 ms |            161,587 |    80.96 |   134.44 |   143.04 |     143.53 |   143.55 |
|       50000 |  309.7 ms |            161,431 |   152.49 |   266.12 |   287.34 |     288.33 |   288.39 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.0 ms |             41,611 |    16.49 |    22.04 |    23.18 |      23.41 |    23.41 |
|        5000 |   71.4 ms |             70,029 |    37.47 |    62.11 |    67.69 |      68.64 |    68.72 |
|       10000 |  154.7 ms |             64,622 |    75.57 |   135.96 |   150.84 |     152.50 |   152.68 |

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
  • Raw Worker IPC Round-Trip      : 0.0198 ms/op
  • End-to-End Runtime Task Cost    : 0.0226 ms/op
  • Scheduler + Graph Overhead     : 0.0028 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,695 |       0.25 |       0.29 |       0.29 |       0.29 |
|         100 |     0.4 ms |              285,660 |       0.13 |       0.19 |       0.21 |       0.21 |
|         500 |     1.1 ms |              443,475 |       0.53 |       0.75 |       0.78 |       0.81 |
|        1000 |     2.2 ms |              463,209 |       1.04 |       1.48 |       1.50 |       1.52 |
|        5000 |    16.1 ms |              310,509 |       9.70 |      12.00 |      12.04 |      12.09 |
|       10000 |    29.9 ms |              334,340 |      14.39 |      24.30 |      24.74 |      24.77 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.68 MB
  • V8/JSC Heap Used             : 13.77 MB

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
| 1 CPU + 1 IO  |       2 |   34.3 ms |            291,425 |    18.34 |    27.64 |    28.07 |    28.17 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   31.8 ms |            314,031 |    16.24 |    23.78 |    24.80 |    24.82 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   22.1 ms |            452,066 |     8.62 |    17.23 |    17.77 |    18.09 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   29.8 ms |            336,094 |    15.37 |    24.40 |    24.57 |    24.60 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 75.2 ms
  • Peak Throughput Rate       : 332,659 ops/sec
  • Latency Distribution       : p50: 40.44ms | p90: 63.30ms | p99: 64.10ms | p99.9: 64.17ms | Max: 64.19ms
  • Memory (RSS)               : Baseline: 106.4 MB | Peak: 137.0 MB | Cooldown: 104.5 MB

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
|        1000 |    4.9 ms |            204,775 |     2.17 |     3.20 |     3.87 |       3.92 |     3.92 |
|        5000 |   13.3 ms |            376,079 |     6.97 |     8.97 |     9.03 |       9.06 |     9.06 |
|       10000 |   30.7 ms |            325,249 |    13.98 |    23.53 |    24.73 |      24.76 |    24.76 |
|       25000 |   64.6 ms |            387,237 |    31.74 |    46.39 |    48.90 |      49.14 |    49.17 |
|       50000 |  115.0 ms |            434,868 |    57.02 |    86.46 |    94.94 |      95.37 |    95.40 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.3 ms |            119,900 |     3.30 |     6.13 |     7.19 |       7.28 |     7.28 |
|        5000 |   31.0 ms |            161,128 |    15.87 |    24.17 |    24.87 |      24.90 |    24.91 |
|       10000 |   73.5 ms |            136,020 |    31.22 |    51.71 |    65.09 |      65.17 |    65.18 |
|       25000 |  154.7 ms |            161,587 |    80.96 |   134.44 |   143.04 |     143.53 |   143.55 |
|       50000 |  309.7 ms |            161,431 |   152.49 |   266.12 |   287.34 |     288.33 |   288.39 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.0 ms |             41,611 |    16.49 |    22.04 |    23.18 |      23.41 |    23.41 |
|        5000 |   71.4 ms |             70,029 |    37.47 |    62.11 |    67.69 |      68.64 |    68.72 |
|       10000 |  154.7 ms |             64,622 |    75.57 |   135.96 |   150.84 |     152.50 |   152.68 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 152.8 MB
  • Settled Cooldown RSS   : 78.3 MB (Clean GC release)

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
| Yatta     |      77,027 |     1.00x |     2% | 1.36ms | 1.86ms | 2.04ms |
| Raw Bun   |      55,024 |     0.71x |     9% | 1.60ms | 3.31ms | 3.43ms |
| Hono      |      63,776 |     0.83x |    20% | 1.22ms | 2.70ms | 3.25ms |
| Elysia    |      61,270 |     0.80x |    14% | 1.56ms | 3.26ms | 3.42ms |
| Express   |      37,600 |     0.49x |     8% | 2.55ms | 4.25ms | 5.71ms |
| Fastify   |      48,570 |     0.63x |    19% | 1.81ms | 3.32ms | 4.10ms |
| Koa       |      42,079 |     0.55x |     9% | 2.09ms | 4.00ms | 5.14ms |

  Yatta dispatch adds about -5.2µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
