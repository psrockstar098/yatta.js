# Yatta Benchmarks

> Last run: `2026-10-05T22:07:56Z` · commit [`9851e65`](https://github.com/psrockstar098/yatta.js/commit/9851e656222d3f76845af4ea799ba6bd8c0a17c6) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 97.9 ms
  • End-to-End Runtime Task Cost    : 0.0292 ms/op
  • Peak RSS Memory        : 147.7 MB
  • RSS Heap Memory             : 96.92 MB
  • Raw Worker IPC Round-Trip      : 0.0265 ms/op
  • Scheduler + Graph Overhead     : 0.0027 ms/op
  • Settled Cooldown RSS   : 90.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.43 MB
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)
```

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,227 |       0.29 |       0.30 |       0.30 |       0.30 |
|         100 |     0.6 ms |              167,676 |       0.25 |       0.31 |       0.34 |       0.34 |
|         500 |     1.5 ms |              327,543 |       0.73 |       1.15 |       1.24 |       1.27 |
|        1000 |     2.7 ms |              369,506 |       1.38 |       2.13 |       2.23 |       2.28 |
|        5000 |    19.9 ms |              250,978 |      10.16 |      14.04 |      14.07 |      14.09 |
|       10000 |    36.1 ms |              276,842 |      19.53 |      28.76 |      28.92 |      28.97 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.3 ms |            120,550 |     3.74 |     6.25 |     7.23 |       7.48 |     7.48 |
|        5000 |   22.6 ms |            221,069 |    10.73 |    15.35 |    15.79 |      15.80 |    15.80 |
|       10000 |   42.5 ms |            235,176 |    20.72 |    33.22 |    34.16 |      34.21 |    34.21 |
|       25000 |   94.4 ms |            264,963 |    44.73 |    72.03 |    77.41 |      77.63 |    77.63 |
|       50000 |  187.2 ms |            267,091 |    97.85 |   154.61 |   164.00 |     164.42 |   164.43 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.1 ms |             90,460 |     4.89 |     8.76 |     9.82 |       9.92 |     9.92 |
|        5000 |   40.6 ms |            123,017 |    19.50 |    30.77 |    31.68 |      31.74 |    31.74 |
|       10000 |   70.8 ms |            141,339 |    37.47 |    57.52 |    59.33 |      59.48 |    59.49 |
|       25000 |  182.8 ms |            136,793 |    96.09 |   156.47 |   162.33 |     163.31 |   163.43 |
|       50000 |  374.7 ms |            133,449 |   197.68 |   311.50 |   334.89 |     336.14 |   336.21 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   20.6 ms |             48,593 |    10.87 |    18.06 |    19.54 |      19.75 |    19.75 |
|        5000 |   79.7 ms |             62,714 |    39.15 |    67.20 |    73.65 |      76.09 |    76.22 |
|       10000 |  186.6 ms |             53,581 |    86.50 |   157.58 |   178.26 |     180.58 |   180.80 |

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
  • Raw Worker IPC Round-Trip      : 0.0265 ms/op
  • End-to-End Runtime Task Cost    : 0.0292 ms/op
  • Scheduler + Graph Overhead     : 0.0027 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,227 |       0.29 |       0.30 |       0.30 |       0.30 |
|         100 |     0.6 ms |              167,676 |       0.25 |       0.31 |       0.34 |       0.34 |
|         500 |     1.5 ms |              327,543 |       0.73 |       1.15 |       1.24 |       1.27 |
|        1000 |     2.7 ms |              369,506 |       1.38 |       2.13 |       2.23 |       2.28 |
|        5000 |    19.9 ms |              250,978 |      10.16 |      14.04 |      14.07 |      14.09 |
|       10000 |    36.1 ms |              276,842 |      19.53 |      28.76 |      28.92 |      28.97 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.92 MB
  • V8/JSC Heap Used             : 13.43 MB

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
| 1 CPU + 1 IO  |       2 |   37.6 ms |            265,825 |    16.80 |    28.78 |    29.61 |    29.85 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   39.4 ms |            253,720 |    17.66 |    30.77 |    30.89 |    30.98 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   29.3 ms |            341,724 |    15.96 |    22.99 |    23.49 |    23.62 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   48.8 ms |            204,773 |    24.58 |    39.10 |    39.13 |    39.16 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 97.9 ms
  • Peak Throughput Rate       : 255,355 ops/sec
  • Latency Distribution       : p50: 49.65ms | p90: 77.96ms | p99: 79.78ms | p99.9: 79.89ms | Max: 79.91ms
  • Memory (RSS)               : Baseline: 104.5 MB | Peak: 134.0 MB | Cooldown: 103.9 MB

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
|        1000 |    8.3 ms |            120,550 |     3.74 |     6.25 |     7.23 |       7.48 |     7.48 |
|        5000 |   22.6 ms |            221,069 |    10.73 |    15.35 |    15.79 |      15.80 |    15.80 |
|       10000 |   42.5 ms |            235,176 |    20.72 |    33.22 |    34.16 |      34.21 |    34.21 |
|       25000 |   94.4 ms |            264,963 |    44.73 |    72.03 |    77.41 |      77.63 |    77.63 |
|       50000 |  187.2 ms |            267,091 |    97.85 |   154.61 |   164.00 |     164.42 |   164.43 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.1 ms |             90,460 |     4.89 |     8.76 |     9.82 |       9.92 |     9.92 |
|        5000 |   40.6 ms |            123,017 |    19.50 |    30.77 |    31.68 |      31.74 |    31.74 |
|       10000 |   70.8 ms |            141,339 |    37.47 |    57.52 |    59.33 |      59.48 |    59.49 |
|       25000 |  182.8 ms |            136,793 |    96.09 |   156.47 |   162.33 |     163.31 |   163.43 |
|       50000 |  374.7 ms |            133,449 |   197.68 |   311.50 |   334.89 |     336.14 |   336.21 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   20.6 ms |             48,593 |    10.87 |    18.06 |    19.54 |      19.75 |    19.75 |
|        5000 |   79.7 ms |             62,714 |    39.15 |    67.20 |    73.65 |      76.09 |    76.22 |
|       10000 |  186.6 ms |             53,581 |    86.50 |   157.58 |   178.26 |     180.58 |   180.80 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 147.7 MB
  • Settled Cooldown RSS   : 90.8 MB (Clean GC release)

=========================================================================
   ✅ COMPREHENSIVE WORKLOAD BENCHMARK COMPLETE
=========================================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
