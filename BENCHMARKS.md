# Yatta Benchmarks

> Last run: `2026-11-24T07:08:14Z` · commit [`6afbcab`](https://github.com/psrockstar098/yatta.js/commit/6afbcab739339f26e9adcbf5f4aee8af895c8c95) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 106.3 ms
  • End-to-End Runtime Task Cost    : 0.0398 ms/op
  • Peak RSS Memory        : 143.1 MB
  • RSS Heap Memory             : 84.96 MB
  • Raw Worker IPC Round-Trip      : 0.0319 ms/op
  • Scheduler + Graph Overhead     : 0.0079 ms/op
  • Settled Cooldown RSS   : 94.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 1.25 MB
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
| Yatta     |      41,642 |     1.00x |    32% | 2.04ms | 4.24ms | 4.71ms |
| Raw Bun   |      42,192 |     1.01x |     3% | 2.16ms | 4.68ms | 5.83ms |
| Hono      |      48,568 |     1.17x |    17% | 1.85ms | 3.16ms | 3.92ms |
| Elysia    |      44,211 |     1.06x |    24% | 2.23ms | 4.73ms | 4.82ms |
| Express   |      15,579 |     0.37x |    15% | 5.99ms | 9.76ms | 11.14ms |
| Fastify   |      20,679 |     0.50x |    17% | 5.12ms | 8.60ms | 11.32ms |
| Koa       |      15,921 |     0.38x |     4% | 5.46ms | 11.13ms | 16.17ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,661 |       0.38 |       0.39 |       0.39 |       0.39 |
|         100 |     0.8 ms |              125,607 |       0.33 |       0.49 |       0.54 |       0.54 |
|         500 |     2.2 ms |              222,589 |       1.16 |       1.79 |       1.90 |       1.93 |
|        1000 |     4.5 ms |              221,702 |       2.32 |       3.62 |       3.74 |       3.79 |
|        5000 |    22.7 ms |              220,405 |      11.51 |      14.90 |      14.94 |      14.95 |
|       10000 |    40.3 ms |              248,348 |      20.39 |      30.02 |      31.28 |      31.57 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.7 ms |            114,936 |     3.86 |     5.54 |     6.77 |       7.13 |     7.13 |
|        5000 |   26.1 ms |            191,581 |    11.78 |    18.83 |    19.34 |      19.35 |    19.35 |
|       10000 |   46.1 ms |            217,018 |    25.57 |    35.30 |    37.08 |      37.09 |    37.09 |
|       25000 |   95.5 ms |            261,687 |    48.49 |    71.51 |    75.08 |      75.23 |    75.25 |
|       50000 |  195.9 ms |            255,174 |    98.59 |   151.53 |   161.10 |     161.49 |   161.54 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.2 ms |             89,029 |     5.60 |     8.58 |     9.94 |      10.05 |    10.05 |
|        5000 |   39.3 ms |            127,112 |    19.40 |    29.60 |    30.69 |      30.73 |    30.74 |
|       10000 |   88.6 ms |            112,837 |    43.34 |    75.82 |    78.49 |      78.58 |    78.59 |
|       25000 |  245.7 ms |            101,754 |   126.84 |   211.21 |   225.64 |     226.18 |   226.21 |
|       50000 |  466.4 ms |            107,199 |   238.05 |   395.89 |   428.36 |     429.18 |   429.25 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   25.9 ms |             38,636 |    13.19 |    22.49 |    24.56 |      24.77 |    24.77 |
|        5000 |  101.1 ms |             49,480 |    53.88 |    89.79 |    97.09 |      98.33 |    98.45 |
|       10000 |  206.6 ms |             48,401 |    96.25 |   179.77 |   195.23 |     198.79 |   199.06 |

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
  • Raw Worker IPC Round-Trip      : 0.0319 ms/op
  • End-to-End Runtime Task Cost    : 0.0398 ms/op
  • Scheduler + Graph Overhead     : 0.0079 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,661 |       0.38 |       0.39 |       0.39 |       0.39 |
|         100 |     0.8 ms |              125,607 |       0.33 |       0.49 |       0.54 |       0.54 |
|         500 |     2.2 ms |              222,589 |       1.16 |       1.79 |       1.90 |       1.93 |
|        1000 |     4.5 ms |              221,702 |       2.32 |       3.62 |       3.74 |       3.79 |
|        5000 |    22.7 ms |              220,405 |      11.51 |      14.90 |      14.94 |      14.95 |
|       10000 |    40.3 ms |              248,348 |      20.39 |      30.02 |      31.28 |      31.57 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 84.96 MB
  • V8/JSC Heap Used             : 1.25 MB

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
| 1 CPU + 1 IO  |       2 |   52.6 ms |            190,213 |    27.12 |    39.41 |    39.82 |    40.13 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   47.7 ms |            209,590 |    22.16 |    36.01 |    36.06 |    36.08 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   44.3 ms |            225,756 |    20.80 |    33.52 |    34.91 |    35.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   36.9 ms |            271,364 |    17.41 |    28.24 |    28.62 |    28.64 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 106.3 ms
  • Peak Throughput Rate       : 235,197 ops/sec
  • Latency Distribution       : p50: 49.34ms | p90: 85.14ms | p99: 87.95ms | p99.9: 87.96ms | Max: 87.96ms
  • Memory (RSS)               : Baseline: 103.7 MB | Peak: 131.4 MB | Cooldown: 104.7 MB

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
|        1000 |    8.7 ms |            114,936 |     3.86 |     5.54 |     6.77 |       7.13 |     7.13 |
|        5000 |   26.1 ms |            191,581 |    11.78 |    18.83 |    19.34 |      19.35 |    19.35 |
|       10000 |   46.1 ms |            217,018 |    25.57 |    35.30 |    37.08 |      37.09 |    37.09 |
|       25000 |   95.5 ms |            261,687 |    48.49 |    71.51 |    75.08 |      75.23 |    75.25 |
|       50000 |  195.9 ms |            255,174 |    98.59 |   151.53 |   161.10 |     161.49 |   161.54 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.2 ms |             89,029 |     5.60 |     8.58 |     9.94 |      10.05 |    10.05 |
|        5000 |   39.3 ms |            127,112 |    19.40 |    29.60 |    30.69 |      30.73 |    30.74 |
|       10000 |   88.6 ms |            112,837 |    43.34 |    75.82 |    78.49 |      78.58 |    78.59 |
|       25000 |  245.7 ms |            101,754 |   126.84 |   211.21 |   225.64 |     226.18 |   226.21 |
|       50000 |  466.4 ms |            107,199 |   238.05 |   395.89 |   428.36 |     429.18 |   429.25 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   25.9 ms |             38,636 |    13.19 |    22.49 |    24.56 |      24.77 |    24.77 |
|        5000 |  101.1 ms |             49,480 |    53.88 |    89.79 |    97.09 |      98.33 |    98.45 |
|       10000 |  206.6 ms |             48,401 |    96.25 |   179.77 |   195.23 |     198.79 |   199.06 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 143.1 MB
  • Settled Cooldown RSS   : 94.2 MB (Clean GC release)

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
| Yatta     |      41,642 |     1.00x |    32% | 2.04ms | 4.24ms | 4.71ms |
| Raw Bun   |      42,192 |     1.01x |     3% | 2.16ms | 4.68ms | 5.83ms |
| Hono      |      48,568 |     1.17x |    17% | 1.85ms | 3.16ms | 3.92ms |
| Elysia    |      44,211 |     1.06x |    24% | 2.23ms | 4.73ms | 4.82ms |
| Express   |      15,579 |     0.37x |    15% | 5.99ms | 9.76ms | 11.14ms |
| Fastify   |      20,679 |     0.50x |    17% | 5.12ms | 8.60ms | 11.32ms |
| Koa       |      15,921 |     0.38x |     4% | 5.46ms | 11.13ms | 16.17ms |

  Yatta dispatch adds about 0.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 32%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
