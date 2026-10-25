# Yatta Benchmarks

> Last run: `2026-10-25T12:42:04Z` · commit [`e158f18`](https://github.com/psrockstar098/yatta.js/commit/e158f18ba6c3bf50f90401be60b0abb9f52d9475) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 118.7 ms
  • End-to-End Runtime Task Cost    : 0.0580 ms/op
  • Peak RSS Memory        : 178.0 MB
  • RSS Heap Memory             : 81.63 MB
  • Raw Worker IPC Round-Trip      : 0.0434 ms/op
  • Scheduler + Graph Overhead     : 0.0146 ms/op
  • Settled Cooldown RSS   : 145.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.19 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      37,279 |     1.00x |    21% | 3.09ms | 4.41ms | 5.05ms |
| Raw Bun   |      43,958 |     1.18x |    56% | 2.81ms | 5.82ms | 5.96ms |
| Hono      |      44,973 |     1.21x |    11% | 2.05ms | 3.77ms | 4.16ms |
| Elysia    |      47,339 |     1.27x |     9% | 1.81ms | 3.54ms | 5.12ms |
| Express   |      14,793 |     0.40x |     2% | 6.70ms | 10.76ms | 12.44ms |
| Fastify   |      20,399 |     0.55x |     3% | 4.74ms | 8.36ms | 9.55ms |
| Koa       |      16,782 |     0.45x |     4% | 5.23ms | 10.07ms | 11.42ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,837 |       0.43 |       0.46 |       0.46 |       0.46 |
|         100 |     0.7 ms |              135,679 |       0.32 |       0.46 |       0.50 |       0.50 |
|         500 |     3.4 ms |              146,845 |       1.23 |       1.93 |       2.02 |       2.03 |
|        1000 |     4.7 ms |              214,970 |       1.95 |       2.89 |       3.02 |       3.08 |
|        5000 |    29.6 ms |              169,087 |      17.37 |      21.37 |      21.68 |      21.80 |
|       10000 |    57.0 ms |              175,436 |      28.03 |      47.10 |      47.37 |      47.56 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.0 ms |             91,044 |     5.00 |     7.83 |     9.24 |       9.35 |     9.35 |
|        5000 |   20.8 ms |            240,239 |    10.92 |    12.57 |    13.04 |      13.09 |    13.09 |
|       10000 |   46.1 ms |            216,890 |    22.92 |    33.91 |    35.32 |      35.42 |    35.44 |
|       25000 |  103.0 ms |            242,626 |    46.96 |    69.00 |    72.79 |      72.91 |    72.91 |
|       50000 |  199.6 ms |            250,544 |    96.45 |   160.04 |   171.96 |     172.13 |   172.14 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,018 |     8.43 |    11.62 |    13.60 |      13.78 |    13.78 |
|        5000 |   52.0 ms |             96,176 |    25.18 |    39.82 |    40.86 |      40.95 |    40.96 |
|       10000 |  102.7 ms |             97,380 |    53.48 |    87.23 |    89.90 |      90.12 |    90.14 |
|       25000 |  262.1 ms |             95,387 |   127.23 |   223.16 |   239.46 |     239.95 |   240.00 |
|       50000 |  450.7 ms |            110,933 |   239.60 |   383.01 |   410.54 |     412.50 |   412.59 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.8 ms |             29,557 |    18.75 |    29.69 |    32.16 |      32.46 |    32.46 |
|        5000 |  160.4 ms |             31,182 |    66.84 |   143.12 |   155.92 |     157.66 |   157.79 |
|       10000 |  263.5 ms |             37,955 |   134.34 |   233.08 |   255.47 |     259.03 |   259.36 |

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
  • Raw Worker IPC Round-Trip      : 0.0434 ms/op
  • End-to-End Runtime Task Cost    : 0.0580 ms/op
  • Scheduler + Graph Overhead     : 0.0146 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,837 |       0.43 |       0.46 |       0.46 |       0.46 |
|         100 |     0.7 ms |              135,679 |       0.32 |       0.46 |       0.50 |       0.50 |
|         500 |     3.4 ms |              146,845 |       1.23 |       1.93 |       2.02 |       2.03 |
|        1000 |     4.7 ms |              214,970 |       1.95 |       2.89 |       3.02 |       3.08 |
|        5000 |    29.6 ms |              169,087 |      17.37 |      21.37 |      21.68 |      21.80 |
|       10000 |    57.0 ms |              175,436 |      28.03 |      47.10 |      47.37 |      47.56 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.19 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 81.63 MB
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
| 1 CPU + 1 IO  |       2 |   48.2 ms |            207,572 |    20.90 |    37.05 |    37.86 |    38.04 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   44.1 ms |            226,902 |    24.95 |    34.05 |    34.32 |    34.35 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   33.7 ms |            296,852 |    16.54 |    26.26 |    26.60 |    26.86 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   42.3 ms |            236,240 |    22.32 |    34.59 |    34.83 |    34.87 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 118.7 ms
  • Peak Throughput Rate       : 210,585 ops/sec
  • Latency Distribution       : p50: 57.55ms | p90: 97.84ms | p99: 99.23ms | p99.9: 99.45ms | Max: 99.46ms
  • Memory (RSS)               : Baseline: 102.7 MB | Peak: 126.0 MB | Cooldown: 99.2 MB

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
|        1000 |   11.0 ms |             91,044 |     5.00 |     7.83 |     9.24 |       9.35 |     9.35 |
|        5000 |   20.8 ms |            240,239 |    10.92 |    12.57 |    13.04 |      13.09 |    13.09 |
|       10000 |   46.1 ms |            216,890 |    22.92 |    33.91 |    35.32 |      35.42 |    35.44 |
|       25000 |  103.0 ms |            242,626 |    46.96 |    69.00 |    72.79 |      72.91 |    72.91 |
|       50000 |  199.6 ms |            250,544 |    96.45 |   160.04 |   171.96 |     172.13 |   172.14 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,018 |     8.43 |    11.62 |    13.60 |      13.78 |    13.78 |
|        5000 |   52.0 ms |             96,176 |    25.18 |    39.82 |    40.86 |      40.95 |    40.96 |
|       10000 |  102.7 ms |             97,380 |    53.48 |    87.23 |    89.90 |      90.12 |    90.14 |
|       25000 |  262.1 ms |             95,387 |   127.23 |   223.16 |   239.46 |     239.95 |   240.00 |
|       50000 |  450.7 ms |            110,933 |   239.60 |   383.01 |   410.54 |     412.50 |   412.59 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.8 ms |             29,557 |    18.75 |    29.69 |    32.16 |      32.46 |    32.46 |
|        5000 |  160.4 ms |             31,182 |    66.84 |   143.12 |   155.92 |     157.66 |   157.79 |
|       10000 |  263.5 ms |             37,955 |   134.34 |   233.08 |   255.47 |     259.03 |   259.36 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 178.0 MB
  • Settled Cooldown RSS   : 145.9 MB (Clean GC release)

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
| Yatta     |      37,279 |     1.00x |    21% | 3.09ms | 4.41ms | 5.05ms |
| Raw Bun   |      43,958 |     1.18x |    56% | 2.81ms | 5.82ms | 5.96ms |
| Hono      |      44,973 |     1.21x |    11% | 2.05ms | 3.77ms | 4.16ms |
| Elysia    |      47,339 |     1.27x |     9% | 1.81ms | 3.54ms | 5.12ms |
| Express   |      14,793 |     0.40x |     2% | 6.70ms | 10.76ms | 12.44ms |
| Fastify   |      20,399 |     0.55x |     3% | 4.74ms | 8.36ms | 9.55ms |
| Koa       |      16,782 |     0.45x |     4% | 5.23ms | 10.07ms | 11.42ms |

  Yatta dispatch adds about 4.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 21%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
