# Yatta Benchmarks

> Last run: `2026-10-31T12:18:06Z` · commit [`905b765`](https://github.com/psrockstar098/yatta.js/commit/905b76528553e0d39a7d56f8055d7c4c14f43a79) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 99.3 ms
  • End-to-End Runtime Task Cost    : 0.0413 ms/op
  • Peak RSS Memory        : 197.3 MB
  • RSS Heap Memory             : 76.95 MB
  • Raw Worker IPC Round-Trip      : 0.0378 ms/op
  • Scheduler + Graph Overhead     : 0.0035 ms/op
  • Settled Cooldown RSS   : 73.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      44,679 |     1.00x |     4% | 1.99ms | 3.62ms | 4.27ms |
| Raw Bun   |      44,118 |     0.99x |    17% | 2.32ms | 4.78ms | 4.90ms |
| Hono      |      49,611 |     1.11x |    16% | 2.26ms | 3.76ms | 4.14ms |
| Elysia    |      43,465 |     0.97x |    38% | 2.13ms | 3.69ms | 4.74ms |
| Express   |      15,556 |     0.35x |    19% | 6.47ms | 9.96ms | 11.29ms |
| Fastify   |      21,541 |     0.48x |     8% | 4.29ms | 7.65ms | 8.61ms |
| Koa       |      16,032 |     0.36x |     9% | 5.34ms | 9.51ms | 10.76ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,065 |       0.35 |       0.37 |       0.37 |       0.37 |
|         100 |     1.1 ms |               92,887 |       0.42 |       0.62 |       0.66 |       0.66 |
|         500 |     2.6 ms |              192,371 |       1.19 |       1.53 |       1.57 |       1.60 |
|        1000 |     4.7 ms |              212,239 |       2.35 |       3.47 |       3.66 |       3.71 |
|        5000 |    30.1 ms |              165,857 |      16.07 |      22.18 |      22.27 |      22.28 |
|       10000 |    51.1 ms |              195,768 |      27.81 |      40.50 |      40.86 |      40.89 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.4 ms |            135,373 |     3.37 |     4.67 |     5.43 |       5.54 |     5.54 |
|        5000 |   20.3 ms |            246,337 |     9.57 |    12.83 |    13.31 |      13.32 |    13.32 |
|       10000 |   41.2 ms |            242,601 |    20.50 |    30.01 |    30.98 |      31.04 |    31.04 |
|       25000 |   95.4 ms |            262,070 |    47.72 |    72.32 |    76.10 |      76.34 |    76.34 |
|       50000 |  204.4 ms |            244,559 |    91.50 |   159.41 |   169.87 |     171.44 |   171.45 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.0 ms |             62,315 |     7.77 |    12.78 |    14.70 |      15.03 |    15.03 |
|        5000 |   50.6 ms |             98,877 |    23.88 |    38.17 |    38.62 |      38.65 |    38.66 |
|       10000 |  122.1 ms |             81,913 |    63.44 |   104.15 |   110.10 |     110.12 |   110.12 |
|       25000 |  283.8 ms |             88,103 |   143.65 |   246.07 |   260.94 |     261.47 |   261.48 |
|       50000 |  556.6 ms |             89,823 |   289.79 |   478.13 |   518.65 |     520.21 |   521.03 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   29.5 ms |             33,922 |    13.52 |    23.72 |    27.54 |      28.32 |    28.32 |
|        5000 |  109.3 ms |             45,747 |    48.32 |    94.35 |   103.14 |     105.36 |   105.55 |
|       10000 |  202.2 ms |             49,458 |    95.58 |   170.24 |   193.23 |     195.94 |   196.19 |

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
  • Raw Worker IPC Round-Trip      : 0.0378 ms/op
  • End-to-End Runtime Task Cost    : 0.0413 ms/op
  • Scheduler + Graph Overhead     : 0.0035 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,065 |       0.35 |       0.37 |       0.37 |       0.37 |
|         100 |     1.1 ms |               92,887 |       0.42 |       0.62 |       0.66 |       0.66 |
|         500 |     2.6 ms |              192,371 |       1.19 |       1.53 |       1.57 |       1.60 |
|        1000 |     4.7 ms |              212,239 |       2.35 |       3.47 |       3.66 |       3.71 |
|        5000 |    30.1 ms |              165,857 |      16.07 |      22.18 |      22.27 |      22.28 |
|       10000 |    51.1 ms |              195,768 |      27.81 |      40.50 |      40.86 |      40.89 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 76.95 MB
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
| 1 CPU + 1 IO  |       2 |   46.2 ms |            216,525 |    21.06 |    33.55 |    34.49 |    34.72 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   49.6 ms |            201,549 |    26.18 |    39.57 |    40.20 |    40.52 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   43.7 ms |            228,729 |    19.42 |    35.21 |    35.91 |    36.26 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   36.3 ms |            275,649 |    19.51 |    27.78 |    28.04 |    28.06 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 99.3 ms
  • Peak Throughput Rate       : 251,742 ops/sec
  • Latency Distribution       : p50: 50.01ms | p90: 83.01ms | p99: 84.08ms | p99.9: 84.22ms | Max: 84.23ms
  • Memory (RSS)               : Baseline: 108.0 MB | Peak: 128.1 MB | Cooldown: 101.8 MB

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
|        1000 |    7.4 ms |            135,373 |     3.37 |     4.67 |     5.43 |       5.54 |     5.54 |
|        5000 |   20.3 ms |            246,337 |     9.57 |    12.83 |    13.31 |      13.32 |    13.32 |
|       10000 |   41.2 ms |            242,601 |    20.50 |    30.01 |    30.98 |      31.04 |    31.04 |
|       25000 |   95.4 ms |            262,070 |    47.72 |    72.32 |    76.10 |      76.34 |    76.34 |
|       50000 |  204.4 ms |            244,559 |    91.50 |   159.41 |   169.87 |     171.44 |   171.45 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.0 ms |             62,315 |     7.77 |    12.78 |    14.70 |      15.03 |    15.03 |
|        5000 |   50.6 ms |             98,877 |    23.88 |    38.17 |    38.62 |      38.65 |    38.66 |
|       10000 |  122.1 ms |             81,913 |    63.44 |   104.15 |   110.10 |     110.12 |   110.12 |
|       25000 |  283.8 ms |             88,103 |   143.65 |   246.07 |   260.94 |     261.47 |   261.48 |
|       50000 |  556.6 ms |             89,823 |   289.79 |   478.13 |   518.65 |     520.21 |   521.03 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   29.5 ms |             33,922 |    13.52 |    23.72 |    27.54 |      28.32 |    28.32 |
|        5000 |  109.3 ms |             45,747 |    48.32 |    94.35 |   103.14 |     105.36 |   105.55 |
|       10000 |  202.2 ms |             49,458 |    95.58 |   170.24 |   193.23 |     195.94 |   196.19 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 197.3 MB
  • Settled Cooldown RSS   : 73.4 MB (Clean GC release)

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
| Yatta     |      44,679 |     1.00x |     4% | 1.99ms | 3.62ms | 4.27ms |
| Raw Bun   |      44,118 |     0.99x |    17% | 2.32ms | 4.78ms | 4.90ms |
| Hono      |      49,611 |     1.11x |    16% | 2.26ms | 3.76ms | 4.14ms |
| Elysia    |      43,465 |     0.97x |    38% | 2.13ms | 3.69ms | 4.74ms |
| Express   |      15,556 |     0.35x |    19% | 6.47ms | 9.96ms | 11.29ms |
| Fastify   |      21,541 |     0.48x |     8% | 4.29ms | 7.65ms | 8.61ms |
| Koa       |      16,032 |     0.36x |     9% | 5.34ms | 9.51ms | 10.76ms |

  Yatta dispatch adds about -0.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
