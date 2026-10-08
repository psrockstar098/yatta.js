# Yatta Benchmarks

> Last run: `2026-10-08T19:26:29Z` · commit [`6f2fc76`](https://github.com/psrockstar098/yatta.js/commit/6f2fc76e70007f6dec8e222a3f14f8385a36f6d4) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 62.0 ms
  • End-to-End Runtime Task Cost    : 0.0236 ms/op
  • Peak RSS Memory        : 210.0 MB
  • RSS Heap Memory             : 92.32 MB
  • Raw Worker IPC Round-Trip      : 0.0175 ms/op
  • Scheduler + Graph Overhead     : 0.0061 ms/op
  • Settled Cooldown RSS   : 84.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.88 MB
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
| Yatta     |      62,121 |     1.00x |     9% | 1.75ms | 2.24ms | 3.47ms |
| Raw Bun   |      56,355 |     0.91x |     5% | 1.52ms | 3.14ms | 3.28ms |
| Hono      |      63,096 |     1.02x |    10% | 1.38ms | 2.84ms | 3.48ms |
| Elysia    |      55,200 |     0.89x |    21% | 1.54ms | 3.18ms | 3.36ms |
| Express   |      34,887 |     0.56x |    26% | 2.23ms | 4.26ms | 6.64ms |
| Fastify   |      49,874 |     0.80x |     6% | 1.80ms | 3.42ms | 4.62ms |
| Koa       |      43,973 |     0.71x |     5% | 2.29ms | 3.86ms | 5.37ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               18,783 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.6 ms |              162,032 |       0.19 |       0.40 |       0.41 |       0.41 |
|         500 |     1.4 ms |              363,003 |       0.63 |       0.73 |       0.75 |       0.77 |
|        1000 |     2.0 ms |              505,593 |       1.00 |       1.45 |       1.47 |       1.49 |
|        5000 |    17.1 ms |              292,291 |      10.43 |      13.05 |      13.22 |      13.25 |
|       10000 |    32.5 ms |              307,670 |      18.13 |      27.24 |      27.29 |      27.30 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.5 ms |            154,400 |     2.15 |     3.68 |     3.82 |       3.83 |     3.83 |
|        5000 |   11.5 ms |            433,556 |     5.61 |     7.54 |     7.85 |       7.85 |     7.86 |
|       10000 |   25.9 ms |            385,486 |    12.38 |    18.55 |    19.99 |      20.04 |    20.04 |
|       25000 |   76.2 ms |            328,193 |    36.45 |    60.05 |    63.02 |      63.10 |    63.10 |
|       50000 |  145.0 ms |            344,846 |    72.79 |   112.33 |   122.16 |     122.23 |   122.26 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.4 ms |            134,622 |     3.65 |     4.96 |     5.65 |       6.00 |     6.00 |
|        5000 |   24.6 ms |            203,507 |    11.82 |    19.00 |    19.75 |      19.79 |    19.80 |
|       10000 |   51.2 ms |            195,325 |    26.30 |    42.63 |    44.62 |      44.67 |    44.68 |
|       25000 |  158.1 ms |            158,142 |    77.03 |   137.27 |   145.27 |     145.58 |   145.59 |
|       50000 |  331.6 ms |            150,784 |   188.18 |   286.52 |   306.13 |     308.06 |   308.60 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.9 ms |             40,161 |    15.07 |    22.72 |    23.95 |      24.16 |    24.16 |
|        5000 |   69.3 ms |             72,144 |    35.04 |    60.45 |    66.45 |      67.21 |    67.31 |
|       10000 |  165.3 ms |             60,497 |    84.07 |   136.57 |   150.11 |     152.14 |   161.85 |

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
  • Raw Worker IPC Round-Trip      : 0.0175 ms/op
  • End-to-End Runtime Task Cost    : 0.0236 ms/op
  • Scheduler + Graph Overhead     : 0.0061 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               18,783 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.6 ms |              162,032 |       0.19 |       0.40 |       0.41 |       0.41 |
|         500 |     1.4 ms |              363,003 |       0.63 |       0.73 |       0.75 |       0.77 |
|        1000 |     2.0 ms |              505,593 |       1.00 |       1.45 |       1.47 |       1.49 |
|        5000 |    17.1 ms |              292,291 |      10.43 |      13.05 |      13.22 |      13.25 |
|       10000 |    32.5 ms |              307,670 |      18.13 |      27.24 |      27.29 |      27.30 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.16 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 92.32 MB
  • V8/JSC Heap Used             : 13.88 MB

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
| 1 CPU + 1 IO  |       2 |   31.9 ms |            313,413 |    13.97 |    23.47 |    23.99 |    24.23 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   24.4 ms |            409,778 |    11.77 |    18.13 |    18.22 |    18.31 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   20.6 ms |            486,545 |     9.08 |    15.72 |    16.06 |    16.15 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   23.0 ms |            435,025 |    11.32 |    17.85 |    18.16 |    18.23 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 62.0 ms
  • Peak Throughput Rate       : 402,970 ops/sec
  • Latency Distribution       : p50: 31.97ms | p90: 51.16ms | p99: 51.60ms | p99.9: 51.81ms | Max: 51.85ms
  • Memory (RSS)               : Baseline: 95.1 MB | Peak: 130.2 MB | Cooldown: 101.0 MB

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
|        1000 |    6.5 ms |            154,400 |     2.15 |     3.68 |     3.82 |       3.83 |     3.83 |
|        5000 |   11.5 ms |            433,556 |     5.61 |     7.54 |     7.85 |       7.85 |     7.86 |
|       10000 |   25.9 ms |            385,486 |    12.38 |    18.55 |    19.99 |      20.04 |    20.04 |
|       25000 |   76.2 ms |            328,193 |    36.45 |    60.05 |    63.02 |      63.10 |    63.10 |
|       50000 |  145.0 ms |            344,846 |    72.79 |   112.33 |   122.16 |     122.23 |   122.26 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.4 ms |            134,622 |     3.65 |     4.96 |     5.65 |       6.00 |     6.00 |
|        5000 |   24.6 ms |            203,507 |    11.82 |    19.00 |    19.75 |      19.79 |    19.80 |
|       10000 |   51.2 ms |            195,325 |    26.30 |    42.63 |    44.62 |      44.67 |    44.68 |
|       25000 |  158.1 ms |            158,142 |    77.03 |   137.27 |   145.27 |     145.58 |   145.59 |
|       50000 |  331.6 ms |            150,784 |   188.18 |   286.52 |   306.13 |     308.06 |   308.60 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.9 ms |             40,161 |    15.07 |    22.72 |    23.95 |      24.16 |    24.16 |
|        5000 |   69.3 ms |             72,144 |    35.04 |    60.45 |    66.45 |      67.21 |    67.31 |
|       10000 |  165.3 ms |             60,497 |    84.07 |   136.57 |   150.11 |     152.14 |   161.85 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 210.0 MB
  • Settled Cooldown RSS   : 84.7 MB (Clean GC release)

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
| Yatta     |      62,121 |     1.00x |     9% | 1.75ms | 2.24ms | 3.47ms |
| Raw Bun   |      56,355 |     0.91x |     5% | 1.52ms | 3.14ms | 3.28ms |
| Hono      |      63,096 |     1.02x |    10% | 1.38ms | 2.84ms | 3.48ms |
| Elysia    |      55,200 |     0.89x |    21% | 1.54ms | 3.18ms | 3.36ms |
| Express   |      34,887 |     0.56x |    26% | 2.23ms | 4.26ms | 6.64ms |
| Fastify   |      49,874 |     0.80x |     6% | 1.80ms | 3.42ms | 4.62ms |
| Koa       |      43,973 |     0.71x |     5% | 2.29ms | 3.86ms | 5.37ms |

  Yatta dispatch adds about -1.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
