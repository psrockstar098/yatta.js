# Yatta Benchmarks

> Last run: `2026-11-05T17:11:29Z` · commit [`297c461`](https://github.com/psrockstar098/yatta.js/commit/297c461b952eb27f8e247a42318813c92a60e35a) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 82.8 ms
  • End-to-End Runtime Task Cost    : 0.0250 ms/op
  • Peak RSS Memory        : 222.8 MB
  • RSS Heap Memory             : 80.39 MB
  • Raw Worker IPC Round-Trip      : 0.0171 ms/op
  • Scheduler + Graph Overhead     : 0.0079 ms/op
  • Settled Cooldown RSS   : 76.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.34 MB
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
| Yatta     |      62,050 |     1.00x |     5% | 1.63ms | 2.55ms | 3.21ms |
| Raw Bun   |      45,756 |     0.74x |    11% | 1.78ms | 3.81ms | 3.92ms |
| Hono      |      60,241 |     0.97x |     7% | 1.55ms | 3.17ms | 3.69ms |
| Elysia    |      48,286 |     0.78x |    25% | 1.55ms | 3.29ms | 3.48ms |
| Express   |      23,682 |     0.38x |     9% | 4.14ms | 6.64ms | 7.69ms |
| Fastify   |      36,254 |     0.58x |     7% | 2.43ms | 4.88ms | 5.77ms |
| Koa       |      29,560 |     0.48x |     6% | 3.30ms | 6.09ms | 7.45ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,549 |       0.29 |       0.31 |       0.31 |       0.31 |
|         100 |     0.5 ms |              198,696 |       0.21 |       0.38 |       0.43 |       0.43 |
|         500 |     2.0 ms |              246,225 |       1.12 |       1.71 |       1.79 |       1.81 |
|        1000 |     2.6 ms |              391,705 |       1.18 |       1.85 |       1.95 |       1.98 |
|        5000 |    18.3 ms |              273,305 |       9.46 |      12.39 |      12.42 |      12.53 |
|       10000 |    33.3 ms |              300,265 |      18.04 |      26.47 |      26.58 |      26.59 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.8 ms |            128,891 |     4.68 |     5.43 |     5.62 |       5.92 |     5.92 |
|        5000 |   18.5 ms |            270,193 |     8.10 |    11.50 |    11.90 |      11.92 |    11.92 |
|       10000 |   41.3 ms |            242,210 |    19.71 |    31.89 |    32.73 |      32.74 |    32.74 |
|       25000 |   99.8 ms |            250,434 |    50.31 |    76.89 |    83.16 |      83.23 |    83.24 |
|       50000 |  198.2 ms |            252,297 |    99.86 |   163.01 |   172.93 |     173.25 |   173.25 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,772 |     4.62 |     7.04 |     8.19 |       8.44 |     8.44 |
|        5000 |   39.7 ms |            125,840 |    18.59 |    30.46 |    31.34 |      31.39 |    31.40 |
|       10000 |   72.4 ms |            138,126 |    35.00 |    59.15 |    61.89 |      62.01 |    62.02 |
|       25000 |  207.0 ms |            120,780 |   106.76 |   174.34 |   190.76 |     191.02 |   191.05 |
|       50000 |  377.3 ms |            132,517 |   191.99 |   319.21 |   344.80 |     345.78 |   345.83 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.9 ms |             59,096 |     9.17 |    14.21 |    15.91 |      16.12 |    16.12 |
|        5000 |   78.8 ms |             63,451 |    44.71 |    70.23 |    75.90 |      77.02 |    77.11 |
|       10000 |  137.9 ms |             72,502 |    66.50 |   115.68 |   132.58 |     134.88 |   135.10 |

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
  • Raw Worker IPC Round-Trip      : 0.0171 ms/op
  • End-to-End Runtime Task Cost    : 0.0250 ms/op
  • Scheduler + Graph Overhead     : 0.0079 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,549 |       0.29 |       0.31 |       0.31 |       0.31 |
|         100 |     0.5 ms |              198,696 |       0.21 |       0.38 |       0.43 |       0.43 |
|         500 |     2.0 ms |              246,225 |       1.12 |       1.71 |       1.79 |       1.81 |
|        1000 |     2.6 ms |              391,705 |       1.18 |       1.85 |       1.95 |       1.98 |
|        5000 |    18.3 ms |              273,305 |       9.46 |      12.39 |      12.42 |      12.53 |
|       10000 |    33.3 ms |              300,265 |      18.04 |      26.47 |      26.58 |      26.59 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.39 MB
  • V8/JSC Heap Used             : 13.34 MB

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
| 1 CPU + 1 IO  |       2 |   38.7 ms |            258,173 |    18.80 |    29.60 |    30.16 |    30.18 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   34.3 ms |            291,948 |    20.18 |    26.96 |    27.13 |    27.15 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   27.9 ms |            358,135 |    13.18 |    21.62 |    21.93 |    21.98 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   32.0 ms |            312,866 |    16.14 |    23.93 |    24.00 |    24.00 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 82.8 ms
  • Peak Throughput Rate       : 302,048 ops/sec
  • Latency Distribution       : p50: 39.10ms | p90: 65.33ms | p99: 66.33ms | p99.9: 66.35ms | Max: 66.38ms
  • Memory (RSS)               : Baseline: 99.2 MB | Peak: 129.9 MB | Cooldown: 101.3 MB

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
|        1000 |    7.8 ms |            128,891 |     4.68 |     5.43 |     5.62 |       5.92 |     5.92 |
|        5000 |   18.5 ms |            270,193 |     8.10 |    11.50 |    11.90 |      11.92 |    11.92 |
|       10000 |   41.3 ms |            242,210 |    19.71 |    31.89 |    32.73 |      32.74 |    32.74 |
|       25000 |   99.8 ms |            250,434 |    50.31 |    76.89 |    83.16 |      83.23 |    83.24 |
|       50000 |  198.2 ms |            252,297 |    99.86 |   163.01 |   172.93 |     173.25 |   173.25 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,772 |     4.62 |     7.04 |     8.19 |       8.44 |     8.44 |
|        5000 |   39.7 ms |            125,840 |    18.59 |    30.46 |    31.34 |      31.39 |    31.40 |
|       10000 |   72.4 ms |            138,126 |    35.00 |    59.15 |    61.89 |      62.01 |    62.02 |
|       25000 |  207.0 ms |            120,780 |   106.76 |   174.34 |   190.76 |     191.02 |   191.05 |
|       50000 |  377.3 ms |            132,517 |   191.99 |   319.21 |   344.80 |     345.78 |   345.83 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.9 ms |             59,096 |     9.17 |    14.21 |    15.91 |      16.12 |    16.12 |
|        5000 |   78.8 ms |             63,451 |    44.71 |    70.23 |    75.90 |      77.02 |    77.11 |
|       10000 |  137.9 ms |             72,502 |    66.50 |   115.68 |   132.58 |     134.88 |   135.10 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 222.8 MB
  • Settled Cooldown RSS   : 76.7 MB (Clean GC release)

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
| Yatta     |      62,050 |     1.00x |     5% | 1.63ms | 2.55ms | 3.21ms |
| Raw Bun   |      45,756 |     0.74x |    11% | 1.78ms | 3.81ms | 3.92ms |
| Hono      |      60,241 |     0.97x |     7% | 1.55ms | 3.17ms | 3.69ms |
| Elysia    |      48,286 |     0.78x |    25% | 1.55ms | 3.29ms | 3.48ms |
| Express   |      23,682 |     0.38x |     9% | 4.14ms | 6.64ms | 7.69ms |
| Fastify   |      36,254 |     0.58x |     7% | 2.43ms | 4.88ms | 5.77ms |
| Koa       |      29,560 |     0.48x |     6% | 3.30ms | 6.09ms | 7.45ms |

  Yatta dispatch adds about -5.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
