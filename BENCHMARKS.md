# Yatta Benchmarks

> Last run: `2026-10-18T01:08:12Z` · commit [`42db09d`](https://github.com/psrockstar098/yatta.js/commit/42db09dcb7f6ca4652233810aabe02e0b689e4fb) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 91.2 ms
  • End-to-End Runtime Task Cost    : 0.0268 ms/op
  • Peak RSS Memory        : 227.2 MB
  • RSS Heap Memory             : 80.01 MB
  • Raw Worker IPC Round-Trip      : 0.0247 ms/op
  • Scheduler + Graph Overhead     : 0.0021 ms/op
  • Settled Cooldown RSS   : 157.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.62 MB
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
| Yatta     |      59,796 |     1.00x |     8% | 1.69ms | 2.63ms | 3.05ms |
| Raw Bun   |      46,559 |     0.78x |    15% | 1.72ms | 3.79ms | 4.03ms |
| Hono      |      63,829 |     1.07x |     6% | 1.62ms | 2.11ms | 2.60ms |
| Elysia    |      53,688 |     0.90x |    10% | 1.63ms | 3.51ms | 4.25ms |
| Express   |      24,470 |     0.41x |    12% | 3.98ms | 6.95ms | 8.44ms |
| Fastify   |      33,358 |     0.56x |    17% | 2.83ms | 5.11ms | 6.31ms |
| Koa       |      24,317 |     0.41x |    23% | 3.71ms | 6.75ms | 8.28ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,086 |       0.26 |       0.28 |       0.28 |       0.28 |
|         100 |     0.5 ms |              194,886 |       0.20 |       0.28 |       0.30 |       0.30 |
|         500 |     1.5 ms |              337,453 |       0.66 |       1.11 |       1.18 |       1.21 |
|        1000 |     2.6 ms |              382,235 |       1.30 |       2.03 |       2.12 |       2.17 |
|        5000 |    16.6 ms |              300,587 |       8.99 |      11.22 |      11.74 |      11.75 |
|       10000 |    29.5 ms |              339,311 |      16.00 |      22.36 |      22.80 |      22.83 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.9 ms |            202,465 |     2.32 |     2.77 |     3.27 |       3.48 |     3.48 |
|        5000 |   18.0 ms |            277,172 |     8.57 |    12.07 |    12.47 |      12.49 |    12.49 |
|       10000 |   37.1 ms |            269,476 |    17.67 |    28.14 |    29.40 |      29.41 |    29.42 |
|       25000 |   84.0 ms |            297,621 |    40.74 |    63.09 |    67.25 |      67.27 |    67.27 |
|       50000 |  171.7 ms |            291,130 |    90.18 |   139.71 |   148.55 |     148.94 |   148.96 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,530 |     4.16 |     6.43 |     7.62 |       7.86 |     7.86 |
|        5000 |   35.3 ms |            141,551 |    17.07 |    27.34 |    28.12 |      28.13 |    28.13 |
|       10000 |   84.0 ms |            119,005 |    43.08 |    69.93 |    72.03 |      72.33 |    72.34 |
|       25000 |  187.4 ms |            133,397 |   101.31 |   161.26 |   172.05 |     172.30 |   172.33 |
|       50000 |  391.5 ms |            127,714 |   203.39 |   327.36 |   357.82 |     358.98 |   359.03 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.3 ms |             51,815 |    10.14 |    16.72 |    18.30 |      18.54 |    18.54 |
|        5000 |   94.7 ms |             52,800 |    41.23 |    84.90 |    91.58 |      92.75 |    92.86 |
|       10000 |  158.2 ms |             63,194 |    81.57 |   136.09 |   151.42 |     154.16 |   154.42 |

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
  • Raw Worker IPC Round-Trip      : 0.0247 ms/op
  • End-to-End Runtime Task Cost    : 0.0268 ms/op
  • Scheduler + Graph Overhead     : 0.0021 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,086 |       0.26 |       0.28 |       0.28 |       0.28 |
|         100 |     0.5 ms |              194,886 |       0.20 |       0.28 |       0.30 |       0.30 |
|         500 |     1.5 ms |              337,453 |       0.66 |       1.11 |       1.18 |       1.21 |
|        1000 |     2.6 ms |              382,235 |       1.30 |       2.03 |       2.12 |       2.17 |
|        5000 |    16.6 ms |              300,587 |       8.99 |      11.22 |      11.74 |      11.75 |
|       10000 |    29.5 ms |              339,311 |      16.00 |      22.36 |      22.80 |      22.83 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.01 MB
  • V8/JSC Heap Used             : 13.62 MB

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
| 1 CPU + 1 IO  |       2 |   42.7 ms |            234,221 |    21.19 |    33.93 |    34.30 |    34.45 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   38.7 ms |            258,345 |    19.35 |    31.22 |    31.63 |    31.65 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   27.8 ms |            359,677 |    11.99 |    21.59 |    22.12 |    22.19 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   30.5 ms |            328,194 |    14.93 |    24.61 |    24.79 |    24.81 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 91.2 ms
  • Peak Throughput Rate       : 274,011 ops/sec
  • Latency Distribution       : p50: 44.92ms | p90: 68.81ms | p99: 70.13ms | p99.9: 70.23ms | Max: 70.23ms
  • Memory (RSS)               : Baseline: 94.3 MB | Peak: 129.6 MB | Cooldown: 101.4 MB

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
|        1000 |    4.9 ms |            202,465 |     2.32 |     2.77 |     3.27 |       3.48 |     3.48 |
|        5000 |   18.0 ms |            277,172 |     8.57 |    12.07 |    12.47 |      12.49 |    12.49 |
|       10000 |   37.1 ms |            269,476 |    17.67 |    28.14 |    29.40 |      29.41 |    29.42 |
|       25000 |   84.0 ms |            297,621 |    40.74 |    63.09 |    67.25 |      67.27 |    67.27 |
|       50000 |  171.7 ms |            291,130 |    90.18 |   139.71 |   148.55 |     148.94 |   148.96 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            115,530 |     4.16 |     6.43 |     7.62 |       7.86 |     7.86 |
|        5000 |   35.3 ms |            141,551 |    17.07 |    27.34 |    28.12 |      28.13 |    28.13 |
|       10000 |   84.0 ms |            119,005 |    43.08 |    69.93 |    72.03 |      72.33 |    72.34 |
|       25000 |  187.4 ms |            133,397 |   101.31 |   161.26 |   172.05 |     172.30 |   172.33 |
|       50000 |  391.5 ms |            127,714 |   203.39 |   327.36 |   357.82 |     358.98 |   359.03 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.3 ms |             51,815 |    10.14 |    16.72 |    18.30 |      18.54 |    18.54 |
|        5000 |   94.7 ms |             52,800 |    41.23 |    84.90 |    91.58 |      92.75 |    92.86 |
|       10000 |  158.2 ms |             63,194 |    81.57 |   136.09 |   151.42 |     154.16 |   154.42 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 227.2 MB
  • Settled Cooldown RSS   : 157.6 MB (Clean GC release)

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
| Yatta     |      59,796 |     1.00x |     8% | 1.69ms | 2.63ms | 3.05ms |
| Raw Bun   |      46,559 |     0.78x |    15% | 1.72ms | 3.79ms | 4.03ms |
| Hono      |      63,829 |     1.07x |     6% | 1.62ms | 2.11ms | 2.60ms |
| Elysia    |      53,688 |     0.90x |    10% | 1.63ms | 3.51ms | 4.25ms |
| Express   |      24,470 |     0.41x |    12% | 3.98ms | 6.95ms | 8.44ms |
| Fastify   |      33,358 |     0.56x |    17% | 2.83ms | 5.11ms | 6.31ms |
| Koa       |      24,317 |     0.41x |    23% | 3.71ms | 6.75ms | 8.28ms |

  Yatta dispatch adds about -4.8µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
