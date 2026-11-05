# Yatta Benchmarks

> Last run: `2026-11-05T14:20:00Z` · commit [`10cf7f6`](https://github.com/psrockstar098/yatta.js/commit/10cf7f6af18a853dc2e69910f2e8dc917f16c447) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 91.1 ms
  • End-to-End Runtime Task Cost    : 0.0420 ms/op
  • Peak RSS Memory        : 201.1 MB
  • RSS Heap Memory             : 93.76 MB
  • Raw Worker IPC Round-Trip      : 0.0350 ms/op
  • Scheduler + Graph Overhead     : 0.0070 ms/op
  • Settled Cooldown RSS   : 72.5 MB (Clean GC release)
  • V8/JSC Heap Used             : 12.89 MB
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
| Yatta     |      62,017 |     1.00x |    17% | 1.59ms | 2.84ms | 3.58ms |
| Raw Bun   |      71,473 |     1.15x |     1% | 1.29ms | 2.22ms | 2.98ms |
| Hono      |      62,184 |     1.00x |    15% | 1.49ms | 2.60ms | 3.23ms |
| Elysia    |      73,497 |     1.19x |    18% | 1.32ms | 2.18ms | 2.94ms |
| Express   |      23,789 |     0.38x |     6% | 3.85ms | 7.44ms | 8.90ms |
| Fastify   |      33,590 |     0.54x |    12% | 2.83ms | 5.36ms | 6.96ms |
| Koa       |      27,287 |     0.44x |     3% | 3.33ms | 6.12ms | 7.88ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,022 |       0.37 |       0.43 |       0.43 |       0.43 |
|         100 |     0.9 ms |              116,400 |       0.39 |       0.64 |       0.70 |       0.70 |
|         500 |     2.0 ms |              248,018 |       0.93 |       1.36 |       1.41 |       1.45 |
|        1000 |     3.5 ms |              282,358 |       1.72 |       2.53 |       2.62 |       2.67 |
|        5000 |    25.4 ms |              196,558 |      13.77 |      17.54 |      17.75 |      17.77 |
|       10000 |    51.6 ms |              193,707 |      23.93 |      42.50 |      43.58 |      43.63 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.8 ms |            146,054 |     2.81 |     4.25 |     5.41 |       5.78 |     5.78 |
|        5000 |   19.2 ms |            260,759 |     9.98 |    12.93 |    13.48 |      13.48 |    13.48 |
|       10000 |   39.8 ms |            251,029 |    19.93 |    29.91 |    30.88 |      30.89 |    30.89 |
|       25000 |   85.3 ms |            293,046 |    44.85 |    61.02 |    63.19 |      63.35 |    63.41 |
|       50000 |  149.9 ms |            333,667 |    75.12 |   107.31 |   116.21 |     116.75 |   116.76 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,531 |     5.44 |     6.25 |     6.75 |       6.87 |     6.87 |
|        5000 |   50.1 ms |             99,741 |    25.11 |    37.94 |    39.09 |      39.13 |    39.14 |
|       10000 |  105.0 ms |             95,209 |    55.53 |    89.74 |    93.12 |      93.22 |    93.23 |
|       25000 |  257.1 ms |             97,239 |   127.78 |   222.89 |   236.59 |     237.11 |   237.14 |
|       50000 |  523.3 ms |             95,539 |   268.32 |   443.58 |   480.87 |     481.99 |   482.08 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   21.5 ms |             46,557 |    11.50 |    18.71 |    20.19 |      20.61 |    20.61 |
|        5000 |  105.0 ms |             47,634 |    50.67 |    92.25 |   101.10 |     102.72 |   102.86 |
|       10000 |  202.1 ms |             49,471 |   107.88 |   179.57 |   195.72 |     198.08 |   198.41 |

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
  • Raw Worker IPC Round-Trip      : 0.0350 ms/op
  • End-to-End Runtime Task Cost    : 0.0420 ms/op
  • Scheduler + Graph Overhead     : 0.0070 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,022 |       0.37 |       0.43 |       0.43 |       0.43 |
|         100 |     0.9 ms |              116,400 |       0.39 |       0.64 |       0.70 |       0.70 |
|         500 |     2.0 ms |              248,018 |       0.93 |       1.36 |       1.41 |       1.45 |
|        1000 |     3.5 ms |              282,358 |       1.72 |       2.53 |       2.62 |       2.67 |
|        5000 |    25.4 ms |              196,558 |      13.77 |      17.54 |      17.75 |      17.77 |
|       10000 |    51.6 ms |              193,707 |      23.93 |      42.50 |      43.58 |      43.63 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.76 MB
  • V8/JSC Heap Used             : 12.89 MB

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
| 1 CPU + 1 IO  |       2 |   48.9 ms |            204,405 |    23.70 |    38.98 |    39.41 |    39.50 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   39.3 ms |            254,372 |    18.68 |    27.45 |    27.77 |    27.88 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   39.1 ms |            255,989 |    17.75 |    30.51 |    30.92 |    31.17 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   35.4 ms |            282,689 |    17.85 |    25.80 |    26.16 |    26.25 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 91.1 ms
  • Peak Throughput Rate       : 274,513 ops/sec
  • Latency Distribution       : p50: 45.46ms | p90: 72.75ms | p99: 74.09ms | p99.9: 74.32ms | Max: 74.33ms
  • Memory (RSS)               : Baseline: 107.4 MB | Peak: 128.7 MB | Cooldown: 101.3 MB

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
|        1000 |    6.8 ms |            146,054 |     2.81 |     4.25 |     5.41 |       5.78 |     5.78 |
|        5000 |   19.2 ms |            260,759 |     9.98 |    12.93 |    13.48 |      13.48 |    13.48 |
|       10000 |   39.8 ms |            251,029 |    19.93 |    29.91 |    30.88 |      30.89 |    30.89 |
|       25000 |   85.3 ms |            293,046 |    44.85 |    61.02 |    63.19 |      63.35 |    63.41 |
|       50000 |  149.9 ms |            333,667 |    75.12 |   107.31 |   116.21 |     116.75 |   116.76 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,531 |     5.44 |     6.25 |     6.75 |       6.87 |     6.87 |
|        5000 |   50.1 ms |             99,741 |    25.11 |    37.94 |    39.09 |      39.13 |    39.14 |
|       10000 |  105.0 ms |             95,209 |    55.53 |    89.74 |    93.12 |      93.22 |    93.23 |
|       25000 |  257.1 ms |             97,239 |   127.78 |   222.89 |   236.59 |     237.11 |   237.14 |
|       50000 |  523.3 ms |             95,539 |   268.32 |   443.58 |   480.87 |     481.99 |   482.08 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   21.5 ms |             46,557 |    11.50 |    18.71 |    20.19 |      20.61 |    20.61 |
|        5000 |  105.0 ms |             47,634 |    50.67 |    92.25 |   101.10 |     102.72 |   102.86 |
|       10000 |  202.1 ms |             49,471 |   107.88 |   179.57 |   195.72 |     198.08 |   198.41 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 201.1 MB
  • Settled Cooldown RSS   : 72.5 MB (Clean GC release)

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
| Yatta     |      62,017 |     1.00x |    17% | 1.59ms | 2.84ms | 3.58ms |
| Raw Bun   |      71,473 |     1.15x |     1% | 1.29ms | 2.22ms | 2.98ms |
| Hono      |      62,184 |     1.00x |    15% | 1.49ms | 2.60ms | 3.23ms |
| Elysia    |      73,497 |     1.19x |    18% | 1.32ms | 2.18ms | 2.94ms |
| Express   |      23,789 |     0.38x |     6% | 3.85ms | 7.44ms | 8.90ms |
| Fastify   |      33,590 |     0.54x |    12% | 2.83ms | 5.36ms | 6.96ms |
| Koa       |      27,287 |     0.44x |     3% | 3.33ms | 6.12ms | 7.88ms |

  Yatta dispatch adds about 2.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 17%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
