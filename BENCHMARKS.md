# Yatta Benchmarks

> Last run: `2026-10-31T19:20:07Z` · commit [`8c7391d`](https://github.com/psrockstar098/yatta.js/commit/8c7391dbdc7871f8e46ea1aa3f77b7da0260bba0) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 103.4 ms
  • End-to-End Runtime Task Cost    : 0.0205 ms/op
  • Peak RSS Memory        : 110.8 MB
  • RSS Heap Memory             : 93.35 MB
  • Raw Worker IPC Round-Trip      : 0.0195 ms/op
  • Scheduler + Graph Overhead     : 0.0010 ms/op
  • Settled Cooldown RSS   : 71.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.63 MB
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
| Yatta     |      68,196 |     1.00x |    10% | 1.66ms | 2.34ms | 3.17ms |
| Raw Bun   |      60,496 |     0.89x |    21% | 1.52ms | 3.34ms | 3.54ms |
| Hono      |      60,827 |     0.89x |    25% | 1.67ms | 3.42ms | 4.39ms |
| Elysia    |      67,190 |     0.99x |    18% | 1.32ms | 2.75ms | 3.41ms |
| Express   |      31,969 |     0.47x |    18% | 3.26ms | 4.90ms | 6.71ms |
| Fastify   |      47,166 |     0.69x |     0% | 2.00ms | 3.72ms | 4.98ms |
| Koa       |      40,950 |     0.60x |     7% | 2.54ms | 4.56ms | 6.49ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               18,828 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.4 ms |              229,959 |       0.18 |       0.29 |       0.31 |       0.31 |
|         500 |     1.1 ms |              440,161 |       0.53 |       0.65 |       0.70 |       0.72 |
|        1000 |     1.8 ms |              549,760 |       0.90 |       1.32 |       1.37 |       1.40 |
|        5000 |    13.9 ms |              360,439 |       8.10 |       9.49 |      10.24 |      10.26 |
|       10000 |    23.5 ms |              426,330 |      12.08 |      17.59 |      17.78 |      17.80 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.7 ms |            213,620 |     1.98 |     2.79 |     3.61 |       3.80 |     3.80 |
|        5000 |   13.8 ms |            361,949 |     6.52 |     8.36 |     8.69 |       8.71 |     8.71 |
|       10000 |   33.1 ms |            302,056 |    16.59 |    26.07 |    26.65 |      26.65 |    26.65 |
|       25000 |   71.7 ms |            348,890 |    39.38 |    56.50 |    58.29 |      58.31 |    58.33 |
|       50000 |  132.0 ms |            378,647 |    67.02 |   104.78 |   112.09 |     112.65 |   112.66 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.1 ms |            124,103 |     3.96 |     5.94 |     6.95 |       7.04 |     7.04 |
|        5000 |   32.7 ms |            152,897 |    16.22 |    26.25 |    27.04 |      27.08 |    27.08 |
|       10000 |   59.2 ms |            168,932 |    31.87 |    49.16 |    50.67 |      50.77 |    50.77 |
|       25000 |  178.7 ms |            139,894 |    86.60 |   155.42 |   166.66 |     167.01 |   167.04 |
|       50000 |  370.5 ms |            134,964 |   170.77 |   318.73 |   346.10 |     346.94 |   347.00 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.9 ms |             52,930 |    10.39 |    15.84 |    17.56 |      17.76 |    17.76 |
|        5000 |   63.9 ms |             78,307 |    32.03 |    54.57 |    61.53 |      62.14 |    62.23 |
|       10000 |  145.2 ms |             68,859 |    65.68 |   127.15 |   138.56 |     140.24 |   140.43 |

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
  • Raw Worker IPC Round-Trip      : 0.0195 ms/op
  • End-to-End Runtime Task Cost    : 0.0205 ms/op
  • Scheduler + Graph Overhead     : 0.0010 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               18,828 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.4 ms |              229,959 |       0.18 |       0.29 |       0.31 |       0.31 |
|         500 |     1.1 ms |              440,161 |       0.53 |       0.65 |       0.70 |       0.72 |
|        1000 |     1.8 ms |              549,760 |       0.90 |       1.32 |       1.37 |       1.40 |
|        5000 |    13.9 ms |              360,439 |       8.10 |       9.49 |      10.24 |      10.26 |
|       10000 |    23.5 ms |              426,330 |      12.08 |      17.59 |      17.78 |      17.80 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.35 MB
  • V8/JSC Heap Used             : 13.63 MB

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
| 1 CPU + 1 IO  |       2 |   41.7 ms |            239,599 |    18.94 |    32.60 |    32.98 |    33.06 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   51.6 ms |            193,715 |    27.73 |    41.11 |    41.61 |    41.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   42.9 ms |            232,959 |    22.04 |    35.31 |    35.76 |    36.66 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   37.1 ms |            269,823 |    18.58 |    28.87 |    28.99 |    29.02 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 103.4 ms
  • Peak Throughput Rate       : 241,748 ops/sec
  • Latency Distribution       : p50: 59.10ms | p90: 83.14ms | p99: 83.72ms | p99.9: 84.02ms | Max: 84.03ms
  • Memory (RSS)               : Baseline: 95.7 MB | Peak: 128.0 MB | Cooldown: 99.4 MB

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
|        1000 |    4.7 ms |            213,620 |     1.98 |     2.79 |     3.61 |       3.80 |     3.80 |
|        5000 |   13.8 ms |            361,949 |     6.52 |     8.36 |     8.69 |       8.71 |     8.71 |
|       10000 |   33.1 ms |            302,056 |    16.59 |    26.07 |    26.65 |      26.65 |    26.65 |
|       25000 |   71.7 ms |            348,890 |    39.38 |    56.50 |    58.29 |      58.31 |    58.33 |
|       50000 |  132.0 ms |            378,647 |    67.02 |   104.78 |   112.09 |     112.65 |   112.66 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.1 ms |            124,103 |     3.96 |     5.94 |     6.95 |       7.04 |     7.04 |
|        5000 |   32.7 ms |            152,897 |    16.22 |    26.25 |    27.04 |      27.08 |    27.08 |
|       10000 |   59.2 ms |            168,932 |    31.87 |    49.16 |    50.67 |      50.77 |    50.77 |
|       25000 |  178.7 ms |            139,894 |    86.60 |   155.42 |   166.66 |     167.01 |   167.04 |
|       50000 |  370.5 ms |            134,964 |   170.77 |   318.73 |   346.10 |     346.94 |   347.00 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   18.9 ms |             52,930 |    10.39 |    15.84 |    17.56 |      17.76 |    17.76 |
|        5000 |   63.9 ms |             78,307 |    32.03 |    54.57 |    61.53 |      62.14 |    62.23 |
|       10000 |  145.2 ms |             68,859 |    65.68 |   127.15 |   138.56 |     140.24 |   140.43 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 110.8 MB
  • Settled Cooldown RSS   : 71.9 MB (Clean GC release)

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
| Yatta     |      68,196 |     1.00x |    10% | 1.66ms | 2.34ms | 3.17ms |
| Raw Bun   |      60,496 |     0.89x |    21% | 1.52ms | 3.34ms | 3.54ms |
| Hono      |      60,827 |     0.89x |    25% | 1.67ms | 3.42ms | 4.39ms |
| Elysia    |      67,190 |     0.99x |    18% | 1.32ms | 2.75ms | 3.41ms |
| Express   |      31,969 |     0.47x |    18% | 3.26ms | 4.90ms | 6.71ms |
| Fastify   |      47,166 |     0.69x |     0% | 2.00ms | 3.72ms | 4.98ms |
| Koa       |      40,950 |     0.60x |     7% | 2.54ms | 4.56ms | 6.49ms |

  Yatta dispatch adds about -1.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
