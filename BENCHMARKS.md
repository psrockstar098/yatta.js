# Yatta Benchmarks

> Last run: `2026-11-10T18:00:20Z` · commit [`2cd40ff`](https://github.com/psrockstar098/yatta.js/commit/2cd40ff0fa9d274f20cdd32cc8439c21fdc6b4d9) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 59.8 ms
  • End-to-End Runtime Task Cost    : 0.0192 ms/op
  • Peak RSS Memory        : 208.0 MB
  • RSS Heap Memory             : 88.01 MB
  • Raw Worker IPC Round-Trip      : 0.0186 ms/op
  • Scheduler + Graph Overhead     : 0.0006 ms/op
  • Settled Cooldown RSS   : 76.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.53 MB
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
| Yatta     |      62,669 |     1.00x |     8% | 1.37ms | 2.81ms | 3.20ms |
| Raw Bun   |      55,629 |     0.89x |     5% | 1.51ms | 3.15ms | 3.22ms |
| Hono      |      56,706 |     0.90x |     8% | 1.57ms | 3.25ms | 3.71ms |
| Elysia    |      60,336 |     0.96x |    30% | 1.23ms | 2.80ms | 3.36ms |
| Express   |      42,154 |     0.67x |     4% | 2.22ms | 4.25ms | 6.03ms |
| Fastify   |      53,626 |     0.86x |     7% | 1.86ms | 3.27ms | 4.60ms |
| Koa       |      46,197 |     0.74x |    10% | 2.16ms | 3.93ms | 7.54ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,154 |       0.19 |       0.21 |       0.21 |       0.21 |
|         100 |     0.6 ms |              172,926 |       0.24 |       0.34 |       0.34 |       0.34 |
|         500 |     1.0 ms |              490,515 |       0.51 |       0.79 |       0.82 |       0.84 |
|        1000 |     1.9 ms |              517,278 |       0.96 |       1.49 |       1.55 |       1.60 |
|        5000 |    11.9 ms |              420,975 |       6.31 |       8.13 |       8.31 |       8.33 |
|       10000 |    23.9 ms |              418,713 |      12.31 |      18.35 |      18.69 |      18.73 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.6 ms |            151,803 |     2.95 |     4.14 |     4.42 |       4.47 |     4.47 |
|        5000 |   12.8 ms |            389,300 |     6.39 |     7.68 |     7.94 |       7.98 |     7.98 |
|       10000 |   30.2 ms |            331,205 |    15.67 |    23.48 |    24.29 |      24.29 |    24.29 |
|       25000 |   67.7 ms |            369,328 |    32.02 |    52.18 |    55.48 |      55.49 |    55.49 |
|       50000 |  124.2 ms |            402,661 |    60.11 |    99.63 |   106.29 |     106.32 |   106.33 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.4 ms |            135,428 |     3.62 |     5.41 |     6.16 |       6.25 |     6.25 |
|        5000 |   31.4 ms |            159,226 |    15.08 |    23.68 |    24.41 |      24.45 |    24.46 |
|       10000 |   58.2 ms |            171,747 |    32.70 |    48.66 |    50.26 |      50.34 |    50.42 |
|       25000 |  148.6 ms |            168,216 |    82.73 |   128.56 |   136.81 |     137.13 |   137.35 |
|       50000 |  331.1 ms |            150,991 |   175.40 |   285.08 |   303.29 |     304.13 |   304.17 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.8 ms |             63,137 |     8.50 |    14.00 |    14.99 |      15.16 |    15.16 |
|        5000 |   68.4 ms |             73,078 |    29.57 |    51.39 |    65.92 |      66.91 |    67.00 |
|       10000 |  133.8 ms |             74,731 |    60.84 |   114.16 |   129.41 |     131.22 |   131.40 |

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
  • Raw Worker IPC Round-Trip      : 0.0186 ms/op
  • End-to-End Runtime Task Cost    : 0.0192 ms/op
  • Scheduler + Graph Overhead     : 0.0006 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,154 |       0.19 |       0.21 |       0.21 |       0.21 |
|         100 |     0.6 ms |              172,926 |       0.24 |       0.34 |       0.34 |       0.34 |
|         500 |     1.0 ms |              490,515 |       0.51 |       0.79 |       0.82 |       0.84 |
|        1000 |     1.9 ms |              517,278 |       0.96 |       1.49 |       1.55 |       1.60 |
|        5000 |    11.9 ms |              420,975 |       6.31 |       8.13 |       8.31 |       8.33 |
|       10000 |    23.9 ms |              418,713 |      12.31 |      18.35 |      18.69 |      18.73 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 88.01 MB
  • V8/JSC Heap Used             : 13.53 MB

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
| 1 CPU + 1 IO  |       2 |   28.7 ms |            347,872 |    12.81 |    22.27 |    23.03 |    23.11 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   25.4 ms |            393,803 |    11.84 |    19.50 |    19.58 |    19.59 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   22.8 ms |            438,474 |    10.64 |    17.90 |    18.26 |    18.36 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   23.9 ms |            417,969 |    10.45 |    18.89 |    19.07 |    19.09 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 59.8 ms
  • Peak Throughput Rate       : 417,852 ops/sec
  • Latency Distribution       : p50: 30.91ms | p90: 46.56ms | p99: 47.29ms | p99.9: 47.32ms | Max: 47.32ms
  • Memory (RSS)               : Baseline: 97.5 MB | Peak: 132.9 MB | Cooldown: 103.6 MB

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
|        1000 |    6.6 ms |            151,803 |     2.95 |     4.14 |     4.42 |       4.47 |     4.47 |
|        5000 |   12.8 ms |            389,300 |     6.39 |     7.68 |     7.94 |       7.98 |     7.98 |
|       10000 |   30.2 ms |            331,205 |    15.67 |    23.48 |    24.29 |      24.29 |    24.29 |
|       25000 |   67.7 ms |            369,328 |    32.02 |    52.18 |    55.48 |      55.49 |    55.49 |
|       50000 |  124.2 ms |            402,661 |    60.11 |    99.63 |   106.29 |     106.32 |   106.33 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.4 ms |            135,428 |     3.62 |     5.41 |     6.16 |       6.25 |     6.25 |
|        5000 |   31.4 ms |            159,226 |    15.08 |    23.68 |    24.41 |      24.45 |    24.46 |
|       10000 |   58.2 ms |            171,747 |    32.70 |    48.66 |    50.26 |      50.34 |    50.42 |
|       25000 |  148.6 ms |            168,216 |    82.73 |   128.56 |   136.81 |     137.13 |   137.35 |
|       50000 |  331.1 ms |            150,991 |   175.40 |   285.08 |   303.29 |     304.13 |   304.17 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.8 ms |             63,137 |     8.50 |    14.00 |    14.99 |      15.16 |    15.16 |
|        5000 |   68.4 ms |             73,078 |    29.57 |    51.39 |    65.92 |      66.91 |    67.00 |
|       10000 |  133.8 ms |             74,731 |    60.84 |   114.16 |   129.41 |     131.22 |   131.40 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 208.0 MB
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
| Yatta     |      62,669 |     1.00x |     8% | 1.37ms | 2.81ms | 3.20ms |
| Raw Bun   |      55,629 |     0.89x |     5% | 1.51ms | 3.15ms | 3.22ms |
| Hono      |      56,706 |     0.90x |     8% | 1.57ms | 3.25ms | 3.71ms |
| Elysia    |      60,336 |     0.96x |    30% | 1.23ms | 2.80ms | 3.36ms |
| Express   |      42,154 |     0.67x |     4% | 2.22ms | 4.25ms | 6.03ms |
| Fastify   |      53,626 |     0.86x |     7% | 1.86ms | 3.27ms | 4.60ms |
| Koa       |      46,197 |     0.74x |    10% | 2.16ms | 3.93ms | 7.54ms |

  Yatta dispatch adds about -2.0µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
