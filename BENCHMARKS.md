# Yatta Benchmarks

> Last run: `2026-11-05T03:52:52Z` · commit [`39165bb`](https://github.com/psrockstar098/yatta.js/commit/39165bb17f4a90fddb1043608f522c0628fd0d0c) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 66.4 ms
  • End-to-End Runtime Task Cost    : 0.0208 ms/op
  • Peak RSS Memory        : 188.8 MB
  • RSS Heap Memory             : 87.38 MB
  • Raw Worker IPC Round-Trip      : 0.0183 ms/op
  • Scheduler + Graph Overhead     : 0.0025 ms/op
  • Settled Cooldown RSS   : 76.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.00 MB
  • Worker Fleet Event Loop Lag : 10.09 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      58,925 |     1.00x |    30% | 1.58ms | 3.30ms | 4.22ms |
| Raw Bun   |      58,143 |     0.99x |     5% | 1.43ms | 3.26ms | 4.80ms |
| Hono      |      57,400 |     0.97x |    13% | 1.61ms | 3.26ms | 3.36ms |
| Elysia    |      54,989 |     0.93x |    13% | 1.62ms | 3.38ms | 4.42ms |
| Express   |      40,749 |     0.69x |     8% | 2.22ms | 4.51ms | 5.67ms |
| Fastify   |      54,092 |     0.92x |     7% | 1.90ms | 3.07ms | 4.35ms |
| Koa       |      46,356 |     0.79x |     9% | 2.05ms | 4.80ms | 7.60ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               21,901 |       0.24 |       0.25 |       0.25 |       0.25 |
|         100 |     0.6 ms |              160,388 |       0.16 |       0.45 |       0.45 |       0.45 |
|         500 |     1.0 ms |              484,236 |       0.52 |       0.79 |       0.81 |       0.81 |
|        1000 |     2.1 ms |              477,959 |       1.01 |       1.61 |       1.64 |       1.67 |
|        5000 |    11.6 ms |              430,759 |       6.15 |       8.05 |       8.13 |       8.13 |
|       10000 |    24.4 ms |              409,043 |      12.48 |      17.84 |      18.51 |      18.67 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.9 ms |            202,245 |     1.89 |     2.86 |     3.11 |       3.14 |     3.14 |
|        5000 |   11.9 ms |            420,060 |     5.81 |     7.72 |     8.03 |       8.03 |     8.03 |
|       10000 |   28.8 ms |            347,469 |    14.99 |    21.57 |    22.23 |      22.25 |    22.25 |
|       25000 |   61.6 ms |            406,051 |    29.07 |    46.44 |    48.73 |      48.75 |    48.76 |
|       50000 |  115.4 ms |            433,189 |    57.68 |    91.23 |    95.41 |      95.74 |    95.78 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.6 ms |            116,507 |     4.13 |     6.43 |     7.04 |       7.30 |     7.30 |
|        5000 |   27.8 ms |            179,979 |    14.65 |    21.70 |    22.30 |      22.34 |    22.34 |
|       10000 |   61.4 ms |            162,839 |    29.17 |    50.75 |    52.62 |      52.67 |    52.68 |
|       25000 |  164.3 ms |            152,182 |    79.69 |   139.16 |   148.18 |     148.48 |   148.52 |
|       50000 |  321.0 ms |            155,741 |   171.37 |   271.54 |   295.82 |     296.71 |   296.75 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.4 ms |             64,841 |     7.81 |    13.14 |    14.70 |      14.90 |    14.90 |
|        5000 |   61.9 ms |             80,757 |    32.32 |    53.65 |    58.27 |      59.24 |    59.32 |
|       10000 |  130.0 ms |             76,926 |    60.42 |   108.17 |   124.28 |     125.82 |   126.00 |

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
  • Raw Worker IPC Round-Trip      : 0.0183 ms/op
  • End-to-End Runtime Task Cost    : 0.0208 ms/op
  • Scheduler + Graph Overhead     : 0.0025 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               21,901 |       0.24 |       0.25 |       0.25 |       0.25 |
|         100 |     0.6 ms |              160,388 |       0.16 |       0.45 |       0.45 |       0.45 |
|         500 |     1.0 ms |              484,236 |       0.52 |       0.79 |       0.81 |       0.81 |
|        1000 |     2.1 ms |              477,959 |       1.01 |       1.61 |       1.64 |       1.67 |
|        5000 |    11.6 ms |              430,759 |       6.15 |       8.05 |       8.13 |       8.13 |
|       10000 |    24.4 ms |              409,043 |      12.48 |      17.84 |      18.51 |      18.67 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.09 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 87.38 MB
  • V8/JSC Heap Used             : 13.00 MB

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
| 1 CPU + 1 IO  |       2 |   31.2 ms |            321,000 |    15.16 |    23.78 |    24.29 |    24.40 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   36.2 ms |            276,278 |    18.17 |    28.06 |    29.31 |    29.54 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.1 ms |            285,284 |    17.14 |    28.97 |    29.32 |    29.40 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   32.0 ms |            312,205 |    15.82 |    25.61 |    25.66 |    25.66 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 66.4 ms
  • Peak Throughput Rate       : 376,556 ops/sec
  • Latency Distribution       : p50: 33.56ms | p90: 53.22ms | p99: 53.99ms | p99.9: 54.23ms | Max: 54.26ms
  • Memory (RSS)               : Baseline: 98.6 MB | Peak: 131.3 MB | Cooldown: 102.5 MB

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
|        1000 |    4.9 ms |            202,245 |     1.89 |     2.86 |     3.11 |       3.14 |     3.14 |
|        5000 |   11.9 ms |            420,060 |     5.81 |     7.72 |     8.03 |       8.03 |     8.03 |
|       10000 |   28.8 ms |            347,469 |    14.99 |    21.57 |    22.23 |      22.25 |    22.25 |
|       25000 |   61.6 ms |            406,051 |    29.07 |    46.44 |    48.73 |      48.75 |    48.76 |
|       50000 |  115.4 ms |            433,189 |    57.68 |    91.23 |    95.41 |      95.74 |    95.78 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.6 ms |            116,507 |     4.13 |     6.43 |     7.04 |       7.30 |     7.30 |
|        5000 |   27.8 ms |            179,979 |    14.65 |    21.70 |    22.30 |      22.34 |    22.34 |
|       10000 |   61.4 ms |            162,839 |    29.17 |    50.75 |    52.62 |      52.67 |    52.68 |
|       25000 |  164.3 ms |            152,182 |    79.69 |   139.16 |   148.18 |     148.48 |   148.52 |
|       50000 |  321.0 ms |            155,741 |   171.37 |   271.54 |   295.82 |     296.71 |   296.75 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.4 ms |             64,841 |     7.81 |    13.14 |    14.70 |      14.90 |    14.90 |
|        5000 |   61.9 ms |             80,757 |    32.32 |    53.65 |    58.27 |      59.24 |    59.32 |
|       10000 |  130.0 ms |             76,926 |    60.42 |   108.17 |   124.28 |     125.82 |   126.00 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 188.8 MB
  • Settled Cooldown RSS   : 76.0 MB (Clean GC release)

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
| Yatta     |      58,925 |     1.00x |    30% | 1.58ms | 3.30ms | 4.22ms |
| Raw Bun   |      58,143 |     0.99x |     5% | 1.43ms | 3.26ms | 4.80ms |
| Hono      |      57,400 |     0.97x |    13% | 1.61ms | 3.26ms | 3.36ms |
| Elysia    |      54,989 |     0.93x |    13% | 1.62ms | 3.38ms | 4.42ms |
| Express   |      40,749 |     0.69x |     8% | 2.22ms | 4.51ms | 5.67ms |
| Fastify   |      54,092 |     0.92x |     7% | 1.90ms | 3.07ms | 4.35ms |
| Koa       |      46,356 |     0.79x |     9% | 2.05ms | 4.80ms | 7.60ms |

  Yatta dispatch adds about -0.2µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 30%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
