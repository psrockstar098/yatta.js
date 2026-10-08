# Yatta Benchmarks

> Last run: `2026-10-08T20:02:20Z` · commit [`cf38303`](https://github.com/psrockstar098/yatta.js/commit/cf383031d102f1bd5a9658c51e51ee6875e85e82) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 93.0 ms
  • End-to-End Runtime Task Cost    : 0.0386 ms/op
  • Peak RSS Memory        : 190.6 MB
  • RSS Heap Memory             : 80.45 MB
  • Raw Worker IPC Round-Trip      : 0.0346 ms/op
  • Scheduler + Graph Overhead     : 0.0040 ms/op
  • Settled Cooldown RSS   : 146.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.67 MB
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      46,361 |     1.00x |    10% | 2.01ms | 3.62ms | 4.24ms |
| Raw Bun   |      70,540 |     1.52x |    12% | 1.35ms | 2.30ms | 2.69ms |
| Hono      |      57,072 |     1.23x |    20% | 1.65ms | 3.16ms | 3.65ms |
| Elysia    |      68,031 |     1.47x |    11% | 1.43ms | 2.51ms | 2.83ms |
| Express   |      19,475 |     0.42x |     4% | 4.62ms | 8.67ms | 11.37ms |
| Fastify   |      27,350 |     0.59x |     4% | 3.38ms | 6.22ms | 7.46ms |
| Koa       |      20,499 |     0.44x |     2% | 4.57ms | 7.94ms | 8.87ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.1 ms |                8,989 |       0.56 |       0.61 |       0.61 |       0.61 |
|         100 |     1.5 ms |               64,893 |       0.33 |       1.06 |       1.08 |       1.08 |
|         500 |     2.0 ms |              248,731 |       0.88 |       1.58 |       1.66 |       1.68 |
|        1000 |     4.7 ms |              212,265 |       2.03 |       2.56 |       2.65 |       2.70 |
|        5000 |    28.0 ms |              178,630 |      15.82 |      19.42 |      19.55 |      19.57 |
|       10000 |    49.5 ms |              201,996 |      27.20 |      40.09 |      40.36 |      40.50 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.8 ms |            146,333 |     2.98 |     4.33 |     5.49 |       5.60 |     5.60 |
|        5000 |   21.3 ms |            234,747 |    10.27 |    14.38 |    15.17 |      15.18 |    15.18 |
|       10000 |   41.0 ms |            244,132 |    17.72 |    30.19 |    30.87 |      30.89 |    30.90 |
|       25000 |   91.3 ms |            273,722 |    46.65 |    66.18 |    68.31 |      68.34 |    68.34 |
|       50000 |  139.2 ms |            359,069 |    68.24 |    96.28 |   104.00 |     104.51 |   104.52 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.3 ms |             81,073 |     5.99 |     9.07 |    10.78 |      10.95 |    10.95 |
|        5000 |   54.5 ms |             91,735 |    24.03 |    42.17 |    43.13 |      43.28 |    43.29 |
|       10000 |  104.9 ms |             95,290 |    50.28 |    84.72 |    91.51 |      91.65 |    91.66 |
|       25000 |  250.2 ms |             99,908 |   109.39 |   207.29 |   222.70 |     223.18 |   223.20 |
|       50000 |  446.9 ms |            111,878 |   236.98 |   379.15 |   408.14 |     409.43 |   409.51 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.5 ms |             40,818 |    12.47 |    20.54 |    23.12 |      23.46 |    23.46 |
|        5000 |   96.3 ms |             51,948 |    50.80 |    83.38 |    91.94 |      93.45 |    93.62 |
|       10000 |  204.8 ms |             48,825 |    99.71 |   177.70 |   198.03 |     199.57 |   199.77 |

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
  • Raw Worker IPC Round-Trip      : 0.0346 ms/op
  • End-to-End Runtime Task Cost    : 0.0386 ms/op
  • Scheduler + Graph Overhead     : 0.0040 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.1 ms |                8,989 |       0.56 |       0.61 |       0.61 |       0.61 |
|         100 |     1.5 ms |               64,893 |       0.33 |       1.06 |       1.08 |       1.08 |
|         500 |     2.0 ms |              248,731 |       0.88 |       1.58 |       1.66 |       1.68 |
|        1000 |     4.7 ms |              212,265 |       2.03 |       2.56 |       2.65 |       2.70 |
|        5000 |    28.0 ms |              178,630 |      15.82 |      19.42 |      19.55 |      19.57 |
|       10000 |    49.5 ms |              201,996 |      27.20 |      40.09 |      40.36 |      40.50 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.45 MB
  • V8/JSC Heap Used             : 13.67 MB

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
| 1 CPU + 1 IO  |       2 |   45.7 ms |            218,958 |    20.91 |    35.29 |    36.02 |    36.13 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   40.0 ms |            250,176 |    20.70 |    29.19 |    29.54 |    29.58 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   38.4 ms |            260,354 |    18.12 |    26.96 |    28.02 |    28.28 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   37.2 ms |            268,488 |    20.58 |    26.31 |    27.87 |    28.05 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 93.0 ms
  • Peak Throughput Rate       : 268,738 ops/sec
  • Latency Distribution       : p50: 43.70ms | p90: 70.20ms | p99: 71.77ms | p99.9: 71.87ms | Max: 71.89ms
  • Memory (RSS)               : Baseline: 98.6 MB | Peak: 128.1 MB | Cooldown: 83.8 MB

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
|        1000 |    6.8 ms |            146,333 |     2.98 |     4.33 |     5.49 |       5.60 |     5.60 |
|        5000 |   21.3 ms |            234,747 |    10.27 |    14.38 |    15.17 |      15.18 |    15.18 |
|       10000 |   41.0 ms |            244,132 |    17.72 |    30.19 |    30.87 |      30.89 |    30.90 |
|       25000 |   91.3 ms |            273,722 |    46.65 |    66.18 |    68.31 |      68.34 |    68.34 |
|       50000 |  139.2 ms |            359,069 |    68.24 |    96.28 |   104.00 |     104.51 |   104.52 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.3 ms |             81,073 |     5.99 |     9.07 |    10.78 |      10.95 |    10.95 |
|        5000 |   54.5 ms |             91,735 |    24.03 |    42.17 |    43.13 |      43.28 |    43.29 |
|       10000 |  104.9 ms |             95,290 |    50.28 |    84.72 |    91.51 |      91.65 |    91.66 |
|       25000 |  250.2 ms |             99,908 |   109.39 |   207.29 |   222.70 |     223.18 |   223.20 |
|       50000 |  446.9 ms |            111,878 |   236.98 |   379.15 |   408.14 |     409.43 |   409.51 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   24.5 ms |             40,818 |    12.47 |    20.54 |    23.12 |      23.46 |    23.46 |
|        5000 |   96.3 ms |             51,948 |    50.80 |    83.38 |    91.94 |      93.45 |    93.62 |
|       10000 |  204.8 ms |             48,825 |    99.71 |   177.70 |   198.03 |     199.57 |   199.77 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 190.6 MB
  • Settled Cooldown RSS   : 146.6 MB (Clean GC release)

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
| Yatta     |      46,361 |     1.00x |    10% | 2.01ms | 3.62ms | 4.24ms |
| Raw Bun   |      70,540 |     1.52x |    12% | 1.35ms | 2.30ms | 2.69ms |
| Hono      |      57,072 |     1.23x |    20% | 1.65ms | 3.16ms | 3.65ms |
| Elysia    |      68,031 |     1.47x |    11% | 1.43ms | 2.51ms | 2.83ms |
| Express   |      19,475 |     0.42x |     4% | 4.62ms | 8.67ms | 11.37ms |
| Fastify   |      27,350 |     0.59x |     4% | 3.38ms | 6.22ms | 7.46ms |
| Koa       |      20,499 |     0.44x |     2% | 4.57ms | 7.94ms | 8.87ms |

  Yatta dispatch adds about 7.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
