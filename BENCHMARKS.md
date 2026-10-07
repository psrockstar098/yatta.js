# Yatta Benchmarks

> Last run: `2026-10-07T18:07:09Z` · commit [`4b65716`](https://github.com/psrockstar098/yatta.js/commit/4b6571619d5133971f9cfc122e05f0759c762bd2) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 114.8 ms
  • End-to-End Runtime Task Cost    : 0.0512 ms/op
  • Peak RSS Memory        : 211.1 MB
  • RSS Heap Memory             : 80.95 MB
  • Raw Worker IPC Round-Trip      : 0.0414 ms/op
  • Scheduler + Graph Overhead     : 0.0098 ms/op
  • Settled Cooldown RSS   : 166.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
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
| Yatta     |      37,275 |     1.00x |    18% | 2.28ms | 4.44ms | 5.04ms |
| Raw Bun   |      45,698 |     1.23x |     8% | 2.41ms | 4.72ms | 5.25ms |
| Hono      |      47,998 |     1.29x |    23% | 1.96ms | 3.31ms | 4.13ms |
| Elysia    |      47,747 |     1.28x |    14% | 2.23ms | 3.00ms | 4.10ms |
| Express   |      14,714 |     0.39x |     6% | 6.10ms | 10.83ms | 11.71ms |
| Fastify   |      19,056 |     0.51x |    16% | 5.76ms | 9.17ms | 11.55ms |
| Koa       |      15,090 |     0.40x |     5% | 5.84ms | 11.03ms | 12.56ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,387 |       0.36 |       0.42 |       0.42 |       0.42 |
|         100 |     1.8 ms |               55,490 |       0.53 |       1.11 |       1.17 |       1.17 |
|         500 |     2.7 ms |              183,813 |       1.32 |       1.69 |       1.71 |       1.73 |
|        1000 |     5.3 ms |              187,360 |       2.50 |       4.20 |       4.27 |       4.32 |
|        5000 |    29.7 ms |              168,319 |      16.75 |      19.55 |      21.37 |      21.43 |
|       10000 |    52.4 ms |              190,935 |      25.04 |      42.90 |      43.11 |      43.32 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.6 ms |            104,646 |     3.93 |     6.21 |     8.02 |       8.37 |     8.37 |
|        5000 |   23.5 ms |            212,911 |    11.22 |    15.69 |    16.23 |      16.25 |    16.25 |
|       10000 |   50.4 ms |            198,348 |    24.19 |    38.18 |    40.30 |      40.35 |    40.35 |
|       25000 |  107.1 ms |            233,447 |    53.38 |    80.81 |    86.87 |      87.07 |    87.08 |
|       50000 |  221.3 ms |            225,966 |   112.23 |   176.39 |   187.65 |     187.77 |   187.77 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.9 ms |             77,612 |     6.44 |     9.47 |    11.03 |      11.21 |    11.21 |
|        5000 |   49.4 ms |            101,118 |    24.28 |    37.63 |    38.66 |      38.72 |    38.72 |
|       10000 |  104.5 ms |             95,738 |    52.09 |    87.96 |    91.19 |      91.39 |    91.41 |
|       25000 |  245.5 ms |            101,845 |   119.18 |   209.10 |   227.11 |     227.58 |   227.60 |
|       50000 |  493.0 ms |            101,415 |   250.05 |   421.41 |   451.96 |     452.97 |   453.05 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.1 ms |             31,131 |    17.44 |    28.46 |    30.94 |      31.17 |    31.17 |
|        5000 |  129.9 ms |             38,499 |    66.49 |   115.53 |   126.02 |     127.66 |   127.86 |
|       10000 |  276.5 ms |             36,162 |   133.74 |   241.91 |   267.06 |     269.23 |   269.42 |

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
  • Raw Worker IPC Round-Trip      : 0.0414 ms/op
  • End-to-End Runtime Task Cost    : 0.0512 ms/op
  • Scheduler + Graph Overhead     : 0.0098 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,387 |       0.36 |       0.42 |       0.42 |       0.42 |
|         100 |     1.8 ms |               55,490 |       0.53 |       1.11 |       1.17 |       1.17 |
|         500 |     2.7 ms |              183,813 |       1.32 |       1.69 |       1.71 |       1.73 |
|        1000 |     5.3 ms |              187,360 |       2.50 |       4.20 |       4.27 |       4.32 |
|        5000 |    29.7 ms |              168,319 |      16.75 |      19.55 |      21.37 |      21.43 |
|       10000 |    52.4 ms |              190,935 |      25.04 |      42.90 |      43.11 |      43.32 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.95 MB
  • V8/JSC Heap Used             : 0.75 MB

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
| 1 CPU + 1 IO  |       2 |   57.0 ms |            175,391 |    27.29 |    44.24 |    44.64 |    44.76 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.7 ms |            228,578 |    23.81 |    31.62 |    31.69 |    31.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.5 ms |            281,389 |    18.54 |    27.04 |    27.57 |    27.69 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   41.5 ms |            240,831 |    20.12 |    32.33 |    32.58 |    32.61 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 114.8 ms
  • Peak Throughput Rate       : 217,720 ops/sec
  • Latency Distribution       : p50: 56.70ms | p90: 93.87ms | p99: 96.70ms | p99.9: 96.81ms | Max: 96.85ms
  • Memory (RSS)               : Baseline: 110.7 MB | Peak: 129.9 MB | Cooldown: 103.1 MB

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
|        1000 |    9.6 ms |            104,646 |     3.93 |     6.21 |     8.02 |       8.37 |     8.37 |
|        5000 |   23.5 ms |            212,911 |    11.22 |    15.69 |    16.23 |      16.25 |    16.25 |
|       10000 |   50.4 ms |            198,348 |    24.19 |    38.18 |    40.30 |      40.35 |    40.35 |
|       25000 |  107.1 ms |            233,447 |    53.38 |    80.81 |    86.87 |      87.07 |    87.08 |
|       50000 |  221.3 ms |            225,966 |   112.23 |   176.39 |   187.65 |     187.77 |   187.77 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.9 ms |             77,612 |     6.44 |     9.47 |    11.03 |      11.21 |    11.21 |
|        5000 |   49.4 ms |            101,118 |    24.28 |    37.63 |    38.66 |      38.72 |    38.72 |
|       10000 |  104.5 ms |             95,738 |    52.09 |    87.96 |    91.19 |      91.39 |    91.41 |
|       25000 |  245.5 ms |            101,845 |   119.18 |   209.10 |   227.11 |     227.58 |   227.60 |
|       50000 |  493.0 ms |            101,415 |   250.05 |   421.41 |   451.96 |     452.97 |   453.05 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.1 ms |             31,131 |    17.44 |    28.46 |    30.94 |      31.17 |    31.17 |
|        5000 |  129.9 ms |             38,499 |    66.49 |   115.53 |   126.02 |     127.66 |   127.86 |
|       10000 |  276.5 ms |             36,162 |   133.74 |   241.91 |   267.06 |     269.23 |   269.42 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 211.1 MB
  • Settled Cooldown RSS   : 166.0 MB (Clean GC release)

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
| Yatta     |      37,275 |     1.00x |    18% | 2.28ms | 4.44ms | 5.04ms |
| Raw Bun   |      45,698 |     1.23x |     8% | 2.41ms | 4.72ms | 5.25ms |
| Hono      |      47,998 |     1.29x |    23% | 1.96ms | 3.31ms | 4.13ms |
| Elysia    |      47,747 |     1.28x |    14% | 2.23ms | 3.00ms | 4.10ms |
| Express   |      14,714 |     0.39x |     6% | 6.10ms | 10.83ms | 11.71ms |
| Fastify   |      19,056 |     0.51x |    16% | 5.76ms | 9.17ms | 11.55ms |
| Koa       |      15,090 |     0.40x |     5% | 5.84ms | 11.03ms | 12.56ms |

  Yatta dispatch adds about 4.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 18%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
