# Yatta Benchmarks

> Last run: `2026-11-05T03:45:07Z` · commit [`3fdcbc5`](https://github.com/psrockstar098/yatta.js/commit/3fdcbc544e3f9902e5f98aea049edbd1d96ad0df) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 121.9 ms
  • End-to-End Runtime Task Cost    : 0.0437 ms/op
  • Peak RSS Memory        : 121.1 MB
  • RSS Heap Memory             : 80.13 MB
  • Raw Worker IPC Round-Trip      : 0.0348 ms/op
  • Scheduler + Graph Overhead     : 0.0089 ms/op
  • Settled Cooldown RSS   : 71.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
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
| Yatta     |      39,937 |     1.00x |    18% | 2.23ms | 4.69ms | 5.06ms |
| Raw Bun   |      48,627 |     1.22x |    28% | 1.76ms | 2.94ms | 4.32ms |
| Hono      |      49,773 |     1.25x |    40% | 1.90ms | 3.36ms | 4.03ms |
| Elysia    |      44,518 |     1.11x |    29% | 2.21ms | 4.29ms | 4.63ms |
| Express   |      14,798 |     0.37x |     2% | 6.89ms | 10.06ms | 11.86ms |
| Fastify   |      18,575 |     0.47x |     5% | 4.60ms | 8.42ms | 9.51ms |
| Koa       |      15,240 |     0.38x |    12% | 6.39ms | 10.78ms | 12.19ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,682 |       0.41 |       0.44 |       0.44 |       0.44 |
|         100 |     0.8 ms |              132,389 |       0.36 |       0.61 |       0.65 |       0.65 |
|         500 |     2.3 ms |              213,323 |       1.15 |       1.91 |       2.00 |       2.03 |
|        1000 |     4.2 ms |              236,676 |       2.11 |       3.25 |       3.34 |       3.41 |
|        5000 |    27.4 ms |              182,179 |      14.90 |      18.74 |      19.53 |      19.59 |
|       10000 |    48.5 ms |              206,046 |      24.83 |      37.53 |      38.14 |      38.40 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,447 |     3.92 |     5.58 |     6.73 |       6.87 |     6.87 |
|        5000 |   28.0 ms |            178,577 |    14.69 |    19.49 |    20.04 |      20.07 |    20.07 |
|       10000 |   51.9 ms |            192,860 |    25.00 |    39.91 |    41.62 |      41.70 |    41.71 |
|       25000 |  109.3 ms |            228,717 |    57.23 |    79.85 |    83.36 |      85.00 |    85.08 |
|       50000 |  215.2 ms |            232,390 |   114.74 |   171.35 |   180.78 |     182.21 |   182.36 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.7 ms |             73,166 |     6.95 |    10.40 |    12.09 |      12.44 |    12.44 |
|        5000 |   51.3 ms |             97,549 |    24.71 |    38.55 |    39.64 |      39.71 |    39.71 |
|       10000 |  104.8 ms |             95,424 |    53.24 |    85.78 |    88.41 |      88.43 |    88.44 |
|       25000 |  249.7 ms |            100,134 |   134.98 |   218.12 |   229.01 |     229.50 |   229.53 |
|       50000 |  486.6 ms |            102,745 |   267.41 |   410.49 |   450.59 |     451.82 |   451.91 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   27.3 ms |             36,564 |    15.14 |    24.25 |    26.23 |      26.45 |    26.45 |
|        5000 |  119.9 ms |             41,714 |    51.76 |    96.60 |   114.74 |     115.99 |   116.11 |
|       10000 |  212.3 ms |             47,104 |   101.92 |   184.86 |   204.77 |     206.57 |   206.86 |

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
  • Raw Worker IPC Round-Trip      : 0.0348 ms/op
  • End-to-End Runtime Task Cost    : 0.0437 ms/op
  • Scheduler + Graph Overhead     : 0.0089 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,682 |       0.41 |       0.44 |       0.44 |       0.44 |
|         100 |     0.8 ms |              132,389 |       0.36 |       0.61 |       0.65 |       0.65 |
|         500 |     2.3 ms |              213,323 |       1.15 |       1.91 |       2.00 |       2.03 |
|        1000 |     4.2 ms |              236,676 |       2.11 |       3.25 |       3.34 |       3.41 |
|        5000 |    27.4 ms |              182,179 |      14.90 |      18.74 |      19.53 |      19.59 |
|       10000 |    48.5 ms |              206,046 |      24.83 |      37.53 |      38.14 |      38.40 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.13 MB
  • V8/JSC Heap Used             : 0.78 MB

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
| 1 CPU + 1 IO  |       2 |   52.5 ms |            190,426 |    25.01 |    37.77 |    41.23 |    41.34 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   49.2 ms |            203,088 |    25.46 |    39.38 |    39.58 |    39.61 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   40.6 ms |            246,419 |    21.79 |    33.48 |    33.92 |    34.01 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   46.8 ms |            213,706 |    22.29 |    37.61 |    38.23 |    38.34 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 121.9 ms
  • Peak Throughput Rate       : 205,086 ops/sec
  • Latency Distribution       : p50: 63.51ms | p90: 98.49ms | p99: 100.04ms | p99.9: 100.30ms | Max: 100.31ms
  • Memory (RSS)               : Baseline: 98.3 MB | Peak: 128.5 MB | Cooldown: 101.7 MB

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
|        1000 |    8.7 ms |            115,447 |     3.92 |     5.58 |     6.73 |       6.87 |     6.87 |
|        5000 |   28.0 ms |            178,577 |    14.69 |    19.49 |    20.04 |      20.07 |    20.07 |
|       10000 |   51.9 ms |            192,860 |    25.00 |    39.91 |    41.62 |      41.70 |    41.71 |
|       25000 |  109.3 ms |            228,717 |    57.23 |    79.85 |    83.36 |      85.00 |    85.08 |
|       50000 |  215.2 ms |            232,390 |   114.74 |   171.35 |   180.78 |     182.21 |   182.36 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.7 ms |             73,166 |     6.95 |    10.40 |    12.09 |      12.44 |    12.44 |
|        5000 |   51.3 ms |             97,549 |    24.71 |    38.55 |    39.64 |      39.71 |    39.71 |
|       10000 |  104.8 ms |             95,424 |    53.24 |    85.78 |    88.41 |      88.43 |    88.44 |
|       25000 |  249.7 ms |            100,134 |   134.98 |   218.12 |   229.01 |     229.50 |   229.53 |
|       50000 |  486.6 ms |            102,745 |   267.41 |   410.49 |   450.59 |     451.82 |   451.91 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   27.3 ms |             36,564 |    15.14 |    24.25 |    26.23 |      26.45 |    26.45 |
|        5000 |  119.9 ms |             41,714 |    51.76 |    96.60 |   114.74 |     115.99 |   116.11 |
|       10000 |  212.3 ms |             47,104 |   101.92 |   184.86 |   204.77 |     206.57 |   206.86 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 121.1 MB
  • Settled Cooldown RSS   : 71.4 MB (Clean GC release)

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
| Yatta     |      39,937 |     1.00x |    18% | 2.23ms | 4.69ms | 5.06ms |
| Raw Bun   |      48,627 |     1.22x |    28% | 1.76ms | 2.94ms | 4.32ms |
| Hono      |      49,773 |     1.25x |    40% | 1.90ms | 3.36ms | 4.03ms |
| Elysia    |      44,518 |     1.11x |    29% | 2.21ms | 4.29ms | 4.63ms |
| Express   |      14,798 |     0.37x |     2% | 6.89ms | 10.06ms | 11.86ms |
| Fastify   |      18,575 |     0.47x |     5% | 4.60ms | 8.42ms | 9.51ms |
| Koa       |      15,240 |     0.38x |    12% | 6.39ms | 10.78ms | 12.19ms |

  Yatta dispatch adds about 4.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 18%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
