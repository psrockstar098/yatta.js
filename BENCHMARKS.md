# Yatta Benchmarks

> Last run: `2026-10-11T12:28:06Z` · commit [`3ee5bf1`](https://github.com/psrockstar098/yatta.js/commit/3ee5bf1cd21ef4b487a159303a6008ecd11aa722) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 62.7 ms
  • End-to-End Runtime Task Cost    : 0.0205 ms/op
  • Peak RSS Memory        : 231.3 MB
  • RSS Heap Memory             : 93.81 MB
  • Raw Worker IPC Round-Trip      : 0.0159 ms/op
  • Scheduler + Graph Overhead     : 0.0046 ms/op
  • Settled Cooldown RSS   : 80.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.67 MB
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
| Yatta     |      70,256 |     1.00x |    16% | 1.32ms | 2.60ms | 3.14ms |
| Raw Bun   |      57,999 |     0.83x |     3% | 1.48ms | 3.12ms | 3.21ms |
| Hono      |      61,528 |     0.88x |    20% | 1.30ms | 2.68ms | 3.09ms |
| Elysia    |      57,344 |     0.82x |    17% | 1.31ms | 3.04ms | 3.24ms |
| Express   |      42,464 |     0.60x |     4% | 2.40ms | 3.60ms | 5.81ms |
| Fastify   |      56,665 |     0.81x |     9% | 1.71ms | 2.89ms | 3.90ms |
| Koa       |      44,895 |     0.64x |    17% | 1.97ms | 3.94ms | 6.02ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               22,472 |       0.20 |       0.22 |       0.22 |       0.22 |
|         100 |     0.3 ms |              314,050 |       0.12 |       0.21 |       0.22 |       0.22 |
|         500 |     1.0 ms |              520,750 |       0.47 |       0.73 |       0.76 |       0.78 |
|        1000 |     1.9 ms |              535,266 |       0.92 |       1.45 |       1.50 |       1.51 |
|        5000 |    13.2 ms |              378,495 |       7.12 |       9.47 |       9.48 |       9.49 |
|       10000 |    24.9 ms |              402,407 |      11.59 |      19.79 |      20.08 |      20.15 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.5 ms |            221,930 |     1.89 |     2.91 |     3.63 |       3.72 |     3.72 |
|        5000 |   13.4 ms |            373,340 |     6.73 |     8.88 |     9.22 |       9.23 |     9.23 |
|       10000 |   27.2 ms |            367,260 |    12.80 |    19.84 |    21.05 |      21.06 |    21.06 |
|       25000 |   64.4 ms |            388,254 |    34.43 |    50.09 |    52.98 |      52.99 |    52.99 |
|       50000 |  114.0 ms |            438,415 |    56.11 |    89.02 |    95.85 |      96.15 |    96.16 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.7 ms |            149,489 |     3.32 |     4.95 |     5.65 |       5.75 |     5.75 |
|        5000 |   29.6 ms |            169,179 |    14.65 |    23.53 |    24.23 |      24.28 |    24.28 |
|       10000 |   54.1 ms |            184,914 |    30.35 |    44.18 |    46.08 |      46.40 |    46.41 |
|       25000 |  155.7 ms |            160,531 |    77.22 |   136.30 |   144.52 |     144.84 |   144.86 |
|       50000 |  324.9 ms |            153,892 |   169.21 |   274.87 |   302.58 |     303.54 |   303.59 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.0 ms |             62,315 |     8.52 |    13.87 |    15.21 |      15.43 |    15.43 |
|        5000 |   64.4 ms |             77,607 |    32.34 |    57.01 |    62.62 |      63.16 |    63.25 |
|       10000 |  150.0 ms |             66,651 |    76.81 |   131.37 |   144.81 |     146.90 |   147.11 |

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
  • Raw Worker IPC Round-Trip      : 0.0159 ms/op
  • End-to-End Runtime Task Cost    : 0.0205 ms/op
  • Scheduler + Graph Overhead     : 0.0046 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               22,472 |       0.20 |       0.22 |       0.22 |       0.22 |
|         100 |     0.3 ms |              314,050 |       0.12 |       0.21 |       0.22 |       0.22 |
|         500 |     1.0 ms |              520,750 |       0.47 |       0.73 |       0.76 |       0.78 |
|        1000 |     1.9 ms |              535,266 |       0.92 |       1.45 |       1.50 |       1.51 |
|        5000 |    13.2 ms |              378,495 |       7.12 |       9.47 |       9.48 |       9.49 |
|       10000 |    24.9 ms |              402,407 |      11.59 |      19.79 |      20.08 |      20.15 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.81 MB
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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   27.6 ms |            362,048 |    12.94 |    21.72 |    22.09 |    22.17 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   25.6 ms |            390,338 |    12.40 |    20.14 |    20.26 |    20.27 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   22.5 ms |            445,163 |    10.84 |    17.33 |    18.06 |    18.42 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   21.0 ms |            477,215 |    10.77 |    15.58 |    15.73 |    15.75 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 62.7 ms
  • Peak Throughput Rate       : 398,485 ops/sec
  • Latency Distribution       : p50: 29.20ms | p90: 49.66ms | p99: 50.51ms | p99.9: 50.63ms | Max: 50.63ms
  • Memory (RSS)               : Baseline: 99.0 MB | Peak: 130.2 MB | Cooldown: 60.8 MB

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
|        1000 |    4.5 ms |            221,930 |     1.89 |     2.91 |     3.63 |       3.72 |     3.72 |
|        5000 |   13.4 ms |            373,340 |     6.73 |     8.88 |     9.22 |       9.23 |     9.23 |
|       10000 |   27.2 ms |            367,260 |    12.80 |    19.84 |    21.05 |      21.06 |    21.06 |
|       25000 |   64.4 ms |            388,254 |    34.43 |    50.09 |    52.98 |      52.99 |    52.99 |
|       50000 |  114.0 ms |            438,415 |    56.11 |    89.02 |    95.85 |      96.15 |    96.16 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.7 ms |            149,489 |     3.32 |     4.95 |     5.65 |       5.75 |     5.75 |
|        5000 |   29.6 ms |            169,179 |    14.65 |    23.53 |    24.23 |      24.28 |    24.28 |
|       10000 |   54.1 ms |            184,914 |    30.35 |    44.18 |    46.08 |      46.40 |    46.41 |
|       25000 |  155.7 ms |            160,531 |    77.22 |   136.30 |   144.52 |     144.84 |   144.86 |
|       50000 |  324.9 ms |            153,892 |   169.21 |   274.87 |   302.58 |     303.54 |   303.59 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.0 ms |             62,315 |     8.52 |    13.87 |    15.21 |      15.43 |    15.43 |
|        5000 |   64.4 ms |             77,607 |    32.34 |    57.01 |    62.62 |      63.16 |    63.25 |
|       10000 |  150.0 ms |             66,651 |    76.81 |   131.37 |   144.81 |     146.90 |   147.11 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 231.3 MB
  • Settled Cooldown RSS   : 80.9 MB (Clean GC release)

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
| Yatta     |      70,256 |     1.00x |    16% | 1.32ms | 2.60ms | 3.14ms |
| Raw Bun   |      57,999 |     0.83x |     3% | 1.48ms | 3.12ms | 3.21ms |
| Hono      |      61,528 |     0.88x |    20% | 1.30ms | 2.68ms | 3.09ms |
| Elysia    |      57,344 |     0.82x |    17% | 1.31ms | 3.04ms | 3.24ms |
| Express   |      42,464 |     0.60x |     4% | 2.40ms | 3.60ms | 5.81ms |
| Fastify   |      56,665 |     0.81x |     9% | 1.71ms | 2.89ms | 3.90ms |
| Koa       |      44,895 |     0.64x |    17% | 1.97ms | 3.94ms | 6.02ms |

  Yatta dispatch adds about -3.0µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 16%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
