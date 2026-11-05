# Yatta Benchmarks

> Last run: `2026-11-05T15:05:19Z` · commit [`a6d8b82`](https://github.com/psrockstar098/yatta.js/commit/a6d8b82250639f131b63860f47963375143a91d6) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 107.2 ms
  • End-to-End Runtime Task Cost    : 0.0286 ms/op
  • Peak RSS Memory        : 188.5 MB
  • RSS Heap Memory             : 82.58 MB
  • Raw Worker IPC Round-Trip      : 0.0242 ms/op
  • Scheduler + Graph Overhead     : 0.0044 ms/op
  • Settled Cooldown RSS   : 95.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.87 MB
  • Worker Fleet Event Loop Lag : 10.16 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      60,739 |     1.00x |     5% | 1.70ms | 2.71ms | 3.27ms |
| Raw Bun   |      47,952 |     0.79x |     9% | 1.85ms | 3.91ms | 4.37ms |
| Hono      |      59,912 |     0.99x |     5% | 1.64ms | 2.72ms | 3.74ms |
| Elysia    |      55,365 |     0.91x |    20% | 1.68ms | 3.45ms | 4.00ms |
| Express   |      21,658 |     0.36x |     8% | 4.39ms | 7.51ms | 9.27ms |
| Fastify   |      30,845 |     0.51x |     6% | 2.74ms | 5.44ms | 6.62ms |
| Koa       |      24,421 |     0.40x |    15% | 4.07ms | 7.00ms | 8.41ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,886 |       0.29 |       0.31 |       0.31 |       0.31 |
|         100 |     0.5 ms |              208,961 |       0.23 |       0.35 |       0.38 |       0.38 |
|         500 |     1.7 ms |              299,607 |       0.83 |       1.23 |       1.28 |       1.30 |
|        1000 |     3.0 ms |              334,721 |       1.52 |       2.15 |       2.19 |       2.20 |
|        5000 |    25.6 ms |              195,442 |      14.03 |      20.05 |      20.15 |      20.19 |
|       10000 |    50.8 ms |              196,738 |      28.28 |      42.89 |      43.19 |      43.23 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.6 ms |            132,174 |     3.43 |     4.75 |     5.77 |       5.86 |     5.86 |
|        5000 |   27.5 ms |            181,860 |    15.06 |    19.97 |    20.47 |      20.47 |    20.47 |
|       10000 |   56.6 ms |            176,643 |    28.88 |    41.97 |    44.77 |      45.31 |    45.33 |
|       25000 |  126.9 ms |            196,977 |    61.53 |    95.84 |    99.88 |     100.20 |   100.25 |
|       50000 |  193.9 ms |            257,906 |   100.32 |   153.17 |   164.22 |     164.36 |   164.37 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.6 ms |             86,344 |     6.27 |     8.64 |     9.38 |       9.50 |     9.50 |
|        5000 |   48.4 ms |            103,256 |    25.05 |    39.13 |    40.02 |      40.06 |    40.07 |
|       10000 |   84.4 ms |            118,453 |    43.95 |    70.19 |    72.16 |      72.29 |    72.30 |
|       25000 |  236.9 ms |            105,537 |   128.21 |   201.39 |   212.44 |     213.69 |   213.93 |
|       50000 |  473.8 ms |            105,540 |   290.19 |   401.57 |   424.88 |     425.39 |   425.48 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.3 ms |             57,670 |    10.05 |    14.99 |    16.20 |      16.37 |    16.37 |
|        5000 |   72.5 ms |             68,932 |    36.95 |    62.43 |    67.92 |      68.48 |    68.59 |
|       10000 |  155.3 ms |             64,379 |    73.57 |   135.88 |   147.73 |     150.11 |   150.34 |

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
  • Raw Worker IPC Round-Trip      : 0.0242 ms/op
  • End-to-End Runtime Task Cost    : 0.0286 ms/op
  • Scheduler + Graph Overhead     : 0.0044 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,886 |       0.29 |       0.31 |       0.31 |       0.31 |
|         100 |     0.5 ms |              208,961 |       0.23 |       0.35 |       0.38 |       0.38 |
|         500 |     1.7 ms |              299,607 |       0.83 |       1.23 |       1.28 |       1.30 |
|        1000 |     3.0 ms |              334,721 |       1.52 |       2.15 |       2.19 |       2.20 |
|        5000 |    25.6 ms |              195,442 |      14.03 |      20.05 |      20.15 |      20.19 |
|       10000 |    50.8 ms |              196,738 |      28.28 |      42.89 |      43.19 |      43.23 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.16 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 82.58 MB
  • V8/JSC Heap Used             : 13.87 MB

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
| 1 CPU + 1 IO  |       2 |   44.8 ms |            223,322 |    21.73 |    35.10 |    35.61 |    35.67 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   46.7 ms |            214,246 |    25.15 |    37.30 |    37.40 |    37.41 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.6 ms |            280,767 |    16.52 |    28.83 |    29.08 |    29.14 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   43.8 ms |            228,148 |    23.72 |    37.45 |    37.55 |    37.59 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 107.2 ms
  • Peak Throughput Rate       : 233,225 ops/sec
  • Latency Distribution       : p50: 60.29ms | p90: 85.64ms | p99: 87.71ms | p99.9: 88.33ms | Max: 88.43ms
  • Memory (RSS)               : Baseline: 102.0 MB | Peak: 132.6 MB | Cooldown: 103.7 MB

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
|        1000 |    7.6 ms |            132,174 |     3.43 |     4.75 |     5.77 |       5.86 |     5.86 |
|        5000 |   27.5 ms |            181,860 |    15.06 |    19.97 |    20.47 |      20.47 |    20.47 |
|       10000 |   56.6 ms |            176,643 |    28.88 |    41.97 |    44.77 |      45.31 |    45.33 |
|       25000 |  126.9 ms |            196,977 |    61.53 |    95.84 |    99.88 |     100.20 |   100.25 |
|       50000 |  193.9 ms |            257,906 |   100.32 |   153.17 |   164.22 |     164.36 |   164.37 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.6 ms |             86,344 |     6.27 |     8.64 |     9.38 |       9.50 |     9.50 |
|        5000 |   48.4 ms |            103,256 |    25.05 |    39.13 |    40.02 |      40.06 |    40.07 |
|       10000 |   84.4 ms |            118,453 |    43.95 |    70.19 |    72.16 |      72.29 |    72.30 |
|       25000 |  236.9 ms |            105,537 |   128.21 |   201.39 |   212.44 |     213.69 |   213.93 |
|       50000 |  473.8 ms |            105,540 |   290.19 |   401.57 |   424.88 |     425.39 |   425.48 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.3 ms |             57,670 |    10.05 |    14.99 |    16.20 |      16.37 |    16.37 |
|        5000 |   72.5 ms |             68,932 |    36.95 |    62.43 |    67.92 |      68.48 |    68.59 |
|       10000 |  155.3 ms |             64,379 |    73.57 |   135.88 |   147.73 |     150.11 |   150.34 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 188.5 MB
  • Settled Cooldown RSS   : 95.4 MB (Clean GC release)

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
| Yatta     |      60,739 |     1.00x |     5% | 1.70ms | 2.71ms | 3.27ms |
| Raw Bun   |      47,952 |     0.79x |     9% | 1.85ms | 3.91ms | 4.37ms |
| Hono      |      59,912 |     0.99x |     5% | 1.64ms | 2.72ms | 3.74ms |
| Elysia    |      55,365 |     0.91x |    20% | 1.68ms | 3.45ms | 4.00ms |
| Express   |      21,658 |     0.36x |     8% | 4.39ms | 7.51ms | 9.27ms |
| Fastify   |      30,845 |     0.51x |     6% | 2.74ms | 5.44ms | 6.62ms |
| Koa       |      24,421 |     0.40x |    15% | 4.07ms | 7.00ms | 8.41ms |

  Yatta dispatch adds about -4.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
