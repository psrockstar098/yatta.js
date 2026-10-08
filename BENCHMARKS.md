# Yatta Benchmarks

> Last run: `2026-10-08T18:10:41Z` · commit [`f393604`](https://github.com/psrockstar098/yatta.js/commit/f393604d8200949e9f5a52d0d9ff8578c62558b4) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 134.2 ms
  • End-to-End Runtime Task Cost    : 0.0518 ms/op
  • Peak RSS Memory        : 173.5 MB
  • RSS Heap Memory             : 69.64 MB
  • Raw Worker IPC Round-Trip      : 0.0422 ms/op
  • Scheduler + Graph Overhead     : 0.0096 ms/op
  • Settled Cooldown RSS   : 71.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.76 MB
  • Worker Fleet Event Loop Lag : 10.16 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      35,778 |     1.00x |    12% | 2.23ms | 4.34ms | 5.75ms |
| Raw Bun   |      44,431 |     1.24x |    17% | 2.37ms | 3.55ms | 5.17ms |
| Hono      |      47,740 |     1.33x |    16% | 1.99ms | 3.72ms | 4.44ms |
| Elysia    |      45,110 |     1.26x |    19% | 2.26ms | 3.96ms | 5.20ms |
| Express   |      15,022 |     0.42x |     4% | 6.42ms | 10.93ms | 12.28ms |
| Fastify   |      19,463 |     0.54x |     4% | 5.10ms | 8.67ms | 10.35ms |
| Koa       |      15,172 |     0.42x |     5% | 6.11ms | 10.37ms | 12.53ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,427 |       0.47 |       0.52 |       0.52 |       0.52 |
|         100 |     0.9 ms |              114,117 |       0.32 |       0.53 |       0.57 |       0.57 |
|         500 |     3.0 ms |              169,168 |       1.58 |       2.33 |       2.43 |       2.46 |
|        1000 |     5.5 ms |              181,375 |       2.68 |       3.83 |       3.92 |       3.97 |
|        5000 |    28.3 ms |              176,562 |      15.59 |      18.94 |      19.39 |      19.40 |
|       10000 |    54.6 ms |              183,051 |      24.86 |      42.96 |      43.62 |      43.94 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.7 ms |             93,780 |     5.98 |     7.82 |     9.01 |       9.45 |     9.45 |
|        5000 |   26.7 ms |            187,465 |    12.16 |    16.41 |    16.90 |      16.91 |    16.92 |
|       10000 |   59.1 ms |            169,158 |    28.32 |    43.55 |    46.62 |      46.85 |    46.85 |
|       25000 |  113.5 ms |            220,189 |    55.05 |    77.89 |    81.24 |      81.29 |    81.29 |
|       50000 |  198.7 ms |            251,580 |    97.96 |   155.54 |   167.86 |     167.96 |   168.00 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.5 ms |             68,989 |     7.93 |    11.44 |    12.96 |      13.25 |    13.25 |
|        5000 |   36.1 ms |            138,327 |    18.26 |    28.07 |    29.36 |      29.42 |    29.43 |
|       10000 |   79.9 ms |            125,095 |    39.55 |    65.77 |    68.56 |      68.63 |    68.64 |
|       25000 |  222.8 ms |            112,199 |   116.24 |   191.01 |   202.08 |     202.52 |   202.55 |
|       50000 |  460.7 ms |            108,528 |   233.04 |   395.15 |   421.30 |     423.43 |   423.60 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   34.3 ms |             29,162 |    19.37 |    30.37 |    32.63 |      33.09 |    33.09 |
|        5000 |  143.3 ms |             34,883 |    79.41 |   127.76 |   139.21 |     140.93 |   141.10 |
|       10000 |  269.0 ms |             37,171 |   134.35 |   236.86 |   260.60 |     263.35 |   263.83 |

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
  • Raw Worker IPC Round-Trip      : 0.0422 ms/op
  • End-to-End Runtime Task Cost    : 0.0518 ms/op
  • Scheduler + Graph Overhead     : 0.0096 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,427 |       0.47 |       0.52 |       0.52 |       0.52 |
|         100 |     0.9 ms |              114,117 |       0.32 |       0.53 |       0.57 |       0.57 |
|         500 |     3.0 ms |              169,168 |       1.58 |       2.33 |       2.43 |       2.46 |
|        1000 |     5.5 ms |              181,375 |       2.68 |       3.83 |       3.92 |       3.97 |
|        5000 |    28.3 ms |              176,562 |      15.59 |      18.94 |      19.39 |      19.40 |
|       10000 |    54.6 ms |              183,051 |      24.86 |      42.96 |      43.62 |      43.94 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.16 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 69.64 MB
  • V8/JSC Heap Used             : 0.76 MB

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
| 1 CPU + 1 IO  |       2 |   64.6 ms |            154,826 |    31.31 |    49.83 |    51.48 |    51.57 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   52.8 ms |            189,506 |    26.45 |    39.15 |    39.46 |    39.51 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   48.9 ms |            204,348 |    20.33 |    38.18 |    40.07 |    40.13 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   46.0 ms |            217,416 |    25.78 |    36.36 |    37.30 |    37.37 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 134.2 ms
  • Peak Throughput Rate       : 186,273 ops/sec
  • Latency Distribution       : p50: 65.05ms | p90: 104.18ms | p99: 105.62ms | p99.9: 105.78ms | Max: 105.83ms
  • Memory (RSS)               : Baseline: 101.6 MB | Peak: 131.6 MB | Cooldown: 103.7 MB

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
|        1000 |   10.7 ms |             93,780 |     5.98 |     7.82 |     9.01 |       9.45 |     9.45 |
|        5000 |   26.7 ms |            187,465 |    12.16 |    16.41 |    16.90 |      16.91 |    16.92 |
|       10000 |   59.1 ms |            169,158 |    28.32 |    43.55 |    46.62 |      46.85 |    46.85 |
|       25000 |  113.5 ms |            220,189 |    55.05 |    77.89 |    81.24 |      81.29 |    81.29 |
|       50000 |  198.7 ms |            251,580 |    97.96 |   155.54 |   167.86 |     167.96 |   168.00 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.5 ms |             68,989 |     7.93 |    11.44 |    12.96 |      13.25 |    13.25 |
|        5000 |   36.1 ms |            138,327 |    18.26 |    28.07 |    29.36 |      29.42 |    29.43 |
|       10000 |   79.9 ms |            125,095 |    39.55 |    65.77 |    68.56 |      68.63 |    68.64 |
|       25000 |  222.8 ms |            112,199 |   116.24 |   191.01 |   202.08 |     202.52 |   202.55 |
|       50000 |  460.7 ms |            108,528 |   233.04 |   395.15 |   421.30 |     423.43 |   423.60 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   34.3 ms |             29,162 |    19.37 |    30.37 |    32.63 |      33.09 |    33.09 |
|        5000 |  143.3 ms |             34,883 |    79.41 |   127.76 |   139.21 |     140.93 |   141.10 |
|       10000 |  269.0 ms |             37,171 |   134.35 |   236.86 |   260.60 |     263.35 |   263.83 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 173.5 MB
  • Settled Cooldown RSS   : 71.7 MB (Clean GC release)

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
| Yatta     |      35,778 |     1.00x |    12% | 2.23ms | 4.34ms | 5.75ms |
| Raw Bun   |      44,431 |     1.24x |    17% | 2.37ms | 3.55ms | 5.17ms |
| Hono      |      47,740 |     1.33x |    16% | 1.99ms | 3.72ms | 4.44ms |
| Elysia    |      45,110 |     1.26x |    19% | 2.26ms | 3.96ms | 5.20ms |
| Express   |      15,022 |     0.42x |     4% | 6.42ms | 10.93ms | 12.28ms |
| Fastify   |      19,463 |     0.54x |     4% | 5.10ms | 8.67ms | 10.35ms |
| Koa       |      15,172 |     0.42x |     5% | 6.11ms | 10.37ms | 12.53ms |

  Yatta dispatch adds about 5.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
