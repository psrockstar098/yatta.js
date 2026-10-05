# Yatta Benchmarks

> Last run: `2026-10-05T22:04:38Z` · commit [`cd4c2e4`](https://github.com/psrockstar098/yatta.js/commit/cd4c2e47cbd586dc18686f53c0f08c3054d56ecd) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 110.4 ms
  • End-to-End Runtime Task Cost    : 0.0506 ms/op
  • Peak RSS Memory        : 181.6 MB
  • RSS Heap Memory             : 77.68 MB
  • Raw Worker IPC Round-Trip      : 0.0377 ms/op
  • Scheduler + Graph Overhead     : 0.0129 ms/op
  • Settled Cooldown RSS   : 72.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,865 |       0.30 |       0.32 |       0.32 |       0.32 |
|         100 |     0.7 ms |              142,307 |       0.29 |       0.49 |       0.56 |       0.56 |
|         500 |     3.6 ms |              140,579 |       2.00 |       2.73 |       2.86 |       2.88 |
|        1000 |     5.3 ms |              189,420 |       2.67 |       3.86 |       3.92 |       3.97 |
|        5000 |    32.0 ms |              156,064 |      18.19 |      24.34 |      24.59 |      24.65 |
|       10000 |    52.1 ms |              192,116 |      25.43 |      42.10 |      42.30 |      42.37 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.9 ms |            112,069 |     4.25 |     5.95 |     7.44 |       7.51 |     7.51 |
|        5000 |   21.8 ms |            229,621 |    10.91 |    14.28 |    14.74 |      14.79 |    14.79 |
|       10000 |   42.6 ms |            234,578 |    20.52 |    32.44 |    34.22 |      34.24 |    34.24 |
|       25000 |  105.1 ms |            237,787 |    49.36 |    72.23 |    77.50 |      77.55 |    77.56 |
|       50000 |  193.1 ms |            258,974 |    97.61 |   151.45 |   163.12 |     163.62 |   163.63 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.5 ms |             79,848 |     6.16 |     9.56 |    11.10 |      11.27 |    11.27 |
|        5000 |   52.0 ms |             96,170 |    22.02 |    39.74 |    40.66 |      40.66 |    40.67 |
|       10000 |   94.7 ms |            105,585 |    46.29 |    78.50 |    81.28 |      81.31 |    81.32 |
|       25000 |  250.7 ms |             99,736 |   126.44 |   211.81 |   226.26 |     226.96 |   227.00 |
|       50000 |  492.7 ms |            101,489 |   246.82 |   421.52 |   457.81 |     459.77 |   459.93 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.8 ms |             29,559 |    18.58 |    29.69 |    32.24 |      32.74 |    32.74 |
|        5000 |  142.9 ms |             34,979 |    65.90 |   128.36 |   139.34 |     140.66 |   140.87 |
|       10000 |  254.1 ms |             39,361 |   124.48 |   222.20 |   246.86 |     248.93 |   249.22 |

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[1] Layer Overhead Decomposition (Micro-benchmarking 2,000 calls each):
  • Raw Worker IPC Round-Trip      : 0.0377 ms/op
  • End-to-End Runtime Task Cost    : 0.0506 ms/op
  • Scheduler + Graph Overhead     : 0.0129 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,865 |       0.30 |       0.32 |       0.32 |       0.32 |
|         100 |     0.7 ms |              142,307 |       0.29 |       0.49 |       0.56 |       0.56 |
|         500 |     3.6 ms |              140,579 |       2.00 |       2.73 |       2.86 |       2.88 |
|        1000 |     5.3 ms |              189,420 |       2.67 |       3.86 |       3.92 |       3.97 |
|        5000 |    32.0 ms |              156,064 |      18.19 |      24.34 |      24.59 |      24.65 |
|       10000 |    52.1 ms |              192,116 |      25.43 |      42.10 |      42.30 |      42.37 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.68 MB
  • V8/JSC Heap Used             : 0.75 MB

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 1 IO  |       2 |   48.9 ms |            204,661 |    21.63 |    33.75 |    35.12 |    36.72 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   40.2 ms |            248,484 |    20.96 |    30.31 |    30.36 |    30.37 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   37.3 ms |            267,965 |    16.31 |    27.81 |    29.33 |    29.78 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   41.2 ms |            242,861 |    20.82 |    32.45 |    32.88 |    32.96 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 110.4 ms
  • Peak Throughput Rate       : 226,355 ops/sec
  • Latency Distribution       : p50: 52.44ms | p90: 86.75ms | p99: 88.92ms | p99.9: 89.04ms | Max: 89.06ms
  • Memory (RSS)               : Baseline: 97.8 MB | Peak: 129.4 MB | Cooldown: 102.8 MB

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
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
📊 [WORKLOAD 1] Zero-Delay FastPing (IPC & Scheduler Baseline):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.9 ms |            112,069 |     4.25 |     5.95 |     7.44 |       7.51 |     7.51 |
|        5000 |   21.8 ms |            229,621 |    10.91 |    14.28 |    14.74 |      14.79 |    14.79 |
|       10000 |   42.6 ms |            234,578 |    20.52 |    32.44 |    34.22 |      34.24 |    34.24 |
|       25000 |  105.1 ms |            237,787 |    49.36 |    72.23 |    77.50 |      77.55 |    77.56 |
|       50000 |  193.1 ms |            258,974 |    97.61 |   151.45 |   163.12 |     163.62 |   163.63 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.5 ms |             79,848 |     6.16 |     9.56 |    11.10 |      11.27 |    11.27 |
|        5000 |   52.0 ms |             96,170 |    22.02 |    39.74 |    40.66 |      40.66 |    40.67 |
|       10000 |   94.7 ms |            105,585 |    46.29 |    78.50 |    81.28 |      81.31 |    81.32 |
|       25000 |  250.7 ms |             99,736 |   126.44 |   211.81 |   226.26 |     226.96 |   227.00 |
|       50000 |  492.7 ms |            101,489 |   246.82 |   421.52 |   457.81 |     459.77 |   459.93 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.8 ms |             29,559 |    18.58 |    29.69 |    32.24 |      32.74 |    32.74 |
|        5000 |  142.9 ms |             34,979 |    65.90 |   128.36 |   139.34 |     140.66 |   140.87 |
|       10000 |  254.1 ms |             39,361 |   124.48 |   222.20 |   246.86 |     248.93 |   249.22 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 181.6 MB
  • Settled Cooldown RSS   : 72.6 MB (Clean GC release)

=========================================================================
   ✅ COMPREHENSIVE WORKLOAD BENCHMARK COMPLETE
=========================================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
