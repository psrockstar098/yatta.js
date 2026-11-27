# Yatta Benchmarks

> Last run: `2026-11-24T16:49:55Z` · commit [`a9053d2`](https://github.com/psrockstar098/yatta.js/commit/a9053d2f437f9febf2bf6a1e0701ec10e40d4706) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 74.9 ms
  • End-to-End Runtime Task Cost    : 0.0235 ms/op
  • Peak RSS Memory        : 217.6 MB
  • RSS Heap Memory             : 95.74 MB
  • Raw Worker IPC Round-Trip      : 0.0181 ms/op
  • Scheduler + Graph Overhead     : 0.0054 ms/op
  • Settled Cooldown RSS   : 81.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.67 MB
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      63,689 |     1.00x |    14% | 1.52ms | 2.88ms | 3.42ms |
| Raw Bun   |      53,437 |     0.84x |    29% | 1.62ms | 3.32ms | 3.40ms |
| Hono      |      69,283 |     1.09x |    24% | 1.31ms | 1.83ms | 3.01ms |
| Elysia    |      60,104 |     0.94x |    22% | 1.34ms | 3.25ms | 3.60ms |
| Express   |      36,256 |     0.57x |     9% | 2.62ms | 4.63ms | 5.67ms |
| Fastify   |      49,090 |     0.77x |     5% | 2.04ms | 3.30ms | 4.78ms |
| Koa       |      42,161 |     0.66x |     4% | 2.39ms | 4.25ms | 6.34ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,173 |       0.28 |       0.31 |       0.31 |       0.31 |
|         100 |     0.4 ms |              280,447 |       0.16 |       0.26 |       0.28 |       0.28 |
|         500 |     1.3 ms |              394,904 |       0.60 |       0.83 |       0.87 |       0.88 |
|        1000 |     2.7 ms |              375,552 |       1.17 |       1.65 |       1.71 |       1.73 |
|        5000 |    15.8 ms |              315,500 |       8.20 |      11.48 |      11.53 |      11.55 |
|       10000 |    25.0 ms |              400,193 |      12.05 |      19.09 |      19.40 |      19.42 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.4 ms |            226,466 |     1.88 |     2.64 |     3.30 |       3.55 |     3.55 |
|        5000 |   14.6 ms |            341,456 |     5.74 |    10.28 |    10.84 |      10.84 |    10.84 |
|       10000 |   31.6 ms |            315,984 |    14.22 |    23.31 |    23.97 |      24.03 |    24.03 |
|       25000 |   65.3 ms |            382,806 |    32.58 |    51.21 |    53.61 |      53.95 |    54.00 |
|       50000 |  110.5 ms |            452,516 |    53.16 |    85.45 |    92.61 |      92.69 |    92.70 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.5 ms |            154,596 |     3.07 |     4.72 |     5.33 |       5.38 |     5.38 |
|        5000 |   28.1 ms |            177,705 |    12.85 |    22.57 |    23.32 |      23.35 |    23.35 |
|       10000 |   62.5 ms |            159,905 |    32.31 |    54.32 |    55.85 |      55.91 |    55.91 |
|       25000 |  177.3 ms |            141,013 |    90.88 |   153.46 |   164.07 |     164.51 |   164.53 |
|       50000 |  348.5 ms |            143,469 |   170.95 |   293.80 |   319.45 |     320.39 |   320.44 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.7 ms |             63,505 |     8.21 |    13.40 |    14.83 |      15.07 |    15.07 |
|        5000 |   58.7 ms |             85,137 |    30.40 |    51.47 |    56.05 |      56.97 |    57.06 |
|       10000 |  133.0 ms |             75,173 |    65.22 |   112.77 |   127.95 |     130.17 |   130.54 |

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
  • Raw Worker IPC Round-Trip      : 0.0181 ms/op
  • End-to-End Runtime Task Cost    : 0.0235 ms/op
  • Scheduler + Graph Overhead     : 0.0054 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,173 |       0.28 |       0.31 |       0.31 |       0.31 |
|         100 |     0.4 ms |              280,447 |       0.16 |       0.26 |       0.28 |       0.28 |
|         500 |     1.3 ms |              394,904 |       0.60 |       0.83 |       0.87 |       0.88 |
|        1000 |     2.7 ms |              375,552 |       1.17 |       1.65 |       1.71 |       1.73 |
|        5000 |    15.8 ms |              315,500 |       8.20 |      11.48 |      11.53 |      11.55 |
|       10000 |    25.0 ms |              400,193 |      12.05 |      19.09 |      19.40 |      19.42 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 95.74 MB
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
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   35.8 ms |            279,294 |    17.42 |    26.41 |    26.64 |    26.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   35.4 ms |            282,568 |    18.41 |    26.88 |    27.16 |    27.34 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   27.5 ms |            363,663 |    12.75 |    21.68 |    22.13 |    22.25 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   29.3 ms |            340,877 |    13.64 |    23.10 |    23.30 |    23.35 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 74.9 ms
  • Peak Throughput Rate       : 333,786 ops/sec
  • Latency Distribution       : p50: 39.11ms | p90: 60.46ms | p99: 61.90ms | p99.9: 61.94ms | Max: 61.94ms
  • Memory (RSS)               : Baseline: 100.2 MB | Peak: 130.6 MB | Cooldown: 64.5 MB

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
|        1000 |    4.4 ms |            226,466 |     1.88 |     2.64 |     3.30 |       3.55 |     3.55 |
|        5000 |   14.6 ms |            341,456 |     5.74 |    10.28 |    10.84 |      10.84 |    10.84 |
|       10000 |   31.6 ms |            315,984 |    14.22 |    23.31 |    23.97 |      24.03 |    24.03 |
|       25000 |   65.3 ms |            382,806 |    32.58 |    51.21 |    53.61 |      53.95 |    54.00 |
|       50000 |  110.5 ms |            452,516 |    53.16 |    85.45 |    92.61 |      92.69 |    92.70 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.5 ms |            154,596 |     3.07 |     4.72 |     5.33 |       5.38 |     5.38 |
|        5000 |   28.1 ms |            177,705 |    12.85 |    22.57 |    23.32 |      23.35 |    23.35 |
|       10000 |   62.5 ms |            159,905 |    32.31 |    54.32 |    55.85 |      55.91 |    55.91 |
|       25000 |  177.3 ms |            141,013 |    90.88 |   153.46 |   164.07 |     164.51 |   164.53 |
|       50000 |  348.5 ms |            143,469 |   170.95 |   293.80 |   319.45 |     320.39 |   320.44 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.7 ms |             63,505 |     8.21 |    13.40 |    14.83 |      15.07 |    15.07 |
|        5000 |   58.7 ms |             85,137 |    30.40 |    51.47 |    56.05 |      56.97 |    57.06 |
|       10000 |  133.0 ms |             75,173 |    65.22 |   112.77 |   127.95 |     130.17 |   130.54 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 217.6 MB
  • Settled Cooldown RSS   : 81.1 MB (Clean GC release)

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
| Yatta     |      63,689 |     1.00x |    14% | 1.52ms | 2.88ms | 3.42ms |
| Raw Bun   |      53,437 |     0.84x |    29% | 1.62ms | 3.32ms | 3.40ms |
| Hono      |      69,283 |     1.09x |    24% | 1.31ms | 1.83ms | 3.01ms |
| Elysia    |      60,104 |     0.94x |    22% | 1.34ms | 3.25ms | 3.60ms |
| Express   |      36,256 |     0.57x |     9% | 2.62ms | 4.63ms | 5.67ms |
| Fastify   |      49,090 |     0.77x |     5% | 2.04ms | 3.30ms | 4.78ms |
| Koa       |      42,161 |     0.66x |     4% | 2.39ms | 4.25ms | 6.34ms |

  Yatta dispatch adds about -3.0µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
