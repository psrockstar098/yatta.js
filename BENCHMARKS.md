# Yatta Benchmarks

> Last run: `2026-11-05T04:05:05Z` · commit [`9f3bf34`](https://github.com/psrockstar098/yatta.js/commit/9f3bf34ff140246dd0341117b06fd7f0735c8efd) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 101.7 ms
  • End-to-End Runtime Task Cost    : 0.0397 ms/op
  • Peak RSS Memory        : 135.3 MB
  • RSS Heap Memory             : 79.75 MB
  • Raw Worker IPC Round-Trip      : 0.0316 ms/op
  • Scheduler + Graph Overhead     : 0.0081 ms/op
  • Settled Cooldown RSS   : 71.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
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
| Yatta     |      46,246 |     1.00x |    10% | 2.03ms | 3.55ms | 4.23ms |
| Raw Bun   |      50,607 |     1.09x |    46% | 1.79ms | 3.74ms | 4.72ms |
| Hono      |      47,870 |     1.04x |    10% | 1.83ms | 3.19ms | 4.06ms |
| Elysia    |      45,111 |     0.98x |    11% | 2.15ms | 4.68ms | 5.11ms |
| Express   |      15,164 |     0.33x |     4% | 6.46ms | 9.82ms | 10.45ms |
| Fastify   |      21,919 |     0.47x |     2% | 4.16ms | 7.80ms | 9.41ms |
| Koa       |      15,707 |     0.34x |    19% | 6.84ms | 10.25ms | 11.89ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,446 |       0.36 |       0.38 |       0.38 |       0.38 |
|         100 |     1.1 ms |               91,729 |       0.27 |       0.71 |       0.71 |       0.71 |
|         500 |     2.0 ms |              248,571 |       0.99 |       1.59 |       1.66 |       1.69 |
|        1000 |     3.7 ms |              269,701 |       1.84 |       2.98 |       3.13 |       3.17 |
|        5000 |    23.0 ms |              217,708 |      13.21 |      16.43 |      16.50 |      16.51 |
|       10000 |    51.3 ms |              194,830 |      27.39 |      42.02 |      42.40 |      42.41 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.8 ms |            102,532 |     4.34 |     6.27 |     7.92 |       8.07 |     8.07 |
|        5000 |   21.7 ms |            230,211 |     9.47 |    13.20 |    13.68 |      13.72 |    13.73 |
|       10000 |   46.6 ms |            214,751 |    23.70 |    35.41 |    36.64 |      36.67 |    36.69 |
|       25000 |   93.9 ms |            266,248 |    47.30 |    66.23 |    70.56 |      71.05 |    71.10 |
|       50000 |  195.9 ms |            255,225 |    97.79 |   153.13 |   163.71 |     163.86 |   163.86 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.8 ms |             78,159 |     6.14 |     9.69 |    11.50 |      11.81 |    11.81 |
|        5000 |   41.9 ms |            119,261 |    18.12 |    28.22 |    29.29 |      29.33 |    29.33 |
|       10000 |   88.1 ms |            113,564 |    45.77 |    71.72 |    74.16 |      74.20 |    74.21 |
|       25000 |  236.1 ms |            105,907 |   130.25 |   207.09 |   216.96 |     217.42 |   217.44 |
|       50000 |  443.8 ms |            112,665 |   254.31 |   377.06 |   402.98 |     404.11 |   404.18 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.1 ms |             41,542 |    12.80 |    20.67 |    22.65 |      23.01 |    23.01 |
|        5000 |   98.5 ms |             50,783 |    47.56 |    85.04 |    94.07 |      95.47 |    95.61 |
|       10000 |  222.0 ms |             45,046 |   103.78 |   190.87 |   209.93 |     217.41 |   217.72 |

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
  • Raw Worker IPC Round-Trip      : 0.0316 ms/op
  • End-to-End Runtime Task Cost    : 0.0397 ms/op
  • Scheduler + Graph Overhead     : 0.0081 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,446 |       0.36 |       0.38 |       0.38 |       0.38 |
|         100 |     1.1 ms |               91,729 |       0.27 |       0.71 |       0.71 |       0.71 |
|         500 |     2.0 ms |              248,571 |       0.99 |       1.59 |       1.66 |       1.69 |
|        1000 |     3.7 ms |              269,701 |       1.84 |       2.98 |       3.13 |       3.17 |
|        5000 |    23.0 ms |              217,708 |      13.21 |      16.43 |      16.50 |      16.51 |
|       10000 |    51.3 ms |              194,830 |      27.39 |      42.02 |      42.40 |      42.41 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 79.75 MB
  • V8/JSC Heap Used             : 0.78 MB

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
| 1 CPU + 1 IO  |       2 |   46.6 ms |            214,531 |    20.81 |    34.48 |    35.82 |    35.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   44.1 ms |            226,971 |    22.92 |    34.17 |    34.52 |    34.57 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   42.5 ms |            235,060 |    20.18 |    34.35 |    35.06 |    35.33 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   37.3 ms |            268,413 |    19.49 |    29.16 |    29.18 |    29.20 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 101.7 ms
  • Peak Throughput Rate       : 245,770 ops/sec
  • Latency Distribution       : p50: 48.53ms | p90: 84.55ms | p99: 85.02ms | p99.9: 85.25ms | Max: 85.27ms
  • Memory (RSS)               : Baseline: 102.6 MB | Peak: 121.6 MB | Cooldown: 78.5 MB

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
|        1000 |    9.8 ms |            102,532 |     4.34 |     6.27 |     7.92 |       8.07 |     8.07 |
|        5000 |   21.7 ms |            230,211 |     9.47 |    13.20 |    13.68 |      13.72 |    13.73 |
|       10000 |   46.6 ms |            214,751 |    23.70 |    35.41 |    36.64 |      36.67 |    36.69 |
|       25000 |   93.9 ms |            266,248 |    47.30 |    66.23 |    70.56 |      71.05 |    71.10 |
|       50000 |  195.9 ms |            255,225 |    97.79 |   153.13 |   163.71 |     163.86 |   163.86 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.8 ms |             78,159 |     6.14 |     9.69 |    11.50 |      11.81 |    11.81 |
|        5000 |   41.9 ms |            119,261 |    18.12 |    28.22 |    29.29 |      29.33 |    29.33 |
|       10000 |   88.1 ms |            113,564 |    45.77 |    71.72 |    74.16 |      74.20 |    74.21 |
|       25000 |  236.1 ms |            105,907 |   130.25 |   207.09 |   216.96 |     217.42 |   217.44 |
|       50000 |  443.8 ms |            112,665 |   254.31 |   377.06 |   402.98 |     404.11 |   404.18 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.1 ms |             41,542 |    12.80 |    20.67 |    22.65 |      23.01 |    23.01 |
|        5000 |   98.5 ms |             50,783 |    47.56 |    85.04 |    94.07 |      95.47 |    95.61 |
|       10000 |  222.0 ms |             45,046 |   103.78 |   190.87 |   209.93 |     217.41 |   217.72 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 135.3 MB
  • Settled Cooldown RSS   : 71.0 MB (Clean GC release)

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
| Yatta     |      46,246 |     1.00x |    10% | 2.03ms | 3.55ms | 4.23ms |
| Raw Bun   |      50,607 |     1.09x |    46% | 1.79ms | 3.74ms | 4.72ms |
| Hono      |      47,870 |     1.04x |    10% | 1.83ms | 3.19ms | 4.06ms |
| Elysia    |      45,111 |     0.98x |    11% | 2.15ms | 4.68ms | 5.11ms |
| Express   |      15,164 |     0.33x |     4% | 6.46ms | 9.82ms | 10.45ms |
| Fastify   |      21,919 |     0.47x |     2% | 4.16ms | 7.80ms | 9.41ms |
| Koa       |      15,707 |     0.34x |    19% | 6.84ms | 10.25ms | 11.89ms |

  Yatta dispatch adds about 1.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
