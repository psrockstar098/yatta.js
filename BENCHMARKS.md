# Yatta Benchmarks

> Last run: `2026-10-09T14:45:51Z` · commit [`ad72ef7`](https://github.com/psrockstar098/yatta.js/commit/ad72ef765d549e8902f9b4b9ebceedbd177db1b9) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 98.5 ms
  • End-to-End Runtime Task Cost    : 0.0472 ms/op
  • Peak RSS Memory        : 179.1 MB
  • RSS Heap Memory             : 78.82 MB
  • Raw Worker IPC Round-Trip      : 0.0390 ms/op
  • Scheduler + Graph Overhead     : 0.0082 ms/op
  • Settled Cooldown RSS   : 71.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.76 MB
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
| Yatta     |      40,816 |     1.00x |    16% | 2.56ms | 4.00ms | 5.26ms |
| Raw Bun   |      51,569 |     1.26x |    51% | 2.78ms | 5.73ms | 5.86ms |
| Hono      |      47,783 |     1.17x |     8% | 2.00ms | 3.54ms | 5.21ms |
| Elysia    |      46,355 |     1.14x |     7% | 2.05ms | 4.22ms | 4.80ms |
| Express   |      16,637 |     0.41x |    10% | 6.44ms | 10.44ms | 12.19ms |
| Fastify   |      21,456 |     0.53x |     6% | 4.34ms | 8.33ms | 11.41ms |
| Koa       |      16,765 |     0.41x |     9% | 5.45ms | 9.72ms | 10.56ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,517 |       0.38 |       0.40 |       0.40 |       0.40 |
|         100 |     1.1 ms |               87,310 |       0.30 |       0.73 |       0.75 |       0.75 |
|         500 |     1.8 ms |              280,091 |       0.88 |       1.34 |       1.41 |       1.45 |
|        1000 |     3.4 ms |              289,900 |       1.76 |       2.79 |       2.91 |       2.95 |
|        5000 |    20.7 ms |              241,620 |      11.06 |      14.34 |      14.59 |      14.64 |
|       10000 |    39.4 ms |              253,777 |      19.02 |      30.31 |      30.85 |      30.97 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,693 |     4.53 |     6.76 |     8.01 |       8.15 |     8.15 |
|        5000 |   23.9 ms |            209,526 |    11.00 |    15.09 |    15.61 |      15.62 |    15.63 |
|       10000 |   46.1 ms |            216,810 |    22.81 |    35.42 |    36.76 |      36.89 |    36.90 |
|       25000 |  103.4 ms |            241,852 |    51.89 |    73.45 |    77.14 |      77.44 |    77.46 |
|       50000 |  203.5 ms |            245,669 |   100.44 |   156.30 |   165.35 |     165.91 |   165.97 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.6 ms |             64,281 |     7.42 |     8.88 |     9.43 |       9.47 |     9.47 |
|        5000 |   56.3 ms |             88,779 |    28.58 |    43.74 |    44.91 |      44.96 |    44.97 |
|       10000 |   91.3 ms |            109,578 |    42.65 |    73.39 |    75.32 |      75.37 |    75.37 |
|       25000 |  243.2 ms |            102,779 |   125.56 |   210.02 |   220.19 |     220.93 |   220.95 |
|       50000 |  495.7 ms |            100,872 |   243.10 |   420.46 |   458.28 |     461.13 |   461.30 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.0 ms |             31,247 |    17.92 |    28.14 |    30.36 |      30.82 |    30.82 |
|        5000 |  136.1 ms |             36,745 |    62.69 |   121.63 |   132.36 |     133.38 |   133.47 |
|       10000 |  245.6 ms |             40,720 |   120.17 |   214.74 |   238.97 |     241.42 |   241.85 |

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
  • Raw Worker IPC Round-Trip      : 0.0390 ms/op
  • End-to-End Runtime Task Cost    : 0.0472 ms/op
  • Scheduler + Graph Overhead     : 0.0082 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,517 |       0.38 |       0.40 |       0.40 |       0.40 |
|         100 |     1.1 ms |               87,310 |       0.30 |       0.73 |       0.75 |       0.75 |
|         500 |     1.8 ms |              280,091 |       0.88 |       1.34 |       1.41 |       1.45 |
|        1000 |     3.4 ms |              289,900 |       1.76 |       2.79 |       2.91 |       2.95 |
|        5000 |    20.7 ms |              241,620 |      11.06 |      14.34 |      14.59 |      14.64 |
|       10000 |    39.4 ms |              253,777 |      19.02 |      30.31 |      30.85 |      30.97 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 78.82 MB
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
| 1 CPU + 1 IO  |       2 |   49.3 ms |            202,712 |    19.57 |    37.80 |    38.19 |    38.32 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   44.3 ms |            225,878 |    23.90 |    32.30 |    32.32 |    32.35 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   31.9 ms |            313,103 |    14.48 |    24.12 |    25.36 |    25.88 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   38.1 ms |            262,721 |    17.32 |    30.41 |    30.79 |    30.88 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 98.5 ms
  • Peak Throughput Rate       : 253,683 ops/sec
  • Latency Distribution       : p50: 47.35ms | p90: 78.71ms | p99: 79.94ms | p99.9: 80.28ms | Max: 80.32ms
  • Memory (RSS)               : Baseline: 104.4 MB | Peak: 130.8 MB | Cooldown: 103.7 MB

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
|        1000 |    9.5 ms |            105,693 |     4.53 |     6.76 |     8.01 |       8.15 |     8.15 |
|        5000 |   23.9 ms |            209,526 |    11.00 |    15.09 |    15.61 |      15.62 |    15.63 |
|       10000 |   46.1 ms |            216,810 |    22.81 |    35.42 |    36.76 |      36.89 |    36.90 |
|       25000 |  103.4 ms |            241,852 |    51.89 |    73.45 |    77.14 |      77.44 |    77.46 |
|       50000 |  203.5 ms |            245,669 |   100.44 |   156.30 |   165.35 |     165.91 |   165.97 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.6 ms |             64,281 |     7.42 |     8.88 |     9.43 |       9.47 |     9.47 |
|        5000 |   56.3 ms |             88,779 |    28.58 |    43.74 |    44.91 |      44.96 |    44.97 |
|       10000 |   91.3 ms |            109,578 |    42.65 |    73.39 |    75.32 |      75.37 |    75.37 |
|       25000 |  243.2 ms |            102,779 |   125.56 |   210.02 |   220.19 |     220.93 |   220.95 |
|       50000 |  495.7 ms |            100,872 |   243.10 |   420.46 |   458.28 |     461.13 |   461.30 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.0 ms |             31,247 |    17.92 |    28.14 |    30.36 |      30.82 |    30.82 |
|        5000 |  136.1 ms |             36,745 |    62.69 |   121.63 |   132.36 |     133.38 |   133.47 |
|       10000 |  245.6 ms |             40,720 |   120.17 |   214.74 |   238.97 |     241.42 |   241.85 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 179.1 MB
  • Settled Cooldown RSS   : 71.6 MB (Clean GC release)

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
| Yatta     |      40,816 |     1.00x |    16% | 2.56ms | 4.00ms | 5.26ms |
| Raw Bun   |      51,569 |     1.26x |    51% | 2.78ms | 5.73ms | 5.86ms |
| Hono      |      47,783 |     1.17x |     8% | 2.00ms | 3.54ms | 5.21ms |
| Elysia    |      46,355 |     1.14x |     7% | 2.05ms | 4.22ms | 4.80ms |
| Express   |      16,637 |     0.41x |    10% | 6.44ms | 10.44ms | 12.19ms |
| Fastify   |      21,456 |     0.53x |     6% | 4.34ms | 8.33ms | 11.41ms |
| Koa       |      16,765 |     0.41x |     9% | 5.45ms | 9.72ms | 10.56ms |

  Yatta dispatch adds about 5.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 16%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
