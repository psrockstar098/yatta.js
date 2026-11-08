# Yatta Benchmarks

> Last run: `2026-11-08T12:23:02Z` · commit [`098fd5d`](https://github.com/psrockstar098/yatta.js/commit/098fd5d0adbe6724737c8d4e60346cb42cc5711a) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 77.9 ms
  • End-to-End Runtime Task Cost    : 0.0210 ms/op
  • Peak RSS Memory        : 195.7 MB
  • RSS Heap Memory             : 94.29 MB
  • Raw Worker IPC Round-Trip      : 0.0190 ms/op
  • Scheduler + Graph Overhead     : 0.0020 ms/op
  • Settled Cooldown RSS   : 91.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.92 MB
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
| Yatta     |      74,989 |     1.00x |    21% | 1.36ms | 1.96ms | 3.03ms |
| Raw Bun   |      55,325 |     0.74x |     9% | 1.56ms | 3.24ms | 3.32ms |
| Hono      |      67,031 |     0.89x |     8% | 1.45ms | 3.01ms | 3.24ms |
| Elysia    |      67,853 |     0.90x |    14% | 1.31ms | 2.85ms | 3.20ms |
| Express   |      35,649 |     0.48x |     4% | 2.65ms | 4.58ms | 6.30ms |
| Fastify   |      47,621 |     0.64x |     4% | 2.00ms | 3.55ms | 4.65ms |
| Koa       |      41,146 |     0.55x |     4% | 2.34ms | 4.39ms | 5.73ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,626 |       0.26 |       0.27 |       0.27 |       0.27 |
|         100 |     0.8 ms |              118,829 |       0.16 |       0.55 |       0.56 |       0.56 |
|         500 |     1.1 ms |              473,462 |       0.50 |       0.82 |       0.86 |       0.87 |
|        1000 |     2.4 ms |              423,388 |       1.27 |       1.90 |       1.94 |       1.95 |
|        5000 |    14.0 ms |              355,983 |       8.22 |      10.17 |      10.18 |      10.21 |
|       10000 |    27.1 ms |              369,383 |      13.82 |      21.38 |      21.93 |      21.98 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.6 ms |            218,486 |     2.09 |     2.95 |     3.53 |       3.71 |     3.71 |
|        5000 |   12.6 ms |            397,944 |     5.80 |     8.25 |     8.55 |       8.59 |     8.60 |
|       10000 |   41.2 ms |            242,908 |    18.65 |    32.29 |    33.84 |      33.95 |    33.96 |
|       25000 |   77.9 ms |            320,823 |    38.58 |    60.10 |    64.23 |      64.58 |    64.60 |
|       50000 |  128.0 ms |            390,699 |    62.58 |   102.73 |   109.48 |     110.35 |   110.36 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.2 ms |            138,853 |     3.44 |     5.25 |     5.99 |       6.26 |     6.26 |
|        5000 |   33.3 ms |            150,153 |    17.57 |    26.66 |    27.36 |      27.42 |    27.42 |
|       10000 |   66.6 ms |            150,170 |    34.08 |    56.09 |    57.68 |      57.71 |    57.71 |
|       25000 |  176.2 ms |            141,897 |    88.68 |   152.54 |   163.79 |     164.16 |   164.18 |
|       50000 |  327.3 ms |            152,774 |   197.04 |   286.57 |   304.75 |     305.35 |   305.60 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.5 ms |             68,814 |     7.57 |    12.17 |    13.53 |      13.76 |    13.76 |
|        5000 |   69.3 ms |             72,193 |    38.51 |    61.01 |    65.94 |      66.67 |    66.75 |
|       10000 |  145.1 ms |             68,919 |    69.14 |   114.18 |   139.16 |     141.97 |   142.27 |

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
  • Raw Worker IPC Round-Trip      : 0.0190 ms/op
  • End-to-End Runtime Task Cost    : 0.0210 ms/op
  • Scheduler + Graph Overhead     : 0.0020 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,626 |       0.26 |       0.27 |       0.27 |       0.27 |
|         100 |     0.8 ms |              118,829 |       0.16 |       0.55 |       0.56 |       0.56 |
|         500 |     1.1 ms |              473,462 |       0.50 |       0.82 |       0.86 |       0.87 |
|        1000 |     2.4 ms |              423,388 |       1.27 |       1.90 |       1.94 |       1.95 |
|        5000 |    14.0 ms |              355,983 |       8.22 |      10.17 |      10.18 |      10.21 |
|       10000 |    27.1 ms |              369,383 |      13.82 |      21.38 |      21.93 |      21.98 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 94.29 MB
  • V8/JSC Heap Used             : 13.92 MB

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
| 1 CPU + 1 IO  |       2 |   27.6 ms |            362,659 |    12.55 |    20.16 |    20.42 |    20.51 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   32.3 ms |            309,504 |    17.66 |    25.04 |    25.36 |    25.39 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   24.3 ms |            411,162 |    12.89 |    19.39 |    20.07 |    20.35 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   22.3 ms |            447,549 |    11.19 |    16.98 |    17.28 |    17.36 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 77.9 ms
  • Peak Throughput Rate       : 320,834 ops/sec
  • Latency Distribution       : p50: 39.85ms | p90: 63.45ms | p99: 63.88ms | p99.9: 64.04ms | Max: 64.06ms
  • Memory (RSS)               : Baseline: 105.6 MB | Peak: 129.3 MB | Cooldown: 101.4 MB

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
|        1000 |    4.6 ms |            218,486 |     2.09 |     2.95 |     3.53 |       3.71 |     3.71 |
|        5000 |   12.6 ms |            397,944 |     5.80 |     8.25 |     8.55 |       8.59 |     8.60 |
|       10000 |   41.2 ms |            242,908 |    18.65 |    32.29 |    33.84 |      33.95 |    33.96 |
|       25000 |   77.9 ms |            320,823 |    38.58 |    60.10 |    64.23 |      64.58 |    64.60 |
|       50000 |  128.0 ms |            390,699 |    62.58 |   102.73 |   109.48 |     110.35 |   110.36 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.2 ms |            138,853 |     3.44 |     5.25 |     5.99 |       6.26 |     6.26 |
|        5000 |   33.3 ms |            150,153 |    17.57 |    26.66 |    27.36 |      27.42 |    27.42 |
|       10000 |   66.6 ms |            150,170 |    34.08 |    56.09 |    57.68 |      57.71 |    57.71 |
|       25000 |  176.2 ms |            141,897 |    88.68 |   152.54 |   163.79 |     164.16 |   164.18 |
|       50000 |  327.3 ms |            152,774 |   197.04 |   286.57 |   304.75 |     305.35 |   305.60 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.5 ms |             68,814 |     7.57 |    12.17 |    13.53 |      13.76 |    13.76 |
|        5000 |   69.3 ms |             72,193 |    38.51 |    61.01 |    65.94 |      66.67 |    66.75 |
|       10000 |  145.1 ms |             68,919 |    69.14 |   114.18 |   139.16 |     141.97 |   142.27 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 195.7 MB
  • Settled Cooldown RSS   : 91.8 MB (Clean GC release)

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
| Yatta     |      74,989 |     1.00x |    21% | 1.36ms | 1.96ms | 3.03ms |
| Raw Bun   |      55,325 |     0.74x |     9% | 1.56ms | 3.24ms | 3.32ms |
| Hono      |      67,031 |     0.89x |     8% | 1.45ms | 3.01ms | 3.24ms |
| Elysia    |      67,853 |     0.90x |    14% | 1.31ms | 2.85ms | 3.20ms |
| Express   |      35,649 |     0.48x |     4% | 2.65ms | 4.58ms | 6.30ms |
| Fastify   |      47,621 |     0.64x |     4% | 2.00ms | 3.55ms | 4.65ms |
| Koa       |      41,146 |     0.55x |     4% | 2.34ms | 4.39ms | 5.73ms |

  Yatta dispatch adds about -4.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 21%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
