# Yatta Benchmarks

> Last run: `2026-11-24T13:03:33Z` · commit [`9bc6784`](https://github.com/psrockstar098/yatta.js/commit/9bc67847fb010c1c9c541784167e46f259dbba41) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 62.2 ms
  • End-to-End Runtime Task Cost    : 0.0181 ms/op
  • Peak RSS Memory        : 184.8 MB
  • RSS Heap Memory             : 96.04 MB
  • Raw Worker IPC Round-Trip      : 0.0149 ms/op
  • Scheduler + Graph Overhead     : 0.0032 ms/op
  • Settled Cooldown RSS   : 81.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.69 MB
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
| Yatta     |      98,071 |     1.00x |     6% | 1.08ms | 1.59ms | 1.90ms |
| Raw Bun   |     115,932 |     1.18x |     4% | 0.95ms | 1.32ms | 2.06ms |
| Hono      |     102,986 |     1.05x |    12% | 1.03ms | 1.52ms | 1.83ms |
| Elysia    |     114,887 |     1.17x |     5% | 0.94ms | 1.41ms | 1.97ms |
| Express   |      43,209 |     0.44x |     2% | 2.12ms | 4.40ms | 5.34ms |
| Fastify   |      54,572 |     0.56x |     5% | 1.64ms | 3.33ms | 4.25ms |
| Koa       |      47,293 |     0.48x |     4% | 1.99ms | 3.84ms | 5.46ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,919 |       0.21 |       0.22 |       0.22 |       0.22 |
|         100 |     0.4 ms |              239,347 |       0.16 |       0.24 |       0.26 |       0.26 |
|         500 |     1.3 ms |              386,813 |       0.62 |       0.96 |       0.99 |       1.01 |
|        1000 |     2.4 ms |              413,247 |       1.24 |       1.80 |       1.87 |       1.91 |
|        5000 |    14.4 ms |              347,811 |       8.23 |       9.46 |      10.01 |      10.05 |
|       10000 |    27.2 ms |              367,625 |      14.51 |      20.59 |      20.96 |      20.99 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    5.0 ms |            198,038 |     2.10 |     3.15 |     4.03 |       4.10 |     4.10 |
|        5000 |   18.3 ms |            272,514 |     8.24 |    12.63 |    13.07 |      13.07 |    13.07 |
|       10000 |   27.3 ms |            365,818 |    15.15 |    21.13 |    21.63 |      21.68 |    21.69 |
|       25000 |   64.8 ms |            385,699 |    32.18 |    45.83 |    48.03 |      48.04 |    48.06 |
|       50000 |  106.7 ms |            468,798 |    54.92 |    75.65 |    81.25 |      81.62 |    81.63 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            124,647 |     4.03 |     5.83 |     6.61 |       6.81 |     6.81 |
|        5000 |   31.9 ms |            156,971 |    17.68 |    25.22 |    26.10 |      26.15 |    26.15 |
|       10000 |   71.4 ms |            139,992 |    33.96 |    60.09 |    62.58 |      62.73 |    62.74 |
|       25000 |  178.3 ms |            140,185 |    83.32 |   153.02 |   163.18 |     163.65 |   163.66 |
|       50000 |  334.0 ms |            149,690 |   157.25 |   289.70 |   309.02 |     309.80 |   309.85 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.6 ms |             53,754 |     9.99 |    13.57 |    16.77 |      17.10 |    17.10 |
|        5000 |   44.8 ms |            111,617 |    21.65 |    38.15 |    42.47 |      43.21 |    43.36 |
|       10000 |  103.0 ms |             97,134 |    48.32 |    86.61 |    98.75 |     100.06 |   100.20 |

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
  • Raw Worker IPC Round-Trip      : 0.0149 ms/op
  • End-to-End Runtime Task Cost    : 0.0181 ms/op
  • Scheduler + Graph Overhead     : 0.0032 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               23,919 |       0.21 |       0.22 |       0.22 |       0.22 |
|         100 |     0.4 ms |              239,347 |       0.16 |       0.24 |       0.26 |       0.26 |
|         500 |     1.3 ms |              386,813 |       0.62 |       0.96 |       0.99 |       1.01 |
|        1000 |     2.4 ms |              413,247 |       1.24 |       1.80 |       1.87 |       1.91 |
|        5000 |    14.4 ms |              347,811 |       8.23 |       9.46 |      10.01 |      10.05 |
|       10000 |    27.2 ms |              367,625 |      14.51 |      20.59 |      20.96 |      20.99 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.04 MB
  • V8/JSC Heap Used             : 13.69 MB

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
| 1 CPU + 1 IO  |       2 |   34.7 ms |            287,999 |    17.16 |    26.45 |    26.72 |    26.86 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   28.0 ms |            356,766 |    14.29 |    20.64 |    20.70 |    20.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   28.6 ms |            349,834 |    12.60 |    21.85 |    22.27 |    22.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   25.5 ms |            391,866 |    11.98 |    19.46 |    20.04 |    20.11 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 62.2 ms
  • Peak Throughput Rate       : 401,873 ops/sec
  • Latency Distribution       : p50: 29.08ms | p90: 45.13ms | p99: 45.78ms | p99.9: 45.87ms | Max: 45.89ms
  • Memory (RSS)               : Baseline: 99.8 MB | Peak: 136.3 MB | Cooldown: 105.9 MB

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
|        1000 |    5.0 ms |            198,038 |     2.10 |     3.15 |     4.03 |       4.10 |     4.10 |
|        5000 |   18.3 ms |            272,514 |     8.24 |    12.63 |    13.07 |      13.07 |    13.07 |
|       10000 |   27.3 ms |            365,818 |    15.15 |    21.13 |    21.63 |      21.68 |    21.69 |
|       25000 |   64.8 ms |            385,699 |    32.18 |    45.83 |    48.03 |      48.04 |    48.06 |
|       50000 |  106.7 ms |            468,798 |    54.92 |    75.65 |    81.25 |      81.62 |    81.63 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            124,647 |     4.03 |     5.83 |     6.61 |       6.81 |     6.81 |
|        5000 |   31.9 ms |            156,971 |    17.68 |    25.22 |    26.10 |      26.15 |    26.15 |
|       10000 |   71.4 ms |            139,992 |    33.96 |    60.09 |    62.58 |      62.73 |    62.74 |
|       25000 |  178.3 ms |            140,185 |    83.32 |   153.02 |   163.18 |     163.65 |   163.66 |
|       50000 |  334.0 ms |            149,690 |   157.25 |   289.70 |   309.02 |     309.80 |   309.85 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.6 ms |             53,754 |     9.99 |    13.57 |    16.77 |      17.10 |    17.10 |
|        5000 |   44.8 ms |            111,617 |    21.65 |    38.15 |    42.47 |      43.21 |    43.36 |
|       10000 |  103.0 ms |             97,134 |    48.32 |    86.61 |    98.75 |     100.06 |   100.20 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 184.8 MB
  • Settled Cooldown RSS   : 81.1 MB (Clean GC release)

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
| Yatta     |      98,071 |     1.00x |     6% | 1.08ms | 1.59ms | 1.90ms |
| Raw Bun   |     115,932 |     1.18x |     4% | 0.95ms | 1.32ms | 2.06ms |
| Hono      |     102,986 |     1.05x |    12% | 1.03ms | 1.52ms | 1.83ms |
| Elysia    |     114,887 |     1.17x |     5% | 0.94ms | 1.41ms | 1.97ms |
| Express   |      43,209 |     0.44x |     2% | 2.12ms | 4.40ms | 5.34ms |
| Fastify   |      54,572 |     0.56x |     5% | 1.64ms | 3.33ms | 4.25ms |
| Koa       |      47,293 |     0.48x |     4% | 1.99ms | 3.84ms | 5.46ms |

  Yatta dispatch adds about 1.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
