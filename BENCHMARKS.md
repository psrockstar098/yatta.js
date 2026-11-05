# Yatta Benchmarks

> Last run: `2026-11-05T03:00:17Z` · commit [`88a0709`](https://github.com/psrockstar098/yatta.js/commit/88a0709d8d7395839bcadf9d6709b3b6901fed89) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 111.0 ms
  • End-to-End Runtime Task Cost    : 0.0425 ms/op
  • Peak RSS Memory        : 141.5 MB
  • RSS Heap Memory             : 81.07 MB
  • Raw Worker IPC Round-Trip      : 0.0337 ms/op
  • Scheduler + Graph Overhead     : 0.0088 ms/op
  • Settled Cooldown RSS   : 92.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 11.02 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      45,738 |     1.00x |    10% | 2.12ms | 3.76ms | 4.65ms |
| Raw Bun   |      42,463 |     0.93x |    23% | 1.83ms | 4.53ms | 4.84ms |
| Hono      |      48,106 |     1.05x |    27% | 1.96ms | 3.42ms | 4.24ms |
| Elysia    |      47,835 |     1.05x |    13% | 1.80ms | 3.78ms | 4.75ms |
| Express   |      14,444 |     0.32x |    17% | 6.88ms | 10.85ms | 12.57ms |
| Fastify   |      19,718 |     0.43x |    13% | 4.25ms | 8.17ms | 9.25ms |
| Koa       |      15,921 |     0.35x |     6% | 5.51ms | 10.51ms | 12.48ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,633 |       0.33 |       0.36 |       0.36 |       0.36 |
|         100 |     0.9 ms |              109,869 |       0.29 |       0.44 |       0.50 |       0.50 |
|         500 |     2.1 ms |              233,589 |       1.02 |       1.65 |       1.72 |       1.77 |
|        1000 |     3.9 ms |              258,446 |       2.05 |       3.14 |       3.28 |       3.32 |
|        5000 |    25.7 ms |              194,324 |      12.65 |      17.47 |      17.54 |      17.55 |
|       10000 |    52.8 ms |              189,306 |      25.53 |      39.20 |      42.90 |      42.92 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.6 ms |            116,712 |     3.91 |     5.46 |     6.76 |       6.87 |     6.87 |
|        5000 |   21.6 ms |            231,346 |    10.58 |    13.94 |    14.51 |      14.57 |    14.57 |
|       10000 |   51.9 ms |            192,517 |    28.18 |    40.49 |    41.19 |      41.21 |    41.21 |
|       25000 |   99.5 ms |            251,307 |    50.19 |    72.85 |    77.27 |      77.50 |    77.51 |
|       50000 |  193.0 ms |            259,089 |    96.86 |   149.49 |   158.39 |     158.91 |   158.92 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.1 ms |             76,211 |     6.55 |     9.82 |    11.55 |      11.77 |    11.77 |
|        5000 |   51.4 ms |             97,318 |    25.58 |    38.87 |    39.82 |      39.88 |    39.89 |
|       10000 |   98.4 ms |            101,620 |    52.81 |    81.74 |    85.02 |      85.13 |    85.14 |
|       25000 |  243.1 ms |            102,844 |   129.71 |   214.81 |   225.73 |     226.03 |   226.06 |
|       50000 |  453.8 ms |            110,177 |   219.71 |   375.94 |   411.75 |     412.74 |   412.81 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.6 ms |             40,652 |    13.17 |    21.25 |    23.34 |      23.61 |    23.61 |
|        5000 |   98.3 ms |             50,848 |    54.15 |    87.13 |    94.82 |      96.21 |    96.32 |
|       10000 |  215.0 ms |             46,515 |    96.71 |   189.17 |   206.44 |     207.96 |   208.12 |

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
  • Raw Worker IPC Round-Trip      : 0.0337 ms/op
  • End-to-End Runtime Task Cost    : 0.0425 ms/op
  • Scheduler + Graph Overhead     : 0.0088 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,633 |       0.33 |       0.36 |       0.36 |       0.36 |
|         100 |     0.9 ms |              109,869 |       0.29 |       0.44 |       0.50 |       0.50 |
|         500 |     2.1 ms |              233,589 |       1.02 |       1.65 |       1.72 |       1.77 |
|        1000 |     3.9 ms |              258,446 |       2.05 |       3.14 |       3.28 |       3.32 |
|        5000 |    25.7 ms |              194,324 |      12.65 |      17.47 |      17.54 |      17.55 |
|       10000 |    52.8 ms |              189,306 |      25.53 |      39.20 |      42.90 |      42.92 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 11.02 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 81.07 MB
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
| 1 CPU + 1 IO  |       2 |   48.6 ms |            205,949 |    22.32 |    36.36 |    37.00 |    37.06 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.4 ms |            230,223 |    21.32 |    33.27 |    33.39 |    33.51 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   47.5 ms |            210,739 |    21.59 |    39.73 |    40.40 |    40.56 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   39.6 ms |            252,691 |    17.77 |    31.74 |    31.99 |    32.02 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 111.0 ms
  • Peak Throughput Rate       : 225,286 ops/sec
  • Latency Distribution       : p50: 55.30ms | p90: 86.69ms | p99: 89.22ms | p99.9: 89.30ms | Max: 89.34ms
  • Memory (RSS)               : Baseline: 103.4 MB | Peak: 129.6 MB | Cooldown: 102.8 MB

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
|        1000 |    8.6 ms |            116,712 |     3.91 |     5.46 |     6.76 |       6.87 |     6.87 |
|        5000 |   21.6 ms |            231,346 |    10.58 |    13.94 |    14.51 |      14.57 |    14.57 |
|       10000 |   51.9 ms |            192,517 |    28.18 |    40.49 |    41.19 |      41.21 |    41.21 |
|       25000 |   99.5 ms |            251,307 |    50.19 |    72.85 |    77.27 |      77.50 |    77.51 |
|       50000 |  193.0 ms |            259,089 |    96.86 |   149.49 |   158.39 |     158.91 |   158.92 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.1 ms |             76,211 |     6.55 |     9.82 |    11.55 |      11.77 |    11.77 |
|        5000 |   51.4 ms |             97,318 |    25.58 |    38.87 |    39.82 |      39.88 |    39.89 |
|       10000 |   98.4 ms |            101,620 |    52.81 |    81.74 |    85.02 |      85.13 |    85.14 |
|       25000 |  243.1 ms |            102,844 |   129.71 |   214.81 |   225.73 |     226.03 |   226.06 |
|       50000 |  453.8 ms |            110,177 |   219.71 |   375.94 |   411.75 |     412.74 |   412.81 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.6 ms |             40,652 |    13.17 |    21.25 |    23.34 |      23.61 |    23.61 |
|        5000 |   98.3 ms |             50,848 |    54.15 |    87.13 |    94.82 |      96.21 |    96.32 |
|       10000 |  215.0 ms |             46,515 |    96.71 |   189.17 |   206.44 |     207.96 |   208.12 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 141.5 MB
  • Settled Cooldown RSS   : 92.6 MB (Clean GC release)

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
| Yatta     |      45,738 |     1.00x |    10% | 2.12ms | 3.76ms | 4.65ms |
| Raw Bun   |      42,463 |     0.93x |    23% | 1.83ms | 4.53ms | 4.84ms |
| Hono      |      48,106 |     1.05x |    27% | 1.96ms | 3.42ms | 4.24ms |
| Elysia    |      47,835 |     1.05x |    13% | 1.80ms | 3.78ms | 4.75ms |
| Express   |      14,444 |     0.32x |    17% | 6.88ms | 10.85ms | 12.57ms |
| Fastify   |      19,718 |     0.43x |    13% | 4.25ms | 8.17ms | 9.25ms |
| Koa       |      15,921 |     0.35x |     6% | 5.51ms | 10.51ms | 12.48ms |

  Yatta dispatch adds about -1.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
