# Yatta Benchmarks

> Last run: `2026-11-05T04:15:40Z` · commit [`6ccce8b`](https://github.com/psrockstar098/yatta.js/commit/6ccce8bcd5a5007d2ae380c46b266c3707afd2ce) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 68.4 ms
  • End-to-End Runtime Task Cost    : 0.0213 ms/op
  • Peak RSS Memory        : 200.9 MB
  • RSS Heap Memory             : 87.79 MB
  • Raw Worker IPC Round-Trip      : 0.0214 ms/op
  • Scheduler + Graph Overhead     : -0.0001 ms/op
  • Settled Cooldown RSS   : 76.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.18 MB
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      63,561 |     1.00x |    48% | 1.65ms | 3.46ms | 3.52ms |
| Raw Bun   |      51,750 |     0.81x |    10% | 1.50ms | 2.97ms | 3.24ms |
| Hono      |      57,084 |     0.90x |     5% | 1.55ms | 3.31ms | 3.58ms |
| Elysia    |      56,809 |     0.89x |     5% | 1.48ms | 2.91ms | 3.20ms |
| Express   |      41,070 |     0.65x |     7% | 2.54ms | 4.72ms | 7.12ms |
| Fastify   |      50,641 |     0.80x |     9% | 2.12ms | 3.30ms | 5.06ms |
| Koa       |      45,858 |     0.72x |     1% | 2.05ms | 3.84ms | 5.36ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,556 |       0.27 |       0.29 |       0.29 |       0.29 |
|         100 |     0.5 ms |              214,105 |       0.22 |       0.36 |       0.38 |       0.38 |
|         500 |     1.2 ms |              406,904 |       0.71 |       1.00 |       1.03 |       1.05 |
|        1000 |     2.1 ms |              467,039 |       1.08 |       1.69 |       1.76 |       1.77 |
|        5000 |    13.1 ms |              380,917 |       6.99 |       9.09 |       9.29 |       9.30 |
|       10000 |    23.4 ms |              427,405 |      12.12 |      17.60 |      17.74 |      17.75 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    5.0 ms |            199,612 |     2.11 |     2.71 |     3.75 |       3.96 |     3.96 |
|        5000 |   12.8 ms |            389,127 |     5.50 |     7.35 |     8.00 |       8.07 |     8.08 |
|       10000 |   29.5 ms |            339,311 |    13.96 |    21.50 |    23.15 |      23.19 |    23.19 |
|       25000 |   57.6 ms |            433,751 |    26.77 |    43.68 |    45.43 |      45.47 |    45.47 |
|       50000 |  123.1 ms |            406,092 |    61.07 |    98.87 |   105.64 |     105.95 |   105.95 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.6 ms |            131,807 |     3.47 |     5.46 |     6.50 |       6.60 |     6.60 |
|        5000 |   30.3 ms |            164,848 |    15.83 |    22.11 |    22.73 |      22.76 |    22.76 |
|       10000 |   61.7 ms |            162,193 |    30.76 |    49.94 |    52.09 |      52.25 |    52.26 |
|       25000 |  154.6 ms |            161,725 |    74.51 |   129.97 |   139.78 |     140.10 |   140.12 |
|       50000 |  305.8 ms |            163,517 |   160.21 |   253.66 |   282.70 |     283.43 |   283.50 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   44.5 ms |             22,465 |    20.37 |    39.58 |    41.43 |      41.62 |    41.62 |
|        5000 |   64.9 ms |             77,094 |    31.92 |    56.73 |    61.66 |      63.14 |    63.26 |
|       10000 |  126.6 ms |             78,976 |    57.21 |   108.52 |   121.35 |     123.27 |   123.46 |

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
  • Raw Worker IPC Round-Trip      : 0.0214 ms/op
  • End-to-End Runtime Task Cost    : 0.0213 ms/op
  • Scheduler + Graph Overhead     : -0.0001 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,556 |       0.27 |       0.29 |       0.29 |       0.29 |
|         100 |     0.5 ms |              214,105 |       0.22 |       0.36 |       0.38 |       0.38 |
|         500 |     1.2 ms |              406,904 |       0.71 |       1.00 |       1.03 |       1.05 |
|        1000 |     2.1 ms |              467,039 |       1.08 |       1.69 |       1.76 |       1.77 |
|        5000 |    13.1 ms |              380,917 |       6.99 |       9.09 |       9.29 |       9.30 |
|       10000 |    23.4 ms |              427,405 |      12.12 |      17.60 |      17.74 |      17.75 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 87.79 MB
  • V8/JSC Heap Used             : 13.18 MB

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
| 1 CPU + 1 IO  |       2 |   29.1 ms |            343,454 |    12.37 |    22.53 |    23.23 |    23.31 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   25.0 ms |            400,072 |    12.62 |    18.48 |    18.61 |    18.63 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   20.4 ms |            489,317 |     9.48 |    16.96 |    17.18 |    17.22 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   23.1 ms |            432,210 |    12.18 |    16.61 |    16.68 |    16.69 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 68.4 ms
  • Peak Throughput Rate       : 365,515 ops/sec
  • Latency Distribution       : p50: 31.77ms | p90: 55.55ms | p99: 56.76ms | p99.9: 56.78ms | Max: 56.78ms
  • Memory (RSS)               : Baseline: 103.0 MB | Peak: 134.0 MB | Cooldown: 73.1 MB

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
|        1000 |    5.0 ms |            199,612 |     2.11 |     2.71 |     3.75 |       3.96 |     3.96 |
|        5000 |   12.8 ms |            389,127 |     5.50 |     7.35 |     8.00 |       8.07 |     8.08 |
|       10000 |   29.5 ms |            339,311 |    13.96 |    21.50 |    23.15 |      23.19 |    23.19 |
|       25000 |   57.6 ms |            433,751 |    26.77 |    43.68 |    45.43 |      45.47 |    45.47 |
|       50000 |  123.1 ms |            406,092 |    61.07 |    98.87 |   105.64 |     105.95 |   105.95 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.6 ms |            131,807 |     3.47 |     5.46 |     6.50 |       6.60 |     6.60 |
|        5000 |   30.3 ms |            164,848 |    15.83 |    22.11 |    22.73 |      22.76 |    22.76 |
|       10000 |   61.7 ms |            162,193 |    30.76 |    49.94 |    52.09 |      52.25 |    52.26 |
|       25000 |  154.6 ms |            161,725 |    74.51 |   129.97 |   139.78 |     140.10 |   140.12 |
|       50000 |  305.8 ms |            163,517 |   160.21 |   253.66 |   282.70 |     283.43 |   283.50 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   44.5 ms |             22,465 |    20.37 |    39.58 |    41.43 |      41.62 |    41.62 |
|        5000 |   64.9 ms |             77,094 |    31.92 |    56.73 |    61.66 |      63.14 |    63.26 |
|       10000 |  126.6 ms |             78,976 |    57.21 |   108.52 |   121.35 |     123.27 |   123.46 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 200.9 MB
  • Settled Cooldown RSS   : 76.9 MB (Clean GC release)

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
| Yatta     |      63,561 |     1.00x |    48% | 1.65ms | 3.46ms | 3.52ms |
| Raw Bun   |      51,750 |     0.81x |    10% | 1.50ms | 2.97ms | 3.24ms |
| Hono      |      57,084 |     0.90x |     5% | 1.55ms | 3.31ms | 3.58ms |
| Elysia    |      56,809 |     0.89x |     5% | 1.48ms | 2.91ms | 3.20ms |
| Express   |      41,070 |     0.65x |     7% | 2.54ms | 4.72ms | 7.12ms |
| Fastify   |      50,641 |     0.80x |     9% | 2.12ms | 3.30ms | 5.06ms |
| Koa       |      45,858 |     0.72x |     1% | 2.05ms | 3.84ms | 5.36ms |

  Yatta dispatch adds about -3.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 48%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
