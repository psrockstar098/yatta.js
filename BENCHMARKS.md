# Yatta Benchmarks

> Last run: `2026-11-24T05:39:07Z` · commit [`089625a`](https://github.com/psrockstar098/yatta.js/commit/089625aeb1337c4e5df811df16a64131004c30c1) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 64.5 ms
  • End-to-End Runtime Task Cost    : 0.0172 ms/op
  • Peak RSS Memory        : 221.8 MB
  • RSS Heap Memory             : 93.59 MB
  • Raw Worker IPC Round-Trip      : 0.0124 ms/op
  • Scheduler + Graph Overhead     : 0.0048 ms/op
  • Settled Cooldown RSS   : 85.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 11.26 MB
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
| Yatta     |      94,471 |     1.00x |     4% | 1.15ms | 1.61ms | 2.24ms |
| Raw Bun   |     120,278 |     1.27x |     6% | 0.91ms | 1.14ms | 1.51ms |
| Hono      |     101,599 |     1.08x |     6% | 1.06ms | 1.50ms | 1.94ms |
| Elysia    |     116,231 |     1.23x |     5% | 0.97ms | 1.23ms | 1.64ms |
| Express   |      42,996 |     0.46x |     4% | 2.24ms | 4.62ms | 6.13ms |
| Fastify   |      53,747 |     0.57x |     2% | 1.68ms | 3.52ms | 4.02ms |
| Koa       |      46,837 |     0.50x |     2% | 2.04ms | 4.01ms | 4.77ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               18,530 |       0.26 |       0.27 |       0.27 |       0.27 |
|         100 |     0.5 ms |              188,357 |       0.20 |       0.29 |       0.30 |       0.30 |
|         500 |     1.2 ms |              407,853 |       0.62 |       0.92 |       0.97 |       0.98 |
|        1000 |     2.4 ms |              416,219 |       1.12 |       1.66 |       1.70 |       1.71 |
|        5000 |    15.9 ms |              314,649 |       8.97 |      11.19 |      11.25 |      11.28 |
|       10000 |    26.0 ms |              384,431 |      14.67 |      19.55 |      20.60 |      20.75 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.8 ms |            128,121 |     3.09 |     5.72 |     6.78 |       7.03 |     7.03 |
|        5000 |   15.5 ms |            322,195 |     7.75 |    10.46 |    10.86 |      10.88 |    10.88 |
|       10000 |   27.4 ms |            365,260 |    13.48 |    20.06 |    20.99 |      21.02 |    21.02 |
|       25000 |   61.6 ms |            405,778 |    24.45 |    47.61 |    49.02 |      49.12 |    49.14 |
|       50000 |  106.4 ms |            469,998 |    57.53 |    79.95 |    84.91 |      84.98 |    84.99 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            103,344 |     5.61 |     6.80 |     7.32 |       7.38 |     7.38 |
|        5000 |   35.7 ms |            139,902 |    18.27 |    27.54 |    28.31 |      28.36 |    28.37 |
|       10000 |   65.4 ms |            152,957 |    32.78 |    54.09 |    56.35 |      56.45 |    56.46 |
|       25000 |  181.5 ms |            137,727 |    89.83 |   158.50 |   168.76 |     169.16 |   169.19 |
|       50000 |  341.5 ms |            146,428 |   189.63 |   287.32 |   313.55 |     314.36 |   314.42 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.5 ms |             87,092 |     6.39 |     9.66 |    10.60 |      10.76 |    10.76 |
|        5000 |   47.6 ms |            105,062 |    25.87 |    41.60 |    45.00 |      45.73 |    45.79 |
|       10000 |  104.5 ms |             95,680 |    45.56 |    85.44 |    98.38 |     100.11 |   100.44 |

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
  • Raw Worker IPC Round-Trip      : 0.0124 ms/op
  • End-to-End Runtime Task Cost    : 0.0172 ms/op
  • Scheduler + Graph Overhead     : 0.0048 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               18,530 |       0.26 |       0.27 |       0.27 |       0.27 |
|         100 |     0.5 ms |              188,357 |       0.20 |       0.29 |       0.30 |       0.30 |
|         500 |     1.2 ms |              407,853 |       0.62 |       0.92 |       0.97 |       0.98 |
|        1000 |     2.4 ms |              416,219 |       1.12 |       1.66 |       1.70 |       1.71 |
|        5000 |    15.9 ms |              314,649 |       8.97 |      11.19 |      11.25 |      11.28 |
|       10000 |    26.0 ms |              384,431 |      14.67 |      19.55 |      20.60 |      20.75 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.59 MB
  • V8/JSC Heap Used             : 11.26 MB

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
| 1 CPU + 1 IO  |       2 |   34.2 ms |            292,552 |    16.89 |    23.17 |    25.65 |    25.72 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   27.9 ms |            358,689 |    15.63 |    21.23 |    21.82 |    21.96 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   25.6 ms |            390,403 |    10.59 |    18.99 |    19.89 |    20.21 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   26.1 ms |            382,896 |    14.67 |    18.91 |    19.04 |    19.04 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 64.5 ms
  • Peak Throughput Rate       : 387,701 ops/sec
  • Latency Distribution       : p50: 30.13ms | p90: 50.99ms | p99: 51.75ms | p99.9: 51.79ms | Max: 51.80ms
  • Memory (RSS)               : Baseline: 106.2 MB | Peak: 132.5 MB | Cooldown: 101.5 MB

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
|        1000 |    7.8 ms |            128,121 |     3.09 |     5.72 |     6.78 |       7.03 |     7.03 |
|        5000 |   15.5 ms |            322,195 |     7.75 |    10.46 |    10.86 |      10.88 |    10.88 |
|       10000 |   27.4 ms |            365,260 |    13.48 |    20.06 |    20.99 |      21.02 |    21.02 |
|       25000 |   61.6 ms |            405,778 |    24.45 |    47.61 |    49.02 |      49.12 |    49.14 |
|       50000 |  106.4 ms |            469,998 |    57.53 |    79.95 |    84.91 |      84.98 |    84.99 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            103,344 |     5.61 |     6.80 |     7.32 |       7.38 |     7.38 |
|        5000 |   35.7 ms |            139,902 |    18.27 |    27.54 |    28.31 |      28.36 |    28.37 |
|       10000 |   65.4 ms |            152,957 |    32.78 |    54.09 |    56.35 |      56.45 |    56.46 |
|       25000 |  181.5 ms |            137,727 |    89.83 |   158.50 |   168.76 |     169.16 |   169.19 |
|       50000 |  341.5 ms |            146,428 |   189.63 |   287.32 |   313.55 |     314.36 |   314.42 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.5 ms |             87,092 |     6.39 |     9.66 |    10.60 |      10.76 |    10.76 |
|        5000 |   47.6 ms |            105,062 |    25.87 |    41.60 |    45.00 |      45.73 |    45.79 |
|       10000 |  104.5 ms |             95,680 |    45.56 |    85.44 |    98.38 |     100.11 |   100.44 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 221.8 MB
  • Settled Cooldown RSS   : 85.9 MB (Clean GC release)

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
| Yatta     |      94,471 |     1.00x |     4% | 1.15ms | 1.61ms | 2.24ms |
| Raw Bun   |     120,278 |     1.27x |     6% | 0.91ms | 1.14ms | 1.51ms |
| Hono      |     101,599 |     1.08x |     6% | 1.06ms | 1.50ms | 1.94ms |
| Elysia    |     116,231 |     1.23x |     5% | 0.97ms | 1.23ms | 1.64ms |
| Express   |      42,996 |     0.46x |     4% | 2.24ms | 4.62ms | 6.13ms |
| Fastify   |      53,747 |     0.57x |     2% | 1.68ms | 3.52ms | 4.02ms |
| Koa       |      46,837 |     0.50x |     2% | 2.04ms | 4.01ms | 4.77ms |

  Yatta dispatch adds about 2.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
