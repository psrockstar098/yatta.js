# Yatta Benchmarks

> Last run: `2026-11-05T04:30:47Z` · commit [`ae13eec`](https://github.com/psrockstar098/yatta.js/commit/ae13eec14f25772f2f2a0fea84897d7b554492d4) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 118.1 ms
  • End-to-End Runtime Task Cost    : 0.0417 ms/op
  • Peak RSS Memory        : 120.3 MB
  • RSS Heap Memory             : 80.25 MB
  • Raw Worker IPC Round-Trip      : 0.0308 ms/op
  • Scheduler + Graph Overhead     : 0.0109 ms/op
  • Settled Cooldown RSS   : 90.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
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
| Yatta     |      40,049 |     1.00x |    34% | 3.91ms | 4.95ms | 5.51ms |
| Raw Bun   |      46,495 |     1.16x |     7% | 1.85ms | 4.62ms | 4.85ms |
| Hono      |      47,202 |     1.18x |    17% | 1.96ms | 3.39ms | 3.96ms |
| Elysia    |      45,687 |     1.14x |     6% | 2.24ms | 4.23ms | 5.40ms |
| Express   |      13,784 |     0.34x |     5% | 6.71ms | 11.13ms | 13.16ms |
| Fastify   |      19,325 |     0.48x |     2% | 4.35ms | 8.37ms | 9.02ms |
| Koa       |      14,816 |     0.37x |    15% | 7.62ms | 10.68ms | 12.50ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,356 |       0.36 |       0.41 |       0.41 |       0.41 |
|         100 |     1.3 ms |               75,010 |       0.36 |       0.92 |       0.93 |       0.93 |
|         500 |     2.3 ms |              213,479 |       1.28 |       1.93 |       2.01 |       2.05 |
|        1000 |     4.3 ms |              235,052 |       2.17 |       3.43 |       3.64 |       3.71 |
|        5000 |    27.1 ms |              184,464 |      13.70 |      19.56 |      19.59 |      19.60 |
|       10000 |    57.0 ms |              175,485 |      27.28 |      45.47 |      46.45 |      46.73 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.6 ms |            116,935 |     3.99 |     5.76 |     6.72 |       7.08 |     7.08 |
|        5000 |   29.2 ms |            171,242 |    12.92 |    17.89 |    18.39 |      18.44 |    18.44 |
|       10000 |   55.0 ms |            181,753 |    27.12 |    42.70 |    44.42 |      44.44 |    44.45 |
|       25000 |  121.6 ms |            205,577 |    63.94 |    91.02 |    95.32 |      95.57 |    95.57 |
|       50000 |  213.9 ms |            233,745 |   108.25 |   166.83 |   172.85 |     173.16 |   173.18 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.4 ms |             69,527 |     7.29 |    11.11 |    12.87 |      13.21 |    13.21 |
|        5000 |   52.0 ms |             96,145 |    24.17 |    40.21 |    41.21 |      41.27 |    41.27 |
|       10000 |   93.0 ms |            107,562 |    45.69 |    66.92 |    69.02 |      69.17 |    69.18 |
|       25000 |  239.5 ms |            104,383 |   131.75 |   207.90 |   218.90 |     219.55 |   219.60 |
|       50000 |  543.0 ms |             92,079 |   263.82 |   465.65 |   504.38 |     505.69 |   505.78 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.3 ms |             38,093 |    14.36 |    23.16 |    24.81 |      25.19 |    25.19 |
|        5000 |  120.9 ms |             41,358 |    58.19 |    94.51 |   113.10 |     114.68 |   114.84 |
|       10000 |  222.8 ms |             44,877 |   104.65 |   180.41 |   212.32 |     215.40 |   215.77 |

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
  • Raw Worker IPC Round-Trip      : 0.0308 ms/op
  • End-to-End Runtime Task Cost    : 0.0417 ms/op
  • Scheduler + Graph Overhead     : 0.0109 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,356 |       0.36 |       0.41 |       0.41 |       0.41 |
|         100 |     1.3 ms |               75,010 |       0.36 |       0.92 |       0.93 |       0.93 |
|         500 |     2.3 ms |              213,479 |       1.28 |       1.93 |       2.01 |       2.05 |
|        1000 |     4.3 ms |              235,052 |       2.17 |       3.43 |       3.64 |       3.71 |
|        5000 |    27.1 ms |              184,464 |      13.70 |      19.56 |      19.59 |      19.60 |
|       10000 |    57.0 ms |              175,485 |      27.28 |      45.47 |      46.45 |      46.73 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.25 MB
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
| 1 CPU + 1 IO  |       2 |   71.1 ms |            140,608 |    31.96 |    57.95 |    58.81 |    59.75 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   56.1 ms |            178,289 |    27.27 |    43.96 |    43.98 |    44.04 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   39.2 ms |            255,102 |    18.91 |    31.70 |    32.88 |    33.54 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   47.8 ms |            209,305 |    24.18 |    38.39 |    38.58 |    38.65 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 118.1 ms
  • Peak Throughput Rate       : 211,597 ops/sec
  • Latency Distribution       : p50: 59.38ms | p90: 99.74ms | p99: 100.87ms | p99.9: 101.24ms | Max: 101.31ms
  • Memory (RSS)               : Baseline: 101.7 MB | Peak: 129.1 MB | Cooldown: 100.5 MB

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
|        1000 |    8.6 ms |            116,935 |     3.99 |     5.76 |     6.72 |       7.08 |     7.08 |
|        5000 |   29.2 ms |            171,242 |    12.92 |    17.89 |    18.39 |      18.44 |    18.44 |
|       10000 |   55.0 ms |            181,753 |    27.12 |    42.70 |    44.42 |      44.44 |    44.45 |
|       25000 |  121.6 ms |            205,577 |    63.94 |    91.02 |    95.32 |      95.57 |    95.57 |
|       50000 |  213.9 ms |            233,745 |   108.25 |   166.83 |   172.85 |     173.16 |   173.18 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.4 ms |             69,527 |     7.29 |    11.11 |    12.87 |      13.21 |    13.21 |
|        5000 |   52.0 ms |             96,145 |    24.17 |    40.21 |    41.21 |      41.27 |    41.27 |
|       10000 |   93.0 ms |            107,562 |    45.69 |    66.92 |    69.02 |      69.17 |    69.18 |
|       25000 |  239.5 ms |            104,383 |   131.75 |   207.90 |   218.90 |     219.55 |   219.60 |
|       50000 |  543.0 ms |             92,079 |   263.82 |   465.65 |   504.38 |     505.69 |   505.78 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.3 ms |             38,093 |    14.36 |    23.16 |    24.81 |      25.19 |    25.19 |
|        5000 |  120.9 ms |             41,358 |    58.19 |    94.51 |   113.10 |     114.68 |   114.84 |
|       10000 |  222.8 ms |             44,877 |   104.65 |   180.41 |   212.32 |     215.40 |   215.77 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 120.3 MB
  • Settled Cooldown RSS   : 90.8 MB (Clean GC release)

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
| Yatta     |      40,049 |     1.00x |    34% | 3.91ms | 4.95ms | 5.51ms |
| Raw Bun   |      46,495 |     1.16x |     7% | 1.85ms | 4.62ms | 4.85ms |
| Hono      |      47,202 |     1.18x |    17% | 1.96ms | 3.39ms | 3.96ms |
| Elysia    |      45,687 |     1.14x |     6% | 2.24ms | 4.23ms | 5.40ms |
| Express   |      13,784 |     0.34x |     5% | 6.71ms | 11.13ms | 13.16ms |
| Fastify   |      19,325 |     0.48x |     2% | 4.35ms | 8.37ms | 9.02ms |
| Koa       |      14,816 |     0.37x |    15% | 7.62ms | 10.68ms | 12.50ms |

  Yatta dispatch adds about 3.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 34%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
