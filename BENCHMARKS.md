# Yatta Benchmarks

> Last run: `2026-10-25T16:37:37Z` · commit [`9883105`](https://github.com/psrockstar098/yatta.js/commit/9883105ccf6e98aec9422a65c860ecdd495264ac) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 98.8 ms
  • End-to-End Runtime Task Cost    : 0.0539 ms/op
  • Peak RSS Memory        : 170.8 MB
  • RSS Heap Memory             : 80.43 MB
  • Raw Worker IPC Round-Trip      : 0.0448 ms/op
  • Scheduler + Graph Overhead     : 0.0091 ms/op
  • Settled Cooldown RSS   : 108.1 MB (Clean GC release)
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
| Yatta     |      40,614 |     1.00x |    18% | 2.11ms | 4.03ms | 4.57ms |
| Raw Bun   |      47,171 |     1.16x |    30% | 1.77ms | 3.29ms | 4.49ms |
| Hono      |      40,739 |     1.00x |    17% | 2.36ms | 3.58ms | 4.07ms |
| Elysia    |      42,087 |     1.04x |    21% | 2.15ms | 3.70ms | 5.21ms |
| Express   |      15,096 |     0.37x |    11% | 6.78ms | 10.43ms | 11.34ms |
| Fastify   |      21,159 |     0.52x |     9% | 4.02ms | 8.14ms | 8.75ms |
| Koa       |      16,829 |     0.41x |     4% | 5.20ms | 10.38ms | 11.26ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,116 |       0.47 |       0.50 |       0.50 |       0.50 |
|         100 |     1.1 ms |               92,224 |       0.34 |       0.63 |       0.64 |       0.64 |
|         500 |     2.3 ms |              213,960 |       1.11 |       1.55 |       1.64 |       1.67 |
|        1000 |     3.7 ms |              270,811 |       1.86 |       2.77 |       2.92 |       2.97 |
|        5000 |    28.8 ms |              173,530 |      15.26 |      20.19 |      20.22 |      20.26 |
|       10000 |    47.3 ms |              211,628 |      27.36 |      39.16 |      39.23 |      39.29 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.1 ms |            123,767 |     3.42 |     5.11 |     6.65 |       7.03 |     7.03 |
|        5000 |   26.6 ms |            187,988 |    13.23 |    17.42 |    17.65 |      17.66 |    17.66 |
|       10000 |   46.7 ms |            213,908 |    23.56 |    36.83 |    37.41 |      37.45 |    37.45 |
|       25000 |  101.4 ms |            246,468 |    48.16 |    77.09 |    81.47 |      81.60 |    81.62 |
|       50000 |  186.4 ms |            268,295 |    92.92 |   148.03 |   157.57 |     158.11 |   158.13 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,669 |     6.08 |     9.38 |    10.96 |      11.38 |    11.38 |
|        5000 |   44.8 ms |            111,721 |    26.76 |    35.59 |    36.51 |      36.59 |    36.60 |
|       10000 |   76.1 ms |            131,463 |    35.40 |    63.70 |    65.56 |      65.62 |    65.63 |
|       25000 |  231.1 ms |            108,156 |   120.26 |   192.46 |   205.14 |     205.59 |   205.62 |
|       50000 |  434.3 ms |            115,121 |   236.59 |   372.18 |   397.55 |     398.51 |   398.57 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.7 ms |             27,216 |    20.59 |    31.46 |    33.73 |      34.02 |    34.02 |
|        5000 |  138.3 ms |             36,145 |    64.14 |   124.19 |   135.00 |     136.04 |   136.20 |
|       10000 |  257.5 ms |             38,842 |   127.71 |   226.43 |   250.93 |     252.94 |   253.21 |

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
  • Raw Worker IPC Round-Trip      : 0.0448 ms/op
  • End-to-End Runtime Task Cost    : 0.0539 ms/op
  • Scheduler + Graph Overhead     : 0.0091 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,116 |       0.47 |       0.50 |       0.50 |       0.50 |
|         100 |     1.1 ms |               92,224 |       0.34 |       0.63 |       0.64 |       0.64 |
|         500 |     2.3 ms |              213,960 |       1.11 |       1.55 |       1.64 |       1.67 |
|        1000 |     3.7 ms |              270,811 |       1.86 |       2.77 |       2.92 |       2.97 |
|        5000 |    28.8 ms |              173,530 |      15.26 |      20.19 |      20.22 |      20.26 |
|       10000 |    47.3 ms |              211,628 |      27.36 |      39.16 |      39.23 |      39.29 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.43 MB
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
| 1 CPU + 1 IO  |       2 |   45.6 ms |            219,532 |    21.73 |    34.44 |    34.88 |    34.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   42.7 ms |            234,055 |    24.49 |    33.09 |    33.30 |    33.32 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.3 ms |            283,230 |    16.99 |    28.17 |    28.62 |    28.76 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   44.1 ms |            226,569 |    22.22 |    35.10 |    35.19 |    35.20 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 98.8 ms
  • Peak Throughput Rate       : 252,917 ops/sec
  • Latency Distribution       : p50: 47.87ms | p90: 78.29ms | p99: 79.85ms | p99.9: 79.91ms | Max: 79.92ms
  • Memory (RSS)               : Baseline: 95.1 MB | Peak: 128.2 MB | Cooldown: 101.5 MB

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
|        1000 |    8.1 ms |            123,767 |     3.42 |     5.11 |     6.65 |       7.03 |     7.03 |
|        5000 |   26.6 ms |            187,988 |    13.23 |    17.42 |    17.65 |      17.66 |    17.66 |
|       10000 |   46.7 ms |            213,908 |    23.56 |    36.83 |    37.41 |      37.45 |    37.45 |
|       25000 |  101.4 ms |            246,468 |    48.16 |    77.09 |    81.47 |      81.60 |    81.62 |
|       50000 |  186.4 ms |            268,295 |    92.92 |   148.03 |   157.57 |     158.11 |   158.13 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,669 |     6.08 |     9.38 |    10.96 |      11.38 |    11.38 |
|        5000 |   44.8 ms |            111,721 |    26.76 |    35.59 |    36.51 |      36.59 |    36.60 |
|       10000 |   76.1 ms |            131,463 |    35.40 |    63.70 |    65.56 |      65.62 |    65.63 |
|       25000 |  231.1 ms |            108,156 |   120.26 |   192.46 |   205.14 |     205.59 |   205.62 |
|       50000 |  434.3 ms |            115,121 |   236.59 |   372.18 |   397.55 |     398.51 |   398.57 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.7 ms |             27,216 |    20.59 |    31.46 |    33.73 |      34.02 |    34.02 |
|        5000 |  138.3 ms |             36,145 |    64.14 |   124.19 |   135.00 |     136.04 |   136.20 |
|       10000 |  257.5 ms |             38,842 |   127.71 |   226.43 |   250.93 |     252.94 |   253.21 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 170.8 MB
  • Settled Cooldown RSS   : 108.1 MB (Clean GC release)

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
| Yatta     |      40,614 |     1.00x |    18% | 2.11ms | 4.03ms | 4.57ms |
| Raw Bun   |      47,171 |     1.16x |    30% | 1.77ms | 3.29ms | 4.49ms |
| Hono      |      40,739 |     1.00x |    17% | 2.36ms | 3.58ms | 4.07ms |
| Elysia    |      42,087 |     1.04x |    21% | 2.15ms | 3.70ms | 5.21ms |
| Express   |      15,096 |     0.37x |    11% | 6.78ms | 10.43ms | 11.34ms |
| Fastify   |      21,159 |     0.52x |     9% | 4.02ms | 8.14ms | 8.75ms |
| Koa       |      16,829 |     0.41x |     4% | 5.20ms | 10.38ms | 11.26ms |

  Yatta dispatch adds about 3.4µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 18%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
