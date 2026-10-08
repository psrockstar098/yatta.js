# Yatta Benchmarks

> Last run: `2026-10-08T16:48:07Z` · commit [`6f69c1e`](https://github.com/psrockstar098/yatta.js/commit/6f69c1edf1e7305f31d7886fd5c172411a9c33c0) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 105.8 ms
  • End-to-End Runtime Task Cost    : 0.0529 ms/op
  • Peak RSS Memory        : 135.6 MB
  • RSS Heap Memory             : 77.82 MB
  • Raw Worker IPC Round-Trip      : 0.0393 ms/op
  • Scheduler + Graph Overhead     : 0.0136 ms/op
  • Settled Cooldown RSS   : 88.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      43,227 |     1.00x |    34% | 3.67ms | 4.90ms | 6.88ms |
| Raw Bun   |      42,434 |     0.98x |    49% | 2.72ms | 5.92ms | 8.90ms |
| Hono      |      44,258 |     1.02x |     8% | 2.00ms | 3.65ms | 4.55ms |
| Elysia    |      48,351 |     1.12x |    23% | 2.16ms | 3.13ms | 4.84ms |
| Express   |      14,842 |     0.34x |     8% | 7.09ms | 10.98ms | 12.23ms |
| Fastify   |      20,615 |     0.48x |     4% | 4.52ms | 7.81ms | 8.86ms |
| Koa       |      15,816 |     0.37x |     7% | 5.78ms | 9.72ms | 11.54ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,507 |       0.49 |       0.52 |       0.52 |       0.52 |
|         100 |     1.5 ms |               66,634 |       0.35 |       1.11 |       1.12 |       1.12 |
|         500 |     2.4 ms |              206,627 |       1.26 |       1.86 |       1.93 |       1.96 |
|        1000 |     4.3 ms |              234,397 |       2.13 |       3.38 |       3.52 |       3.56 |
|        5000 |    30.8 ms |              162,261 |      18.40 |      23.19 |      23.25 |      23.27 |
|       10000 |    49.9 ms |              200,207 |      25.36 |      39.66 |      39.96 |      40.00 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            125,671 |     3.62 |     5.13 |     5.94 |       6.26 |     6.26 |
|        5000 |   20.8 ms |            240,379 |    10.41 |    13.07 |    13.58 |      13.59 |    13.59 |
|       10000 |   43.1 ms |            232,135 |    21.38 |    31.87 |    34.10 |      34.12 |    34.12 |
|       25000 |  107.9 ms |            231,646 |    56.07 |    83.13 |    86.21 |      86.30 |    86.32 |
|       50000 |  194.6 ms |            256,893 |    98.94 |   152.32 |   164.03 |     164.56 |   164.57 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.5 ms |             73,967 |     6.94 |    10.88 |    11.99 |      12.04 |    12.04 |
|        5000 |   50.4 ms |             99,254 |    24.47 |    39.18 |    40.18 |      40.24 |    40.25 |
|       10000 |   99.1 ms |            100,861 |    52.33 |    83.72 |    85.79 |      85.89 |    85.90 |
|       25000 |  243.2 ms |            102,806 |   131.47 |   214.80 |   225.15 |     225.62 |   225.64 |
|       50000 |  447.3 ms |            111,781 |   242.16 |   372.18 |   407.61 |     408.59 |   408.67 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.9 ms |             32,388 |    16.38 |    27.25 |    29.55 |      29.88 |    29.88 |
|        5000 |  131.2 ms |             38,117 |    69.07 |   116.47 |   127.36 |     128.55 |   128.69 |
|       10000 |  271.4 ms |             36,847 |   129.22 |   238.28 |   263.00 |     266.43 |   266.87 |

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
  • Raw Worker IPC Round-Trip      : 0.0393 ms/op
  • End-to-End Runtime Task Cost    : 0.0529 ms/op
  • Scheduler + Graph Overhead     : 0.0136 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,507 |       0.49 |       0.52 |       0.52 |       0.52 |
|         100 |     1.5 ms |               66,634 |       0.35 |       1.11 |       1.12 |       1.12 |
|         500 |     2.4 ms |              206,627 |       1.26 |       1.86 |       1.93 |       1.96 |
|        1000 |     4.3 ms |              234,397 |       2.13 |       3.38 |       3.52 |       3.56 |
|        5000 |    30.8 ms |              162,261 |      18.40 |      23.19 |      23.25 |      23.27 |
|       10000 |    49.9 ms |              200,207 |      25.36 |      39.66 |      39.96 |      40.00 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.82 MB
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
| 1 CPU + 1 IO  |       2 |   63.3 ms |            157,914 |    28.31 |    45.81 |    48.57 |    48.89 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.4 ms |            230,263 |    22.34 |    33.54 |    33.68 |    33.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   41.8 ms |            239,467 |    22.38 |    32.57 |    33.67 |    33.94 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   39.3 ms |            254,727 |    18.01 |    29.76 |    30.32 |    30.42 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 105.8 ms
  • Peak Throughput Rate       : 236,362 ops/sec
  • Latency Distribution       : p50: 54.64ms | p90: 86.90ms | p99: 87.63ms | p99.9: 87.66ms | Max: 87.67ms
  • Memory (RSS)               : Baseline: 107.6 MB | Peak: 129.4 MB | Cooldown: 102.8 MB

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
|        1000 |    8.0 ms |            125,671 |     3.62 |     5.13 |     5.94 |       6.26 |     6.26 |
|        5000 |   20.8 ms |            240,379 |    10.41 |    13.07 |    13.58 |      13.59 |    13.59 |
|       10000 |   43.1 ms |            232,135 |    21.38 |    31.87 |    34.10 |      34.12 |    34.12 |
|       25000 |  107.9 ms |            231,646 |    56.07 |    83.13 |    86.21 |      86.30 |    86.32 |
|       50000 |  194.6 ms |            256,893 |    98.94 |   152.32 |   164.03 |     164.56 |   164.57 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.5 ms |             73,967 |     6.94 |    10.88 |    11.99 |      12.04 |    12.04 |
|        5000 |   50.4 ms |             99,254 |    24.47 |    39.18 |    40.18 |      40.24 |    40.25 |
|       10000 |   99.1 ms |            100,861 |    52.33 |    83.72 |    85.79 |      85.89 |    85.90 |
|       25000 |  243.2 ms |            102,806 |   131.47 |   214.80 |   225.15 |     225.62 |   225.64 |
|       50000 |  447.3 ms |            111,781 |   242.16 |   372.18 |   407.61 |     408.59 |   408.67 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.9 ms |             32,388 |    16.38 |    27.25 |    29.55 |      29.88 |    29.88 |
|        5000 |  131.2 ms |             38,117 |    69.07 |   116.47 |   127.36 |     128.55 |   128.69 |
|       10000 |  271.4 ms |             36,847 |   129.22 |   238.28 |   263.00 |     266.43 |   266.87 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 135.6 MB
  • Settled Cooldown RSS   : 88.2 MB (Clean GC release)

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
| Yatta     |      43,227 |     1.00x |    34% | 3.67ms | 4.90ms | 6.88ms |
| Raw Bun   |      42,434 |     0.98x |    49% | 2.72ms | 5.92ms | 8.90ms |
| Hono      |      44,258 |     1.02x |     8% | 2.00ms | 3.65ms | 4.55ms |
| Elysia    |      48,351 |     1.12x |    23% | 2.16ms | 3.13ms | 4.84ms |
| Express   |      14,842 |     0.34x |     8% | 7.09ms | 10.98ms | 12.23ms |
| Fastify   |      20,615 |     0.48x |     4% | 4.52ms | 7.81ms | 8.86ms |
| Koa       |      15,816 |     0.37x |     7% | 5.78ms | 9.72ms | 11.54ms |

  Yatta dispatch adds about -0.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 34%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
