# Yatta Benchmarks

> Last run: `2026-11-01T14:47:20Z` · commit [`3e0e9dd`](https://github.com/psrockstar098/yatta.js/commit/3e0e9dd082cd0521faee18b05ed149686b466f86) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 88.0 ms
  • End-to-End Runtime Task Cost    : 0.0254 ms/op
  • Peak RSS Memory        : 149.3 MB
  • RSS Heap Memory             : 95.79 MB
  • Raw Worker IPC Round-Trip      : 0.0191 ms/op
  • Scheduler + Graph Overhead     : 0.0063 ms/op
  • Settled Cooldown RSS   : 73.5 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.44 MB
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      57,951 |     1.00x |     6% | 1.58ms | 3.23ms | 3.78ms |
| Raw Bun   |      48,263 |     0.83x |    16% | 1.86ms | 3.88ms | 4.10ms |
| Hono      |      50,082 |     0.86x |    17% | 1.72ms | 3.32ms | 3.87ms |
| Elysia    |      55,438 |     0.96x |    13% | 1.56ms | 3.28ms | 3.84ms |
| Express   |      26,901 |     0.46x |    10% | 3.90ms | 6.48ms | 8.27ms |
| Fastify   |      37,693 |     0.65x |     4% | 2.36ms | 4.39ms | 5.27ms |
| Koa       |      29,957 |     0.52x |     5% | 3.32ms | 6.03ms | 7.12ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,872 |       0.29 |       0.30 |       0.30 |       0.30 |
|         100 |     0.5 ms |              193,125 |       0.23 |       0.30 |       0.33 |       0.33 |
|         500 |     1.5 ms |              334,839 |       0.72 |       1.19 |       1.23 |       1.25 |
|        1000 |     3.2 ms |              314,946 |       1.63 |       2.59 |       2.66 |       2.68 |
|        5000 |    17.0 ms |              294,054 |       9.38 |      11.62 |      11.85 |      11.95 |
|       10000 |    31.2 ms |              320,978 |      15.67 |      24.03 |      24.43 |      24.45 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.3 ms |            158,509 |     2.76 |     3.74 |     4.80 |       5.06 |     5.06 |
|        5000 |   17.2 ms |            290,705 |     7.77 |    10.72 |    11.15 |      11.15 |    11.16 |
|       10000 |   35.1 ms |            285,178 |    17.73 |    27.20 |    27.69 |      28.09 |    28.10 |
|       25000 |   75.1 ms |            332,985 |    31.66 |    50.95 |    55.80 |      55.85 |    55.85 |
|       50000 |  147.8 ms |            338,393 |    74.91 |   115.71 |   125.39 |     125.52 |   125.53 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.9 ms |            112,581 |     4.36 |     6.62 |     7.64 |       7.76 |     7.76 |
|        5000 |   35.8 ms |            139,824 |    16.34 |    27.24 |    28.05 |      28.08 |    28.09 |
|       10000 |   73.8 ms |            135,565 |    35.47 |    60.72 |    62.29 |      62.32 |    62.32 |
|       25000 |  196.0 ms |            127,562 |    98.20 |   164.48 |   177.62 |     177.99 |   178.02 |
|       50000 |  327.1 ms |            152,878 |   164.35 |   280.78 |   302.56 |     303.39 |   303.40 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   21.4 ms |             46,668 |    11.72 |    18.03 |    20.42 |      20.65 |    20.65 |
|        5000 |   67.7 ms |             73,807 |    32.73 |    59.49 |    64.74 |      65.67 |    65.74 |
|       10000 |  155.3 ms |             64,383 |    68.26 |   135.03 |   148.42 |     150.95 |   151.16 |

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
  • Raw Worker IPC Round-Trip      : 0.0191 ms/op
  • End-to-End Runtime Task Cost    : 0.0254 ms/op
  • Scheduler + Graph Overhead     : 0.0063 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,872 |       0.29 |       0.30 |       0.30 |       0.30 |
|         100 |     0.5 ms |              193,125 |       0.23 |       0.30 |       0.33 |       0.33 |
|         500 |     1.5 ms |              334,839 |       0.72 |       1.19 |       1.23 |       1.25 |
|        1000 |     3.2 ms |              314,946 |       1.63 |       2.59 |       2.66 |       2.68 |
|        5000 |    17.0 ms |              294,054 |       9.38 |      11.62 |      11.85 |      11.95 |
|       10000 |    31.2 ms |              320,978 |      15.67 |      24.03 |      24.43 |      24.45 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 95.79 MB
  • V8/JSC Heap Used             : 13.44 MB

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
| 1 CPU + 1 IO  |       2 |   41.8 ms |            239,171 |    20.54 |    32.79 |    33.51 |    33.60 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   34.1 ms |            293,019 |    17.51 |    27.37 |    27.57 |    27.60 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   30.7 ms |            325,445 |    15.92 |    25.62 |    25.99 |    26.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   31.7 ms |            315,034 |    16.09 |    25.36 |    25.54 |    25.59 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 88.0 ms
  • Peak Throughput Rate       : 284,215 ops/sec
  • Latency Distribution       : p50: 46.50ms | p90: 72.04ms | p99: 72.46ms | p99.9: 72.47ms | Max: 72.48ms
  • Memory (RSS)               : Baseline: 98.5 MB | Peak: 136.2 MB | Cooldown: 103.4 MB

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
|        1000 |    6.3 ms |            158,509 |     2.76 |     3.74 |     4.80 |       5.06 |     5.06 |
|        5000 |   17.2 ms |            290,705 |     7.77 |    10.72 |    11.15 |      11.15 |    11.16 |
|       10000 |   35.1 ms |            285,178 |    17.73 |    27.20 |    27.69 |      28.09 |    28.10 |
|       25000 |   75.1 ms |            332,985 |    31.66 |    50.95 |    55.80 |      55.85 |    55.85 |
|       50000 |  147.8 ms |            338,393 |    74.91 |   115.71 |   125.39 |     125.52 |   125.53 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.9 ms |            112,581 |     4.36 |     6.62 |     7.64 |       7.76 |     7.76 |
|        5000 |   35.8 ms |            139,824 |    16.34 |    27.24 |    28.05 |      28.08 |    28.09 |
|       10000 |   73.8 ms |            135,565 |    35.47 |    60.72 |    62.29 |      62.32 |    62.32 |
|       25000 |  196.0 ms |            127,562 |    98.20 |   164.48 |   177.62 |     177.99 |   178.02 |
|       50000 |  327.1 ms |            152,878 |   164.35 |   280.78 |   302.56 |     303.39 |   303.40 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   21.4 ms |             46,668 |    11.72 |    18.03 |    20.42 |      20.65 |    20.65 |
|        5000 |   67.7 ms |             73,807 |    32.73 |    59.49 |    64.74 |      65.67 |    65.74 |
|       10000 |  155.3 ms |             64,383 |    68.26 |   135.03 |   148.42 |     150.95 |   151.16 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 149.3 MB
  • Settled Cooldown RSS   : 73.5 MB (Clean GC release)

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
| Yatta     |      57,951 |     1.00x |     6% | 1.58ms | 3.23ms | 3.78ms |
| Raw Bun   |      48,263 |     0.83x |    16% | 1.86ms | 3.88ms | 4.10ms |
| Hono      |      50,082 |     0.86x |    17% | 1.72ms | 3.32ms | 3.87ms |
| Elysia    |      55,438 |     0.96x |    13% | 1.56ms | 3.28ms | 3.84ms |
| Express   |      26,901 |     0.46x |    10% | 3.90ms | 6.48ms | 8.27ms |
| Fastify   |      37,693 |     0.65x |     4% | 2.36ms | 4.39ms | 5.27ms |
| Koa       |      29,957 |     0.52x |     5% | 3.32ms | 6.03ms | 7.12ms |

  Yatta dispatch adds about -3.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
