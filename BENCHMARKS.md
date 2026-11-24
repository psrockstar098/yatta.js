# Yatta Benchmarks

> Last run: `2026-11-24T12:10:18Z` · commit [`dac1fdc`](https://github.com/psrockstar098/yatta.js/commit/dac1fdc5e669b8420f49b8bb607ed293a32de697) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 77.1 ms
  • End-to-End Runtime Task Cost    : 0.0393 ms/op
  • Peak RSS Memory        : 152.1 MB
  • RSS Heap Memory             : 98.18 MB
  • Raw Worker IPC Round-Trip      : 0.0374 ms/op
  • Scheduler + Graph Overhead     : 0.0019 ms/op
  • Settled Cooldown RSS   : 115.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.37 MB
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      75,696 |     1.00x |    16% | 1.27ms | 2.40ms | 2.78ms |
| Raw Bun   |      68,422 |     0.90x |    23% | 1.31ms | 3.09ms | 3.52ms |
| Hono      |      74,935 |     0.99x |     9% | 1.23ms | 2.32ms | 2.65ms |
| Elysia    |      76,055 |     1.00x |     8% | 1.18ms | 2.30ms | 3.50ms |
| Express   |      32,936 |     0.44x |     7% | 2.68ms | 5.13ms | 6.43ms |
| Fastify   |      41,984 |     0.55x |     7% | 1.98ms | 4.44ms | 5.58ms |
| Koa       |      35,988 |     0.48x |    14% | 3.01ms | 5.44ms | 7.47ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,707 |       0.34 |       0.35 |       0.35 |       0.35 |
|         100 |     0.5 ms |              181,929 |       0.22 |       0.35 |       0.38 |       0.38 |
|         500 |     1.4 ms |              346,634 |       0.69 |       1.06 |       1.11 |       1.17 |
|        1000 |     3.0 ms |              334,454 |       1.53 |       2.32 |       2.39 |       2.43 |
|        5000 |    18.0 ms |              278,047 |       9.97 |      12.34 |      12.36 |      12.36 |
|       10000 |    34.6 ms |              289,020 |      16.44 |      26.15 |      26.32 |      26.41 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.5 ms |            117,241 |     3.54 |     5.81 |     7.32 |       7.64 |     7.64 |
|        5000 |   23.6 ms |            212,223 |    11.18 |    16.12 |    16.35 |      16.37 |    16.37 |
|       10000 |   33.8 ms |            296,126 |    17.54 |    25.45 |    26.24 |      26.38 |    26.39 |
|       25000 |   74.7 ms |            334,484 |    36.81 |    54.52 |    56.07 |      56.22 |    56.22 |
|       50000 |  131.3 ms |            380,940 |    60.98 |    96.01 |   104.14 |     104.62 |   104.62 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.9 ms |            101,398 |     4.86 |     7.22 |     8.18 |       8.28 |     8.28 |
|        5000 |   35.0 ms |            142,799 |    17.53 |    26.69 |    27.63 |      27.68 |    27.69 |
|       10000 |   82.4 ms |            121,324 |    38.44 |    70.80 |    73.35 |      73.52 |    73.53 |
|       25000 |  215.0 ms |            116,304 |   100.21 |   176.13 |   196.06 |     196.50 |   196.50 |
|       50000 |  392.4 ms |            127,434 |   210.05 |   335.84 |   360.92 |     362.01 |   362.09 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.5 ms |             40,871 |    13.29 |    20.55 |    23.19 |      23.62 |    23.62 |
|        5000 |  102.3 ms |             48,887 |    46.47 |    90.91 |    99.11 |     100.52 |   100.64 |
|       10000 |  180.1 ms |             55,517 |    85.50 |   153.35 |   172.21 |     175.04 |   175.31 |

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
  • Raw Worker IPC Round-Trip      : 0.0374 ms/op
  • End-to-End Runtime Task Cost    : 0.0393 ms/op
  • Scheduler + Graph Overhead     : 0.0019 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,707 |       0.34 |       0.35 |       0.35 |       0.35 |
|         100 |     0.5 ms |              181,929 |       0.22 |       0.35 |       0.38 |       0.38 |
|         500 |     1.4 ms |              346,634 |       0.69 |       1.06 |       1.11 |       1.17 |
|        1000 |     3.0 ms |              334,454 |       1.53 |       2.32 |       2.39 |       2.43 |
|        5000 |    18.0 ms |              278,047 |       9.97 |      12.34 |      12.36 |      12.36 |
|       10000 |    34.6 ms |              289,020 |      16.44 |      26.15 |      26.32 |      26.41 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 98.18 MB
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
| 1 CPU + 1 IO  |       2 |   57.8 ms |            173,151 |    25.96 |    41.41 |    45.95 |    46.09 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   32.5 ms |            307,307 |    16.51 |    23.48 |    23.73 |    23.76 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   26.0 ms |            383,882 |    11.74 |    20.04 |    20.58 |    20.72 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   29.5 ms |            339,083 |    14.51 |    22.69 |    22.95 |    23.10 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 77.1 ms
  • Peak Throughput Rate       : 324,077 ops/sec
  • Latency Distribution       : p50: 35.66ms | p90: 58.38ms | p99: 59.31ms | p99.9: 59.74ms | Max: 59.75ms
  • Memory (RSS)               : Baseline: 96.1 MB | Peak: 133.5 MB | Cooldown: 104.6 MB

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
|        1000 |    8.5 ms |            117,241 |     3.54 |     5.81 |     7.32 |       7.64 |     7.64 |
|        5000 |   23.6 ms |            212,223 |    11.18 |    16.12 |    16.35 |      16.37 |    16.37 |
|       10000 |   33.8 ms |            296,126 |    17.54 |    25.45 |    26.24 |      26.38 |    26.39 |
|       25000 |   74.7 ms |            334,484 |    36.81 |    54.52 |    56.07 |      56.22 |    56.22 |
|       50000 |  131.3 ms |            380,940 |    60.98 |    96.01 |   104.14 |     104.62 |   104.62 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.9 ms |            101,398 |     4.86 |     7.22 |     8.18 |       8.28 |     8.28 |
|        5000 |   35.0 ms |            142,799 |    17.53 |    26.69 |    27.63 |      27.68 |    27.69 |
|       10000 |   82.4 ms |            121,324 |    38.44 |    70.80 |    73.35 |      73.52 |    73.53 |
|       25000 |  215.0 ms |            116,304 |   100.21 |   176.13 |   196.06 |     196.50 |   196.50 |
|       50000 |  392.4 ms |            127,434 |   210.05 |   335.84 |   360.92 |     362.01 |   362.09 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.5 ms |             40,871 |    13.29 |    20.55 |    23.19 |      23.62 |    23.62 |
|        5000 |  102.3 ms |             48,887 |    46.47 |    90.91 |    99.11 |     100.52 |   100.64 |
|       10000 |  180.1 ms |             55,517 |    85.50 |   153.35 |   172.21 |     175.04 |   175.31 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 152.1 MB
  • Settled Cooldown RSS   : 115.7 MB (Clean GC release)

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
| Yatta     |      75,696 |     1.00x |    16% | 1.27ms | 2.40ms | 2.78ms |
| Raw Bun   |      68,422 |     0.90x |    23% | 1.31ms | 3.09ms | 3.52ms |
| Hono      |      74,935 |     0.99x |     9% | 1.23ms | 2.32ms | 2.65ms |
| Elysia    |      76,055 |     1.00x |     8% | 1.18ms | 2.30ms | 3.50ms |
| Express   |      32,936 |     0.44x |     7% | 2.68ms | 5.13ms | 6.43ms |
| Fastify   |      41,984 |     0.55x |     7% | 1.98ms | 4.44ms | 5.58ms |
| Koa       |      35,988 |     0.48x |    14% | 3.01ms | 5.44ms | 7.47ms |

  Yatta dispatch adds about -1.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 16%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
