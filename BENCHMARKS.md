# Yatta Benchmarks

> Last run: `2026-11-05T02:49:56Z` · commit [`36c3244`](https://github.com/psrockstar098/yatta.js/commit/36c32441b51d3bd6fff352e285feffd967fd10be) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 74.8 ms
  • End-to-End Runtime Task Cost    : 0.0211 ms/op
  • Peak RSS Memory        : 180.1 MB
  • RSS Heap Memory             : 94.19 MB
  • Raw Worker IPC Round-Trip      : 0.0189 ms/op
  • Scheduler + Graph Overhead     : 0.0022 ms/op
  • Settled Cooldown RSS   : 84.5 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.59 MB
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
| Yatta     |      70,559 |     1.00x |    21% | 1.57ms | 2.95ms | 5.17ms |
| Raw Bun   |      59,884 |     0.85x |     9% | 1.45ms | 3.20ms | 3.46ms |
| Hono      |      69,326 |     0.98x |    18% | 1.47ms | 3.10ms | 3.23ms |
| Elysia    |      56,731 |     0.80x |    27% | 1.57ms | 3.21ms | 3.34ms |
| Express   |      36,410 |     0.52x |     6% | 2.69ms | 4.44ms | 6.12ms |
| Fastify   |      47,122 |     0.67x |    15% | 2.30ms | 5.02ms | 7.01ms |
| Koa       |      41,661 |     0.59x |    19% | 2.68ms | 5.45ms | 8.14ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,236 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.5 ms |              200,238 |       0.18 |       0.27 |       0.27 |       0.27 |
|         500 |     1.2 ms |              426,706 |       0.63 |       0.94 |       0.98 |       1.00 |
|        1000 |     2.0 ms |              489,790 |       0.97 |       1.23 |       1.28 |       1.31 |
|        5000 |    14.6 ms |              342,549 |       8.01 |      10.64 |      10.79 |      10.83 |
|       10000 |    29.7 ms |              336,877 |      15.79 |      23.55 |      23.70 |      23.72 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.0 ms |            167,107 |     2.71 |     3.10 |     3.61 |       3.66 |     3.66 |
|        5000 |   13.2 ms |            380,167 |     6.52 |     8.09 |     8.41 |       8.41 |     8.41 |
|       10000 |   32.5 ms |            307,962 |    17.30 |    25.80 |    26.30 |      26.30 |    26.30 |
|       25000 |   62.5 ms |            400,298 |    27.58 |    45.95 |    48.87 |      48.90 |    48.90 |
|       50000 |  127.0 ms |            393,847 |    63.71 |    98.38 |   107.06 |     107.38 |   107.39 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            125,551 |     3.84 |     5.71 |     6.39 |       6.49 |     6.49 |
|        5000 |   31.8 ms |            157,297 |    15.17 |    25.52 |    26.19 |      26.24 |    26.24 |
|       10000 |   60.3 ms |            165,813 |    32.48 |    49.92 |    52.18 |      52.25 |    52.26 |
|       25000 |  163.7 ms |            152,728 |    79.23 |   138.08 |   149.11 |     149.60 |   149.62 |
|       50000 |  374.6 ms |            133,478 |   191.49 |   321.24 |   349.00 |     350.02 |   350.08 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.5 ms |             68,910 |     8.22 |    12.76 |    13.72 |      13.87 |    13.87 |
|        5000 |   63.4 ms |             78,908 |    31.74 |    54.05 |    58.95 |      59.51 |    59.60 |
|       10000 |  146.9 ms |             68,080 |    69.01 |   114.06 |   141.80 |     143.50 |   143.72 |

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
  • Raw Worker IPC Round-Trip      : 0.0189 ms/op
  • End-to-End Runtime Task Cost    : 0.0211 ms/op
  • Scheduler + Graph Overhead     : 0.0022 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,236 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.5 ms |              200,238 |       0.18 |       0.27 |       0.27 |       0.27 |
|         500 |     1.2 ms |              426,706 |       0.63 |       0.94 |       0.98 |       1.00 |
|        1000 |     2.0 ms |              489,790 |       0.97 |       1.23 |       1.28 |       1.31 |
|        5000 |    14.6 ms |              342,549 |       8.01 |      10.64 |      10.79 |      10.83 |
|       10000 |    29.7 ms |              336,877 |      15.79 |      23.55 |      23.70 |      23.72 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 94.19 MB
  • V8/JSC Heap Used             : 13.59 MB

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
| 1 CPU + 1 IO  |       2 |   34.9 ms |            286,159 |    15.39 |    27.70 |    28.23 |    28.82 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   39.9 ms |            250,500 |    19.64 |    31.39 |    31.54 |    31.59 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.4 ms |            394,085 |    12.66 |    19.43 |    19.80 |    19.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   31.2 ms |            320,261 |    16.01 |    24.62 |    24.97 |    24.98 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 74.8 ms
  • Peak Throughput Rate       : 334,427 ops/sec
  • Latency Distribution       : p50: 39.76ms | p90: 61.91ms | p99: 62.93ms | p99.9: 63.01ms | Max: 63.02ms
  • Memory (RSS)               : Baseline: 112.9 MB | Peak: 138.1 MB | Cooldown: 103.9 MB

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
|        1000 |    6.0 ms |            167,107 |     2.71 |     3.10 |     3.61 |       3.66 |     3.66 |
|        5000 |   13.2 ms |            380,167 |     6.52 |     8.09 |     8.41 |       8.41 |     8.41 |
|       10000 |   32.5 ms |            307,962 |    17.30 |    25.80 |    26.30 |      26.30 |    26.30 |
|       25000 |   62.5 ms |            400,298 |    27.58 |    45.95 |    48.87 |      48.90 |    48.90 |
|       50000 |  127.0 ms |            393,847 |    63.71 |    98.38 |   107.06 |     107.38 |   107.39 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            125,551 |     3.84 |     5.71 |     6.39 |       6.49 |     6.49 |
|        5000 |   31.8 ms |            157,297 |    15.17 |    25.52 |    26.19 |      26.24 |    26.24 |
|       10000 |   60.3 ms |            165,813 |    32.48 |    49.92 |    52.18 |      52.25 |    52.26 |
|       25000 |  163.7 ms |            152,728 |    79.23 |   138.08 |   149.11 |     149.60 |   149.62 |
|       50000 |  374.6 ms |            133,478 |   191.49 |   321.24 |   349.00 |     350.02 |   350.08 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.5 ms |             68,910 |     8.22 |    12.76 |    13.72 |      13.87 |    13.87 |
|        5000 |   63.4 ms |             78,908 |    31.74 |    54.05 |    58.95 |      59.51 |    59.60 |
|       10000 |  146.9 ms |             68,080 |    69.01 |   114.06 |   141.80 |     143.50 |   143.72 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 180.1 MB
  • Settled Cooldown RSS   : 84.5 MB (Clean GC release)

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
| Yatta     |      70,559 |     1.00x |    21% | 1.57ms | 2.95ms | 5.17ms |
| Raw Bun   |      59,884 |     0.85x |     9% | 1.45ms | 3.20ms | 3.46ms |
| Hono      |      69,326 |     0.98x |    18% | 1.47ms | 3.10ms | 3.23ms |
| Elysia    |      56,731 |     0.80x |    27% | 1.57ms | 3.21ms | 3.34ms |
| Express   |      36,410 |     0.52x |     6% | 2.69ms | 4.44ms | 6.12ms |
| Fastify   |      47,122 |     0.67x |    15% | 2.30ms | 5.02ms | 7.01ms |
| Koa       |      41,661 |     0.59x |    19% | 2.68ms | 5.45ms | 8.14ms |

  Yatta dispatch adds about -2.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 21%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
