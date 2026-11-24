# Yatta Benchmarks

> Last run: `2026-11-24T08:35:17Z` · commit [`eaf1386`](https://github.com/psrockstar098/yatta.js/commit/eaf1386c4bf433b50a587fcbc7cba533a9bf33ff) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 65.7 ms
  • End-to-End Runtime Task Cost    : 0.0252 ms/op
  • Peak RSS Memory        : 212.0 MB
  • RSS Heap Memory             : 96.19 MB
  • Raw Worker IPC Round-Trip      : 0.0096 ms/op
  • Scheduler + Graph Overhead     : 0.0156 ms/op
  • Settled Cooldown RSS   : 85.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.50 MB
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      93,030 |     1.00x |     2% | 1.16ms | 1.60ms | 2.26ms |
| Raw Bun   |     117,112 |     1.26x |     6% | 0.95ms | 1.20ms | 1.62ms |
| Hono      |     104,664 |     1.13x |     4% | 1.06ms | 1.55ms | 1.93ms |
| Elysia    |     108,464 |     1.17x |     6% | 1.01ms | 1.44ms | 1.89ms |
| Express   |      42,036 |     0.45x |     5% | 2.22ms | 4.59ms | 6.27ms |
| Fastify   |      57,906 |     0.62x |     8% | 1.56ms | 3.37ms | 4.35ms |
| Koa       |      45,650 |     0.49x |     5% | 2.12ms | 3.85ms | 5.31ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               19,140 |       0.23 |       0.24 |       0.24 |       0.24 |
|         100 |     0.5 ms |              193,576 |       0.20 |       0.27 |       0.29 |       0.29 |
|         500 |     1.5 ms |              342,527 |       0.68 |       0.82 |       0.83 |       0.86 |
|        1000 |     2.4 ms |              423,280 |       1.18 |       1.81 |       1.86 |       1.88 |
|        5000 |    15.2 ms |              329,709 |       8.18 |      10.19 |      10.40 |      10.46 |
|       10000 |    29.1 ms |              343,312 |      16.04 |      22.01 |      22.10 |      22.60 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.8 ms |            146,611 |     3.23 |     4.84 |     5.75 |       5.79 |     5.79 |
|        5000 |   15.6 ms |            319,875 |     7.50 |    10.61 |    11.08 |      11.09 |    11.10 |
|       10000 |   29.2 ms |            342,726 |    15.99 |    21.89 |    23.35 |      23.43 |    23.46 |
|       25000 |   63.4 ms |            394,043 |    32.61 |    45.50 |    47.66 |      47.76 |    47.88 |
|       50000 |  121.2 ms |            412,596 |    61.64 |    90.87 |    96.32 |      96.60 |    96.63 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.3 ms |            121,207 |     4.07 |     6.16 |     7.12 |       7.39 |     7.39 |
|        5000 |   36.4 ms |            137,256 |    18.71 |    28.53 |    29.29 |      29.34 |    29.34 |
|       10000 |   73.7 ms |            135,755 |    38.59 |    62.50 |    64.47 |      64.55 |    64.56 |
|       25000 |  188.0 ms |            132,970 |    93.83 |   163.64 |   173.24 |     173.63 |   173.65 |
|       50000 |  332.2 ms |            150,495 |   165.05 |   276.70 |   303.70 |     304.30 |   304.44 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.0 ms |             62,350 |    10.85 |    14.17 |    15.03 |      15.16 |    15.16 |
|        5000 |   52.8 ms |             94,692 |    30.07 |    47.12 |    50.66 |      51.14 |    51.18 |
|       10000 |  102.2 ms |             97,857 |    48.25 |    86.78 |    97.69 |      99.11 |    99.24 |

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
  • Raw Worker IPC Round-Trip      : 0.0096 ms/op
  • End-to-End Runtime Task Cost    : 0.0252 ms/op
  • Scheduler + Graph Overhead     : 0.0156 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               19,140 |       0.23 |       0.24 |       0.24 |       0.24 |
|         100 |     0.5 ms |              193,576 |       0.20 |       0.27 |       0.29 |       0.29 |
|         500 |     1.5 ms |              342,527 |       0.68 |       0.82 |       0.83 |       0.86 |
|        1000 |     2.4 ms |              423,280 |       1.18 |       1.81 |       1.86 |       1.88 |
|        5000 |    15.2 ms |              329,709 |       8.18 |      10.19 |      10.40 |      10.46 |
|       10000 |    29.1 ms |              343,312 |      16.04 |      22.01 |      22.10 |      22.60 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.19 MB
  • V8/JSC Heap Used             : 13.50 MB

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
| 1 CPU + 1 IO  |       2 |   34.3 ms |            291,746 |    17.26 |    25.17 |    27.01 |    27.05 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   27.6 ms |            362,562 |    13.45 |    20.03 |    20.19 |    20.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   28.3 ms |            353,173 |    15.41 |    22.03 |    22.82 |    23.06 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   24.7 ms |            405,218 |    13.98 |    17.96 |    18.31 |    18.48 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 65.7 ms
  • Peak Throughput Rate       : 380,701 ops/sec
  • Latency Distribution       : p50: 30.51ms | p90: 49.73ms | p99: 50.41ms | p99.9: 50.52ms | Max: 50.57ms
  • Memory (RSS)               : Baseline: 109.7 MB | Peak: 133.2 MB | Cooldown: 104.9 MB

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
|        1000 |    6.8 ms |            146,611 |     3.23 |     4.84 |     5.75 |       5.79 |     5.79 |
|        5000 |   15.6 ms |            319,875 |     7.50 |    10.61 |    11.08 |      11.09 |    11.10 |
|       10000 |   29.2 ms |            342,726 |    15.99 |    21.89 |    23.35 |      23.43 |    23.46 |
|       25000 |   63.4 ms |            394,043 |    32.61 |    45.50 |    47.66 |      47.76 |    47.88 |
|       50000 |  121.2 ms |            412,596 |    61.64 |    90.87 |    96.32 |      96.60 |    96.63 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.3 ms |            121,207 |     4.07 |     6.16 |     7.12 |       7.39 |     7.39 |
|        5000 |   36.4 ms |            137,256 |    18.71 |    28.53 |    29.29 |      29.34 |    29.34 |
|       10000 |   73.7 ms |            135,755 |    38.59 |    62.50 |    64.47 |      64.55 |    64.56 |
|       25000 |  188.0 ms |            132,970 |    93.83 |   163.64 |   173.24 |     173.63 |   173.65 |
|       50000 |  332.2 ms |            150,495 |   165.05 |   276.70 |   303.70 |     304.30 |   304.44 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.0 ms |             62,350 |    10.85 |    14.17 |    15.03 |      15.16 |    15.16 |
|        5000 |   52.8 ms |             94,692 |    30.07 |    47.12 |    50.66 |      51.14 |    51.18 |
|       10000 |  102.2 ms |             97,857 |    48.25 |    86.78 |    97.69 |      99.11 |    99.24 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 212.0 MB
  • Settled Cooldown RSS   : 85.2 MB (Clean GC release)

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
| Yatta     |      93,030 |     1.00x |     2% | 1.16ms | 1.60ms | 2.26ms |
| Raw Bun   |     117,112 |     1.26x |     6% | 0.95ms | 1.20ms | 1.62ms |
| Hono      |     104,664 |     1.13x |     4% | 1.06ms | 1.55ms | 1.93ms |
| Elysia    |     108,464 |     1.17x |     6% | 1.01ms | 1.44ms | 1.89ms |
| Express   |      42,036 |     0.45x |     5% | 2.22ms | 4.59ms | 6.27ms |
| Fastify   |      57,906 |     0.62x |     8% | 1.56ms | 3.37ms | 4.35ms |
| Koa       |      45,650 |     0.49x |     5% | 2.12ms | 3.85ms | 5.31ms |

  Yatta dispatch adds about 2.2µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
