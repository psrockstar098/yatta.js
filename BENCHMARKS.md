# Yatta Benchmarks

> Last run: `2026-11-03T16:03:56Z` · commit [`07499d7`](https://github.com/psrockstar098/yatta.js/commit/07499d76b26256e3b97a42726740d72fe011f785) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 80.8 ms
  • End-to-End Runtime Task Cost    : 0.0246 ms/op
  • Peak RSS Memory        : 184.1 MB
  • RSS Heap Memory             : 86.80 MB
  • Raw Worker IPC Round-Trip      : 0.0239 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op
  • Settled Cooldown RSS   : 72.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.33 MB
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
| Yatta     |      63,052 |     1.00x |     6% | 1.66ms | 2.65ms | 3.57ms |
| Raw Bun   |      46,380 |     0.74x |     4% | 1.86ms | 3.90ms | 4.28ms |
| Hono      |      52,432 |     0.83x |    14% | 1.76ms | 3.46ms | 3.92ms |
| Elysia    |      47,897 |     0.76x |    10% | 1.75ms | 3.65ms | 3.99ms |
| Express   |      26,351 |     0.42x |    16% | 3.52ms | 6.25ms | 7.51ms |
| Fastify   |      35,615 |     0.56x |    12% | 2.70ms | 4.76ms | 6.19ms |
| Koa       |      29,398 |     0.47x |    16% | 2.65ms | 5.53ms | 7.33ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,234 |       0.30 |       0.33 |       0.33 |       0.33 |
|         100 |     1.0 ms |              101,691 |       0.29 |       0.68 |       0.69 |       0.69 |
|         500 |     1.6 ms |              304,184 |       0.78 |       1.23 |       1.27 |       1.30 |
|        1000 |     2.8 ms |              351,230 |       1.44 |       2.11 |       2.13 |       2.15 |
|        5000 |    19.1 ms |              261,676 |       9.86 |      12.90 |      12.93 |      12.94 |
|       10000 |    30.7 ms |              326,013 |      16.28 |      23.31 |      23.98 |      24.06 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.7 ms |            149,179 |     3.01 |     4.36 |     5.34 |       5.44 |     5.44 |
|        5000 |   17.4 ms |            287,900 |     8.64 |    11.66 |    12.05 |      12.06 |    12.06 |
|       10000 |   35.2 ms |            284,389 |    16.89 |    26.66 |    27.51 |      27.51 |    27.51 |
|       25000 |   77.2 ms |            323,823 |    35.08 |    57.13 |    60.54 |      60.74 |    60.75 |
|       50000 |  163.5 ms |            305,882 |    81.09 |   127.06 |   137.17 |     137.49 |   137.52 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.5 ms |            117,212 |     4.29 |     6.41 |     7.40 |       7.61 |     7.61 |
|        5000 |   28.4 ms |            175,944 |    13.89 |    21.77 |    22.65 |      22.69 |    22.70 |
|       10000 |   70.3 ms |            142,322 |    36.62 |    60.95 |    62.32 |      62.39 |    62.39 |
|       25000 |  186.0 ms |            134,419 |   100.40 |   160.17 |   170.39 |     170.79 |   170.83 |
|       50000 |  375.5 ms |            133,157 |   190.03 |   318.35 |   346.61 |     347.25 |   347.31 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.3 ms |             54,499 |     9.02 |    15.89 |    17.07 |      17.61 |    17.61 |
|        5000 |   71.8 ms |             69,639 |    38.60 |    63.08 |    69.29 |      69.86 |    69.94 |
|       10000 |  147.8 ms |             67,675 |    72.75 |   125.44 |   141.15 |     143.80 |   144.04 |

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
  • Raw Worker IPC Round-Trip      : 0.0239 ms/op
  • End-to-End Runtime Task Cost    : 0.0246 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,234 |       0.30 |       0.33 |       0.33 |       0.33 |
|         100 |     1.0 ms |              101,691 |       0.29 |       0.68 |       0.69 |       0.69 |
|         500 |     1.6 ms |              304,184 |       0.78 |       1.23 |       1.27 |       1.30 |
|        1000 |     2.8 ms |              351,230 |       1.44 |       2.11 |       2.13 |       2.15 |
|        5000 |    19.1 ms |              261,676 |       9.86 |      12.90 |      12.93 |      12.94 |
|       10000 |    30.7 ms |              326,013 |      16.28 |      23.31 |      23.98 |      24.06 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 86.80 MB
  • V8/JSC Heap Used             : 13.33 MB

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
| 1 CPU + 1 IO  |       2 |   37.4 ms |            267,406 |    17.91 |    28.11 |    29.13 |    29.17 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   33.7 ms |            296,919 |    17.08 |    25.82 |    25.96 |    26.00 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.6 ms |            390,771 |    11.94 |    20.16 |    20.77 |    20.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   29.9 ms |            334,981 |    13.79 |    23.39 |    23.52 |    23.54 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 80.8 ms
  • Peak Throughput Rate       : 309,351 ops/sec
  • Latency Distribution       : p50: 37.76ms | p90: 64.30ms | p99: 66.88ms | p99.9: 67.01ms | Max: 67.04ms
  • Memory (RSS)               : Baseline: 96.8 MB | Peak: 131.2 MB | Cooldown: 103.7 MB

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
|        1000 |    6.7 ms |            149,179 |     3.01 |     4.36 |     5.34 |       5.44 |     5.44 |
|        5000 |   17.4 ms |            287,900 |     8.64 |    11.66 |    12.05 |      12.06 |    12.06 |
|       10000 |   35.2 ms |            284,389 |    16.89 |    26.66 |    27.51 |      27.51 |    27.51 |
|       25000 |   77.2 ms |            323,823 |    35.08 |    57.13 |    60.54 |      60.74 |    60.75 |
|       50000 |  163.5 ms |            305,882 |    81.09 |   127.06 |   137.17 |     137.49 |   137.52 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.5 ms |            117,212 |     4.29 |     6.41 |     7.40 |       7.61 |     7.61 |
|        5000 |   28.4 ms |            175,944 |    13.89 |    21.77 |    22.65 |      22.69 |    22.70 |
|       10000 |   70.3 ms |            142,322 |    36.62 |    60.95 |    62.32 |      62.39 |    62.39 |
|       25000 |  186.0 ms |            134,419 |   100.40 |   160.17 |   170.39 |     170.79 |   170.83 |
|       50000 |  375.5 ms |            133,157 |   190.03 |   318.35 |   346.61 |     347.25 |   347.31 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.3 ms |             54,499 |     9.02 |    15.89 |    17.07 |      17.61 |    17.61 |
|        5000 |   71.8 ms |             69,639 |    38.60 |    63.08 |    69.29 |      69.86 |    69.94 |
|       10000 |  147.8 ms |             67,675 |    72.75 |   125.44 |   141.15 |     143.80 |   144.04 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 184.1 MB
  • Settled Cooldown RSS   : 72.9 MB (Clean GC release)

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
| Yatta     |      63,052 |     1.00x |     6% | 1.66ms | 2.65ms | 3.57ms |
| Raw Bun   |      46,380 |     0.74x |     4% | 1.86ms | 3.90ms | 4.28ms |
| Hono      |      52,432 |     0.83x |    14% | 1.76ms | 3.46ms | 3.92ms |
| Elysia    |      47,897 |     0.76x |    10% | 1.75ms | 3.65ms | 3.99ms |
| Express   |      26,351 |     0.42x |    16% | 3.52ms | 6.25ms | 7.51ms |
| Fastify   |      35,615 |     0.56x |    12% | 2.70ms | 4.76ms | 6.19ms |
| Koa       |      29,398 |     0.47x |    16% | 2.65ms | 5.53ms | 7.33ms |

  Yatta dispatch adds about -5.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
