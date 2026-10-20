# Yatta Benchmarks

> Last run: `2026-10-20T16:28:43Z` · commit [`51c9b66`](https://github.com/psrockstar098/yatta.js/commit/51c9b66958baa6aedc860dd83237ea0ac9702622) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 71.3 ms
  • End-to-End Runtime Task Cost    : 0.0343 ms/op
  • Peak RSS Memory        : 214.0 MB
  • RSS Heap Memory             : 96.60 MB
  • Raw Worker IPC Round-Trip      : 0.0274 ms/op
  • Scheduler + Graph Overhead     : 0.0069 ms/op
  • Settled Cooldown RSS   : 161.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 12.82 MB
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
| Yatta     |      74,617 |     1.00x |    12% | 1.33ms | 2.19ms | 2.99ms |
| Raw Bun   |      96,780 |     1.30x |    17% | 1.10ms | 1.81ms | 2.27ms |
| Hono      |      78,243 |     1.05x |     4% | 1.23ms | 2.03ms | 2.42ms |
| Elysia    |      94,678 |     1.27x |    11% | 1.08ms | 1.65ms | 2.25ms |
| Express   |      30,589 |     0.41x |     7% | 3.00ms | 5.93ms | 6.82ms |
| Fastify   |      41,311 |     0.55x |     0% | 2.14ms | 4.14ms | 5.15ms |
| Koa       |      35,512 |     0.48x |     4% | 2.52ms | 4.74ms | 6.46ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,533 |       0.39 |       0.41 |       0.41 |       0.41 |
|         100 |     0.6 ms |              160,462 |       0.19 |       0.36 |       0.39 |       0.39 |
|         500 |     1.6 ms |              308,500 |       0.81 |       1.28 |       1.36 |       1.39 |
|        1000 |     2.9 ms |              346,412 |       1.53 |       2.28 |       2.37 |       2.40 |
|        5000 |    16.7 ms |              299,884 |       9.44 |      11.55 |      11.65 |      11.68 |
|       10000 |    29.2 ms |              342,050 |      15.99 |      23.70 |      23.77 |      23.79 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    5.7 ms |            176,597 |     2.69 |     3.70 |     4.52 |       4.71 |     4.71 |
|        5000 |   15.4 ms |            325,424 |     7.61 |     9.17 |     9.55 |       9.55 |     9.55 |
|       10000 |   34.4 ms |            290,999 |    16.89 |    25.59 |    26.17 |      26.20 |    26.20 |
|       25000 |   65.8 ms |            379,820 |    31.25 |    46.34 |    48.88 |      49.29 |    49.33 |
|       50000 |  120.8 ms |            413,944 |    61.54 |    91.54 |    98.31 |      98.53 |    98.54 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.0 ms |            111,243 |     4.54 |     6.54 |     6.96 |       7.08 |     7.08 |
|        5000 |   35.2 ms |            142,194 |    18.87 |    28.79 |    29.61 |      29.66 |    29.66 |
|       10000 |   80.9 ms |            123,672 |    40.97 |    67.11 |    68.96 |      69.01 |    69.01 |
|       25000 |  224.9 ms |            111,163 |   111.31 |   192.68 |   204.26 |     205.03 |   205.05 |
|       50000 |  404.2 ms |            123,710 |   221.86 |   330.42 |   352.33 |     355.72 |   355.82 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   28.1 ms |             35,647 |    15.29 |    23.69 |    25.49 |      25.65 |    25.65 |
|        5000 |  109.9 ms |             45,503 |    46.08 |    96.59 |   105.49 |     107.11 |   107.24 |
|       10000 |  202.3 ms |             49,436 |   101.22 |   171.42 |   194.29 |     197.44 |   197.75 |

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
  • Raw Worker IPC Round-Trip      : 0.0274 ms/op
  • End-to-End Runtime Task Cost    : 0.0343 ms/op
  • Scheduler + Graph Overhead     : 0.0069 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,533 |       0.39 |       0.41 |       0.41 |       0.41 |
|         100 |     0.6 ms |              160,462 |       0.19 |       0.36 |       0.39 |       0.39 |
|         500 |     1.6 ms |              308,500 |       0.81 |       1.28 |       1.36 |       1.39 |
|        1000 |     2.9 ms |              346,412 |       1.53 |       2.28 |       2.37 |       2.40 |
|        5000 |    16.7 ms |              299,884 |       9.44 |      11.55 |      11.65 |      11.68 |
|       10000 |    29.2 ms |              342,050 |      15.99 |      23.70 |      23.77 |      23.79 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.60 MB
  • V8/JSC Heap Used             : 12.82 MB

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
| 1 CPU + 1 IO  |       2 |   35.6 ms |            280,646 |    17.11 |    28.35 |    28.76 |    28.89 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   29.7 ms |            337,195 |    14.86 |    20.65 |    21.50 |    21.63 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   26.5 ms |            377,429 |    11.84 |    20.06 |    20.25 |    20.28 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   21.1 ms |            474,068 |    11.21 |    16.62 |    16.64 |    16.65 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 71.3 ms
  • Peak Throughput Rate       : 350,704 ops/sec
  • Latency Distribution       : p50: 33.12ms | p90: 53.76ms | p99: 55.32ms | p99.9: 55.39ms | Max: 55.40ms
  • Memory (RSS)               : Baseline: 101.4 MB | Peak: 133.4 MB | Cooldown: 102.6 MB

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
|        1000 |    5.7 ms |            176,597 |     2.69 |     3.70 |     4.52 |       4.71 |     4.71 |
|        5000 |   15.4 ms |            325,424 |     7.61 |     9.17 |     9.55 |       9.55 |     9.55 |
|       10000 |   34.4 ms |            290,999 |    16.89 |    25.59 |    26.17 |      26.20 |    26.20 |
|       25000 |   65.8 ms |            379,820 |    31.25 |    46.34 |    48.88 |      49.29 |    49.33 |
|       50000 |  120.8 ms |            413,944 |    61.54 |    91.54 |    98.31 |      98.53 |    98.54 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.0 ms |            111,243 |     4.54 |     6.54 |     6.96 |       7.08 |     7.08 |
|        5000 |   35.2 ms |            142,194 |    18.87 |    28.79 |    29.61 |      29.66 |    29.66 |
|       10000 |   80.9 ms |            123,672 |    40.97 |    67.11 |    68.96 |      69.01 |    69.01 |
|       25000 |  224.9 ms |            111,163 |   111.31 |   192.68 |   204.26 |     205.03 |   205.05 |
|       50000 |  404.2 ms |            123,710 |   221.86 |   330.42 |   352.33 |     355.72 |   355.82 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   28.1 ms |             35,647 |    15.29 |    23.69 |    25.49 |      25.65 |    25.65 |
|        5000 |  109.9 ms |             45,503 |    46.08 |    96.59 |   105.49 |     107.11 |   107.24 |
|       10000 |  202.3 ms |             49,436 |   101.22 |   171.42 |   194.29 |     197.44 |   197.75 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 214.0 MB
  • Settled Cooldown RSS   : 161.4 MB (Clean GC release)

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
| Yatta     |      74,617 |     1.00x |    12% | 1.33ms | 2.19ms | 2.99ms |
| Raw Bun   |      96,780 |     1.30x |    17% | 1.10ms | 1.81ms | 2.27ms |
| Hono      |      78,243 |     1.05x |     4% | 1.23ms | 2.03ms | 2.42ms |
| Elysia    |      94,678 |     1.27x |    11% | 1.08ms | 1.65ms | 2.25ms |
| Express   |      30,589 |     0.41x |     7% | 3.00ms | 5.93ms | 6.82ms |
| Fastify   |      41,311 |     0.55x |     0% | 2.14ms | 4.14ms | 5.15ms |
| Koa       |      35,512 |     0.48x |     4% | 2.52ms | 4.74ms | 6.46ms |

  Yatta dispatch adds about 3.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
