# Yatta Benchmarks

> Last run: `2026-11-15T13:06:10Z` · commit [`adca95b`](https://github.com/psrockstar098/yatta.js/commit/adca95b414e3aa0152128cd2bfa719f5f12817cc) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 62.9 ms
  • End-to-End Runtime Task Cost    : 0.0199 ms/op
  • Peak RSS Memory        : 215.7 MB
  • RSS Heap Memory             : 87.49 MB
  • Raw Worker IPC Round-Trip      : 0.0184 ms/op
  • Scheduler + Graph Overhead     : 0.0015 ms/op
  • Settled Cooldown RSS   : 75.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.37 MB
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
| Yatta     |      73,440 |     1.00x |    30% | 1.31ms | 2.80ms | 3.19ms |
| Raw Bun   |      53,847 |     0.73x |     5% | 1.59ms | 3.22ms | 3.28ms |
| Hono      |      57,737 |     0.79x |    12% | 1.51ms | 3.17ms | 3.45ms |
| Elysia    |      56,326 |     0.77x |    34% | 1.28ms | 2.77ms | 2.90ms |
| Express   |      42,785 |     0.58x |     5% | 2.11ms | 3.81ms | 5.20ms |
| Fastify   |      55,194 |     0.75x |     3% | 1.81ms | 2.87ms | 4.34ms |
| Koa       |      47,983 |     0.65x |     9% | 1.91ms | 3.43ms | 5.81ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               22,626 |       0.22 |       0.24 |       0.24 |       0.24 |
|         100 |     0.4 ms |              233,112 |       0.18 |       0.24 |       0.25 |       0.25 |
|         500 |     1.1 ms |              471,546 |       0.47 |       0.79 |       0.84 |       0.87 |
|        1000 |     2.0 ms |              507,984 |       0.97 |       1.53 |       1.59 |       1.63 |
|        5000 |    13.2 ms |              379,863 |       6.83 |       8.76 |       8.77 |       8.79 |
|       10000 |    22.9 ms |              436,794 |      11.16 |      17.23 |      17.63 |      17.65 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.8 ms |            207,421 |     2.16 |     2.92 |     3.80 |       4.03 |     4.03 |
|        5000 |   13.3 ms |            375,354 |     5.76 |     8.28 |     8.67 |       8.67 |     8.67 |
|       10000 |   31.4 ms |            318,311 |    17.06 |    22.65 |    23.56 |      23.63 |    23.63 |
|       25000 |   61.8 ms |            404,290 |    29.38 |    48.22 |    50.61 |      50.73 |    50.73 |
|       50000 |  112.1 ms |            446,199 |    58.22 |    87.71 |    91.86 |      92.22 |    92.27 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.9 ms |            144,478 |     3.29 |     4.93 |     5.68 |       6.01 |     6.01 |
|        5000 |   23.4 ms |            213,724 |    11.25 |    17.47 |    18.11 |      18.15 |    18.16 |
|       10000 |   52.1 ms |            191,946 |    27.85 |    42.73 |    44.30 |      44.38 |    44.38 |
|       25000 |  161.1 ms |            155,171 |    79.44 |   140.65 |   149.87 |     150.06 |   150.08 |
|       50000 |  308.2 ms |            162,235 |   159.22 |   266.69 |   286.98 |     287.66 |   287.90 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.8 ms |             67,641 |     8.29 |    12.58 |    14.11 |      14.31 |    14.31 |
|        5000 |   59.5 ms |             83,982 |    29.45 |    51.34 |    56.02 |      56.62 |    56.71 |
|       10000 |  128.5 ms |             77,792 |    57.16 |    98.03 |   123.69 |     125.60 |   125.80 |

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
  • Raw Worker IPC Round-Trip      : 0.0184 ms/op
  • End-to-End Runtime Task Cost    : 0.0199 ms/op
  • Scheduler + Graph Overhead     : 0.0015 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               22,626 |       0.22 |       0.24 |       0.24 |       0.24 |
|         100 |     0.4 ms |              233,112 |       0.18 |       0.24 |       0.25 |       0.25 |
|         500 |     1.1 ms |              471,546 |       0.47 |       0.79 |       0.84 |       0.87 |
|        1000 |     2.0 ms |              507,984 |       0.97 |       1.53 |       1.59 |       1.63 |
|        5000 |    13.2 ms |              379,863 |       6.83 |       8.76 |       8.77 |       8.79 |
|       10000 |    22.9 ms |              436,794 |      11.16 |      17.23 |      17.63 |      17.65 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.09 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 87.49 MB
  • V8/JSC Heap Used             : 13.37 MB

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
| 1 CPU + 1 IO  |       2 |   32.2 ms |            310,561 |    17.31 |    24.84 |    25.61 |    25.83 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   29.2 ms |            342,634 |    13.78 |    22.99 |    23.13 |    23.15 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   23.5 ms |            426,273 |    10.32 |    15.83 |    16.37 |    16.68 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   21.3 ms |            469,323 |    10.49 |    16.01 |    16.25 |    16.33 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 62.9 ms
  • Peak Throughput Rate       : 397,667 ops/sec
  • Latency Distribution       : p50: 29.13ms | p90: 49.26ms | p99: 49.88ms | p99.9: 49.90ms | Max: 49.90ms
  • Memory (RSS)               : Baseline: 95.4 MB | Peak: 129.1 MB | Cooldown: 101.4 MB

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
|        1000 |    4.8 ms |            207,421 |     2.16 |     2.92 |     3.80 |       4.03 |     4.03 |
|        5000 |   13.3 ms |            375,354 |     5.76 |     8.28 |     8.67 |       8.67 |     8.67 |
|       10000 |   31.4 ms |            318,311 |    17.06 |    22.65 |    23.56 |      23.63 |    23.63 |
|       25000 |   61.8 ms |            404,290 |    29.38 |    48.22 |    50.61 |      50.73 |    50.73 |
|       50000 |  112.1 ms |            446,199 |    58.22 |    87.71 |    91.86 |      92.22 |    92.27 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.9 ms |            144,478 |     3.29 |     4.93 |     5.68 |       6.01 |     6.01 |
|        5000 |   23.4 ms |            213,724 |    11.25 |    17.47 |    18.11 |      18.15 |    18.16 |
|       10000 |   52.1 ms |            191,946 |    27.85 |    42.73 |    44.30 |      44.38 |    44.38 |
|       25000 |  161.1 ms |            155,171 |    79.44 |   140.65 |   149.87 |     150.06 |   150.08 |
|       50000 |  308.2 ms |            162,235 |   159.22 |   266.69 |   286.98 |     287.66 |   287.90 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.8 ms |             67,641 |     8.29 |    12.58 |    14.11 |      14.31 |    14.31 |
|        5000 |   59.5 ms |             83,982 |    29.45 |    51.34 |    56.02 |      56.62 |    56.71 |
|       10000 |  128.5 ms |             77,792 |    57.16 |    98.03 |   123.69 |     125.60 |   125.80 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 215.7 MB
  • Settled Cooldown RSS   : 75.1 MB (Clean GC release)

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
| Yatta     |      73,440 |     1.00x |    30% | 1.31ms | 2.80ms | 3.19ms |
| Raw Bun   |      53,847 |     0.73x |     5% | 1.59ms | 3.22ms | 3.28ms |
| Hono      |      57,737 |     0.79x |    12% | 1.51ms | 3.17ms | 3.45ms |
| Elysia    |      56,326 |     0.77x |    34% | 1.28ms | 2.77ms | 2.90ms |
| Express   |      42,785 |     0.58x |     5% | 2.11ms | 3.81ms | 5.20ms |
| Fastify   |      55,194 |     0.75x |     3% | 1.81ms | 2.87ms | 4.34ms |
| Koa       |      47,983 |     0.65x |     9% | 1.91ms | 3.43ms | 5.81ms |

  Yatta dispatch adds about -5.0µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 30%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
