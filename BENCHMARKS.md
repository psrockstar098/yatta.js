# Yatta Benchmarks

> Last run: `2026-11-05T16:20:56Z` · commit [`ab94c73`](https://github.com/psrockstar098/yatta.js/commit/ab94c73142e78042995707b317fe916ab77b55b2) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 116.5 ms
  • End-to-End Runtime Task Cost    : 0.0220 ms/op
  • Peak RSS Memory        : 232.3 MB
  • RSS Heap Memory             : 86.52 MB
  • Raw Worker IPC Round-Trip      : 0.0140 ms/op
  • Scheduler + Graph Overhead     : 0.0080 ms/op
  • Settled Cooldown RSS   : 73.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.39 MB
  • Worker Fleet Event Loop Lag : 10.17 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      74,864 |     1.00x |    15% | 1.34ms | 1.97ms | 2.45ms |
| Raw Bun   |      60,747 |     0.81x |    18% | 1.34ms | 3.00ms | 3.16ms |
| Hono      |      66,747 |     0.89x |     4% | 1.39ms | 2.97ms | 3.10ms |
| Elysia    |      60,009 |     0.80x |     3% | 1.44ms | 2.88ms | 3.26ms |
| Express   |      34,311 |     0.46x |     7% | 2.71ms | 4.76ms | 6.36ms |
| Fastify   |      46,757 |     0.62x |     1% | 2.18ms | 3.48ms | 5.04ms |
| Koa       |      40,078 |     0.54x |     3% | 2.12ms | 4.56ms | 5.83ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,886 |       0.28 |       0.30 |       0.30 |       0.30 |
|         100 |     0.5 ms |              196,437 |       0.16 |       0.39 |       0.42 |       0.42 |
|         500 |     1.2 ms |              405,455 |       0.61 |       0.81 |       0.86 |       0.88 |
|        1000 |     2.3 ms |              434,148 |       1.15 |       1.73 |       1.76 |       1.78 |
|        5000 |    16.3 ms |              306,316 |       8.32 |      11.54 |      11.99 |      12.00 |
|       10000 |    32.3 ms |              309,787 |      16.72 |      25.74 |      25.83 |      25.94 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.8 ms |            207,834 |     2.01 |     2.94 |     3.65 |       3.73 |     3.73 |
|        5000 |   18.1 ms |            277,003 |     8.56 |    13.20 |    13.62 |      13.62 |    13.63 |
|       10000 |   35.8 ms |            279,720 |    18.63 |    27.60 |    28.48 |      28.49 |    28.49 |
|       25000 |   84.3 ms |            296,680 |    41.31 |    65.59 |    69.57 |      69.73 |    69.74 |
|       50000 |  163.0 ms |            306,692 |    86.51 |   132.72 |   140.92 |     141.29 |   141.31 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.1 ms |            123,253 |     4.15 |     6.06 |     6.95 |       7.04 |     7.04 |
|        5000 |   33.6 ms |            148,947 |    17.70 |    26.41 |    27.28 |      27.31 |    27.32 |
|       10000 |   71.8 ms |            139,356 |    37.30 |    61.47 |    63.42 |      63.43 |    63.43 |
|       25000 |  195.7 ms |            127,774 |    99.35 |   171.26 |   182.00 |     182.45 |   182.48 |
|       50000 |  359.7 ms |            139,002 |   191.39 |   308.39 |   325.07 |     332.49 |   332.59 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.6 ms |             50,980 |     9.95 |    15.80 |    17.04 |      17.25 |    17.25 |
|        5000 |   56.9 ms |             87,804 |    28.84 |    49.23 |    54.44 |      55.43 |    55.52 |
|       10000 |  127.3 ms |             78,531 |    62.70 |   108.51 |   121.62 |     123.82 |   124.03 |

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
  • Raw Worker IPC Round-Trip      : 0.0140 ms/op
  • End-to-End Runtime Task Cost    : 0.0220 ms/op
  • Scheduler + Graph Overhead     : 0.0080 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,886 |       0.28 |       0.30 |       0.30 |       0.30 |
|         100 |     0.5 ms |              196,437 |       0.16 |       0.39 |       0.42 |       0.42 |
|         500 |     1.2 ms |              405,455 |       0.61 |       0.81 |       0.86 |       0.88 |
|        1000 |     2.3 ms |              434,148 |       1.15 |       1.73 |       1.76 |       1.78 |
|        5000 |    16.3 ms |              306,316 |       8.32 |      11.54 |      11.99 |      12.00 |
|       10000 |    32.3 ms |              309,787 |      16.72 |      25.74 |      25.83 |      25.94 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.17 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 86.52 MB
  • V8/JSC Heap Used             : 13.39 MB

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
| 1 CPU + 1 IO  |       2 |   32.9 ms |            303,558 |    15.43 |    24.35 |    26.57 |    26.62 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   63.4 ms |            157,734 |    24.46 |    52.94 |    53.71 |    53.93 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   60.8 ms |            164,437 |    26.65 |    45.39 |    46.07 |    46.15 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   59.2 ms |            168,961 |    32.57 |    46.80 |    46.88 |    46.91 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 116.5 ms
  • Peak Throughput Rate       : 214,633 ops/sec
  • Latency Distribution       : p50: 59.65ms | p90: 97.09ms | p99: 99.39ms | p99.9: 99.45ms | Max: 99.46ms
  • Memory (RSS)               : Baseline: 100.1 MB | Peak: 125.5 MB | Cooldown: 61.2 MB

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
|        1000 |    4.8 ms |            207,834 |     2.01 |     2.94 |     3.65 |       3.73 |     3.73 |
|        5000 |   18.1 ms |            277,003 |     8.56 |    13.20 |    13.62 |      13.62 |    13.63 |
|       10000 |   35.8 ms |            279,720 |    18.63 |    27.60 |    28.48 |      28.49 |    28.49 |
|       25000 |   84.3 ms |            296,680 |    41.31 |    65.59 |    69.57 |      69.73 |    69.74 |
|       50000 |  163.0 ms |            306,692 |    86.51 |   132.72 |   140.92 |     141.29 |   141.31 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.1 ms |            123,253 |     4.15 |     6.06 |     6.95 |       7.04 |     7.04 |
|        5000 |   33.6 ms |            148,947 |    17.70 |    26.41 |    27.28 |      27.31 |    27.32 |
|       10000 |   71.8 ms |            139,356 |    37.30 |    61.47 |    63.42 |      63.43 |    63.43 |
|       25000 |  195.7 ms |            127,774 |    99.35 |   171.26 |   182.00 |     182.45 |   182.48 |
|       50000 |  359.7 ms |            139,002 |   191.39 |   308.39 |   325.07 |     332.49 |   332.59 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.6 ms |             50,980 |     9.95 |    15.80 |    17.04 |      17.25 |    17.25 |
|        5000 |   56.9 ms |             87,804 |    28.84 |    49.23 |    54.44 |      55.43 |    55.52 |
|       10000 |  127.3 ms |             78,531 |    62.70 |   108.51 |   121.62 |     123.82 |   124.03 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 232.3 MB
  • Settled Cooldown RSS   : 73.4 MB (Clean GC release)

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
| Yatta     |      74,864 |     1.00x |    15% | 1.34ms | 1.97ms | 2.45ms |
| Raw Bun   |      60,747 |     0.81x |    18% | 1.34ms | 3.00ms | 3.16ms |
| Hono      |      66,747 |     0.89x |     4% | 1.39ms | 2.97ms | 3.10ms |
| Elysia    |      60,009 |     0.80x |     3% | 1.44ms | 2.88ms | 3.26ms |
| Express   |      34,311 |     0.46x |     7% | 2.71ms | 4.76ms | 6.36ms |
| Fastify   |      46,757 |     0.62x |     1% | 2.18ms | 3.48ms | 5.04ms |
| Koa       |      40,078 |     0.54x |     3% | 2.12ms | 4.56ms | 5.83ms |

  Yatta dispatch adds about -3.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 15%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
