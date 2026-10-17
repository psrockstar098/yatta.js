# Yatta Benchmarks

> Last run: `2026-10-17T03:57:56Z` · commit [`d60dc6f`](https://github.com/psrockstar098/yatta.js/commit/d60dc6fbe0619c2762bdcc8fc9eabcda0f69826d) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 128.6 ms
  • End-to-End Runtime Task Cost    : 0.0519 ms/op
  • Peak RSS Memory        : 130.2 MB
  • RSS Heap Memory             : 80.29 MB
  • Raw Worker IPC Round-Trip      : 0.0389 ms/op
  • Scheduler + Graph Overhead     : 0.0130 ms/op
  • Settled Cooldown RSS   : 83.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      42,948 |     1.00x |    19% | 2.17ms | 4.37ms | 4.93ms |
| Raw Bun   |      46,183 |     1.08x |     7% | 2.02ms | 3.63ms | 5.06ms |
| Hono      |      45,007 |     1.05x |    33% | 1.87ms | 3.39ms | 4.08ms |
| Elysia    |      44,864 |     1.04x |     6% | 2.20ms | 4.52ms | 5.15ms |
| Express   |      14,382 |     0.33x |    15% | 7.43ms | 10.93ms | 13.09ms |
| Fastify   |      19,701 |     0.46x |    16% | 4.95ms | 7.98ms | 9.38ms |
| Koa       |      15,981 |     0.37x |     3% | 5.43ms | 10.44ms | 11.77ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,210 |       0.35 |       0.45 |       0.45 |       0.45 |
|         100 |     1.1 ms |               93,317 |       0.36 |       0.64 |       0.65 |       0.65 |
|         500 |     2.7 ms |              183,958 |       1.33 |       1.95 |       2.02 |       2.05 |
|        1000 |     5.0 ms |              198,978 |       2.50 |       3.31 |       3.40 |       3.44 |
|        5000 |    28.5 ms |              175,201 |      15.31 |      19.44 |      19.52 |      19.56 |
|       10000 |    51.3 ms |              194,844 |      25.87 |      41.10 |      41.49 |      41.52 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.3 ms |             96,870 |     5.45 |     7.12 |     8.59 |       8.73 |     8.73 |
|        5000 |   24.0 ms |            208,218 |    11.75 |    16.45 |    16.94 |      16.96 |    16.97 |
|       10000 |   47.7 ms |            209,600 |    23.74 |    36.22 |    38.34 |      38.36 |    38.36 |
|       25000 |  107.9 ms |            231,680 |    52.42 |    77.75 |    83.06 |      83.10 |    83.11 |
|       50000 |  217.0 ms |            230,468 |   107.07 |   164.98 |   181.57 |     182.14 |   182.15 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.6 ms |             79,580 |     6.42 |     9.56 |    10.89 |      11.02 |    11.02 |
|        5000 |   52.4 ms |             95,480 |    25.12 |    40.10 |    41.15 |      41.20 |    41.21 |
|       10000 |  106.6 ms |             93,797 |    56.80 |    90.08 |    93.24 |      93.30 |    93.30 |
|       25000 |  282.7 ms |             88,430 |   142.00 |   247.05 |   261.90 |     262.00 |   262.01 |
|       50000 |  585.1 ms |             85,457 |   323.18 |   489.63 |   528.56 |     529.72 |   529.81 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.5 ms |             30,746 |    16.43 |    27.74 |    31.12 |      31.53 |    31.53 |
|        5000 |  156.1 ms |             32,024 |    69.10 |   125.19 |   148.73 |     150.93 |   151.12 |
|       10000 |  280.1 ms |             35,704 |   136.05 |   240.65 |   267.89 |     270.45 |   270.79 |

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
  • Raw Worker IPC Round-Trip      : 0.0389 ms/op
  • End-to-End Runtime Task Cost    : 0.0519 ms/op
  • Scheduler + Graph Overhead     : 0.0130 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,210 |       0.35 |       0.45 |       0.45 |       0.45 |
|         100 |     1.1 ms |               93,317 |       0.36 |       0.64 |       0.65 |       0.65 |
|         500 |     2.7 ms |              183,958 |       1.33 |       1.95 |       2.02 |       2.05 |
|        1000 |     5.0 ms |              198,978 |       2.50 |       3.31 |       3.40 |       3.44 |
|        5000 |    28.5 ms |              175,201 |      15.31 |      19.44 |      19.52 |      19.56 |
|       10000 |    51.3 ms |              194,844 |      25.87 |      41.10 |      41.49 |      41.52 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.29 MB
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
| 1 CPU + 1 IO  |       2 |   57.4 ms |            174,206 |    28.12 |    43.59 |    45.20 |    45.32 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   50.1 ms |            199,658 |    25.17 |    38.58 |    39.30 |    39.50 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   48.6 ms |            205,812 |    25.36 |    39.70 |    40.29 |    40.71 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   49.8 ms |            200,745 |    21.76 |    41.40 |    42.01 |    42.13 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 128.6 ms
  • Peak Throughput Rate       : 194,375 ops/sec
  • Latency Distribution       : p50: 61.08ms | p90: 89.31ms | p99: 90.58ms | p99.9: 90.68ms | Max: 90.69ms
  • Memory (RSS)               : Baseline: 103.9 MB | Peak: 132.2 MB | Cooldown: 103.8 MB

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
|        1000 |   10.3 ms |             96,870 |     5.45 |     7.12 |     8.59 |       8.73 |     8.73 |
|        5000 |   24.0 ms |            208,218 |    11.75 |    16.45 |    16.94 |      16.96 |    16.97 |
|       10000 |   47.7 ms |            209,600 |    23.74 |    36.22 |    38.34 |      38.36 |    38.36 |
|       25000 |  107.9 ms |            231,680 |    52.42 |    77.75 |    83.06 |      83.10 |    83.11 |
|       50000 |  217.0 ms |            230,468 |   107.07 |   164.98 |   181.57 |     182.14 |   182.15 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.6 ms |             79,580 |     6.42 |     9.56 |    10.89 |      11.02 |    11.02 |
|        5000 |   52.4 ms |             95,480 |    25.12 |    40.10 |    41.15 |      41.20 |    41.21 |
|       10000 |  106.6 ms |             93,797 |    56.80 |    90.08 |    93.24 |      93.30 |    93.30 |
|       25000 |  282.7 ms |             88,430 |   142.00 |   247.05 |   261.90 |     262.00 |   262.01 |
|       50000 |  585.1 ms |             85,457 |   323.18 |   489.63 |   528.56 |     529.72 |   529.81 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.5 ms |             30,746 |    16.43 |    27.74 |    31.12 |      31.53 |    31.53 |
|        5000 |  156.1 ms |             32,024 |    69.10 |   125.19 |   148.73 |     150.93 |   151.12 |
|       10000 |  280.1 ms |             35,704 |   136.05 |   240.65 |   267.89 |     270.45 |   270.79 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 130.2 MB
  • Settled Cooldown RSS   : 83.8 MB (Clean GC release)

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
| Yatta     |      42,948 |     1.00x |    19% | 2.17ms | 4.37ms | 4.93ms |
| Raw Bun   |      46,183 |     1.08x |     7% | 2.02ms | 3.63ms | 5.06ms |
| Hono      |      45,007 |     1.05x |    33% | 1.87ms | 3.39ms | 4.08ms |
| Elysia    |      44,864 |     1.04x |     6% | 2.20ms | 4.52ms | 5.15ms |
| Express   |      14,382 |     0.33x |    15% | 7.43ms | 10.93ms | 13.09ms |
| Fastify   |      19,701 |     0.46x |    16% | 4.95ms | 7.98ms | 9.38ms |
| Koa       |      15,981 |     0.37x |     3% | 5.43ms | 10.44ms | 11.77ms |

  Yatta dispatch adds about 1.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 19%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
