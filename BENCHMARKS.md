# Yatta Benchmarks

> Last run: `2026-11-01T12:15:07Z` · commit [`2f87ad3`](https://github.com/psrockstar098/yatta.js/commit/2f87ad33d1901157f226358acc7d6ff6674cb108) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 110.5 ms
  • End-to-End Runtime Task Cost    : 0.0478 ms/op
  • Peak RSS Memory        : 186.2 MB
  • RSS Heap Memory             : 80.36 MB
  • Raw Worker IPC Round-Trip      : 0.0346 ms/op
  • Scheduler + Graph Overhead     : 0.0132 ms/op
  • Settled Cooldown RSS   : 73.0 MB (Clean GC release)
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
| Yatta     |      42,238 |     1.00x |    10% | 2.05ms | 4.20ms | 4.64ms |
| Raw Bun   |      44,947 |     1.06x |    22% | 2.26ms | 4.76ms | 5.11ms |
| Hono      |      43,070 |     1.02x |    10% | 1.95ms | 3.83ms | 5.14ms |
| Elysia    |      44,970 |     1.06x |    20% | 1.98ms | 4.17ms | 4.84ms |
| Express   |      14,703 |     0.35x |     8% | 7.11ms | 10.48ms | 11.98ms |
| Fastify   |      20,313 |     0.48x |    12% | 5.17ms | 8.28ms | 9.28ms |
| Koa       |      16,158 |     0.38x |     5% | 5.42ms | 9.95ms | 11.19ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,183 |       0.44 |       0.46 |       0.46 |       0.46 |
|         100 |     0.8 ms |              119,082 |       0.49 |       0.67 |       0.71 |       0.71 |
|         500 |     2.7 ms |              185,813 |       1.49 |       2.08 |       2.20 |       2.24 |
|        1000 |     3.9 ms |              253,901 |       2.19 |       3.18 |       3.31 |       3.36 |
|        5000 |    23.4 ms |              213,898 |      12.93 |      16.13 |      16.78 |      16.84 |
|       10000 |    46.6 ms |              214,676 |      20.03 |      34.13 |      37.17 |      37.31 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.1 ms |            110,462 |     3.99 |     5.99 |     7.41 |       7.79 |     7.79 |
|        5000 |   24.8 ms |            201,250 |    13.21 |    16.01 |    16.50 |      16.51 |    16.51 |
|       10000 |   46.5 ms |            214,841 |    23.25 |    35.62 |    37.50 |      37.60 |    37.61 |
|       25000 |  106.5 ms |            234,780 |    54.23 |    77.11 |    80.84 |      80.87 |    80.88 |
|       50000 |  217.9 ms |            229,420 |   111.83 |   168.77 |   183.59 |     184.15 |   184.16 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             78,458 |     6.28 |     9.55 |    11.36 |      11.68 |    11.68 |
|        5000 |   52.8 ms |             94,685 |    27.63 |    42.38 |    43.46 |      43.51 |    43.52 |
|       10000 |   94.5 ms |            105,858 |    51.04 |    75.31 |    78.50 |      78.59 |    78.60 |
|       25000 |  251.3 ms |             99,479 |   127.04 |   210.57 |   231.35 |     231.84 |   231.88 |
|       50000 |  421.8 ms |            118,530 |   216.22 |   356.80 |   386.20 |     388.03 |   388.22 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.6 ms |             40,635 |    13.87 |    21.84 |    23.48 |      23.69 |    23.69 |
|        5000 |  110.5 ms |             45,265 |    52.92 |    97.39 |   106.32 |     107.73 |   107.85 |
|       10000 |  195.7 ms |             51,099 |    96.93 |   170.74 |   189.70 |     191.60 |   191.89 |

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
  • Raw Worker IPC Round-Trip      : 0.0346 ms/op
  • End-to-End Runtime Task Cost    : 0.0478 ms/op
  • Scheduler + Graph Overhead     : 0.0132 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,183 |       0.44 |       0.46 |       0.46 |       0.46 |
|         100 |     0.8 ms |              119,082 |       0.49 |       0.67 |       0.71 |       0.71 |
|         500 |     2.7 ms |              185,813 |       1.49 |       2.08 |       2.20 |       2.24 |
|        1000 |     3.9 ms |              253,901 |       2.19 |       3.18 |       3.31 |       3.36 |
|        5000 |    23.4 ms |              213,898 |      12.93 |      16.13 |      16.78 |      16.84 |
|       10000 |    46.6 ms |              214,676 |      20.03 |      34.13 |      37.17 |      37.31 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.36 MB
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
| 1 CPU + 1 IO  |       2 |   44.7 ms |            223,597 |    20.72 |    34.48 |    35.09 |    35.11 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   41.3 ms |            241,839 |    21.43 |    31.32 |    31.51 |    31.53 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.8 ms |            279,097 |    19.31 |    28.05 |    29.04 |    29.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   43.0 ms |            232,572 |    21.97 |    33.06 |    34.71 |    34.80 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 110.5 ms
  • Peak Throughput Rate       : 226,214 ops/sec
  • Latency Distribution       : p50: 54.22ms | p90: 88.73ms | p99: 89.78ms | p99.9: 89.89ms | Max: 89.92ms
  • Memory (RSS)               : Baseline: 103.2 MB | Peak: 130.7 MB | Cooldown: 103.8 MB

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
|        1000 |    9.1 ms |            110,462 |     3.99 |     5.99 |     7.41 |       7.79 |     7.79 |
|        5000 |   24.8 ms |            201,250 |    13.21 |    16.01 |    16.50 |      16.51 |    16.51 |
|       10000 |   46.5 ms |            214,841 |    23.25 |    35.62 |    37.50 |      37.60 |    37.61 |
|       25000 |  106.5 ms |            234,780 |    54.23 |    77.11 |    80.84 |      80.87 |    80.88 |
|       50000 |  217.9 ms |            229,420 |   111.83 |   168.77 |   183.59 |     184.15 |   184.16 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             78,458 |     6.28 |     9.55 |    11.36 |      11.68 |    11.68 |
|        5000 |   52.8 ms |             94,685 |    27.63 |    42.38 |    43.46 |      43.51 |    43.52 |
|       10000 |   94.5 ms |            105,858 |    51.04 |    75.31 |    78.50 |      78.59 |    78.60 |
|       25000 |  251.3 ms |             99,479 |   127.04 |   210.57 |   231.35 |     231.84 |   231.88 |
|       50000 |  421.8 ms |            118,530 |   216.22 |   356.80 |   386.20 |     388.03 |   388.22 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.6 ms |             40,635 |    13.87 |    21.84 |    23.48 |      23.69 |    23.69 |
|        5000 |  110.5 ms |             45,265 |    52.92 |    97.39 |   106.32 |     107.73 |   107.85 |
|       10000 |  195.7 ms |             51,099 |    96.93 |   170.74 |   189.70 |     191.60 |   191.89 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 186.2 MB
  • Settled Cooldown RSS   : 73.0 MB (Clean GC release)

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
| Yatta     |      42,238 |     1.00x |    10% | 2.05ms | 4.20ms | 4.64ms |
| Raw Bun   |      44,947 |     1.06x |    22% | 2.26ms | 4.76ms | 5.11ms |
| Hono      |      43,070 |     1.02x |    10% | 1.95ms | 3.83ms | 5.14ms |
| Elysia    |      44,970 |     1.06x |    20% | 1.98ms | 4.17ms | 4.84ms |
| Express   |      14,703 |     0.35x |     8% | 7.11ms | 10.48ms | 11.98ms |
| Fastify   |      20,313 |     0.48x |    12% | 5.17ms | 8.28ms | 9.28ms |
| Koa       |      16,158 |     0.38x |     5% | 5.42ms | 9.95ms | 11.19ms |

  Yatta dispatch adds about 1.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
