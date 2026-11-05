# Yatta Benchmarks

> Last run: `2026-11-05T03:05:57Z` · commit [`f9b1483`](https://github.com/psrockstar098/yatta.js/commit/f9b14839351fad59c9940375f8a8f5c1e08ba501) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 108.1 ms
  • End-to-End Runtime Task Cost    : 0.0401 ms/op
  • Peak RSS Memory        : 172.6 MB
  • RSS Heap Memory             : 80.38 MB
  • Raw Worker IPC Round-Trip      : 0.0318 ms/op
  • Scheduler + Graph Overhead     : 0.0083 ms/op
  • Settled Cooldown RSS   : 72.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      41,630 |     1.00x |    48% | 4.42ms | 4.85ms | 5.98ms |
| Raw Bun   |      43,059 |     1.03x |    13% | 2.42ms | 4.67ms | 5.19ms |
| Hono      |      47,183 |     1.13x |    35% | 1.94ms | 4.03ms | 4.75ms |
| Elysia    |      46,544 |     1.12x |     8% | 2.16ms | 4.28ms | 4.83ms |
| Express   |      15,415 |     0.37x |     6% | 5.66ms | 10.39ms | 11.68ms |
| Fastify   |      19,630 |     0.47x |    14% | 4.86ms | 8.02ms | 9.25ms |
| Koa       |      15,611 |     0.37x |     8% | 7.04ms | 10.04ms | 11.69ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,912 |       0.33 |       0.35 |       0.35 |       0.35 |
|         100 |     1.0 ms |              101,028 |       0.29 |       0.44 |       0.61 |       0.61 |
|         500 |     2.0 ms |              248,246 |       1.02 |       1.51 |       1.54 |       1.57 |
|        1000 |     3.7 ms |              266,711 |       1.90 |       2.80 |       2.82 |       2.82 |
|        5000 |    25.5 ms |              195,827 |      14.35 |      17.72 |      17.77 |      17.79 |
|       10000 |    42.5 ms |              235,291 |      22.09 |      32.85 |      33.41 |      33.42 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.4 ms |             96,458 |     4.88 |     6.79 |     8.66 |       9.04 |     9.04 |
|        5000 |   19.6 ms |            255,738 |     9.17 |    11.71 |    12.22 |      12.23 |    12.24 |
|       10000 |   45.8 ms |            218,262 |    20.06 |    34.26 |    36.41 |      36.77 |    36.81 |
|       25000 |  107.6 ms |            232,394 |    54.09 |    76.65 |    79.57 |      79.77 |    79.78 |
|       50000 |  193.0 ms |            259,049 |    94.99 |   149.26 |   162.95 |     163.46 |   163.47 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.4 ms |             64,744 |     6.90 |    12.00 |    13.29 |      13.61 |    13.61 |
|        5000 |   41.1 ms |            121,567 |    22.33 |    32.47 |    33.58 |      33.61 |    33.61 |
|       10000 |   84.0 ms |            119,000 |    42.40 |    71.38 |    73.89 |      73.94 |    73.95 |
|       25000 |  255.1 ms |             97,991 |   122.24 |   221.56 |   232.37 |     232.90 |   232.94 |
|       50000 |  472.4 ms |            105,850 |   220.96 |   398.53 |   433.66 |     434.81 |   435.27 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   29.0 ms |             34,426 |    18.16 |    24.52 |    25.90 |      26.11 |    26.11 |
|        5000 |  106.3 ms |             47,044 |    51.90 |    94.47 |   102.16 |     103.68 |   103.80 |
|       10000 |  204.6 ms |             48,869 |    99.26 |   176.04 |   196.81 |     200.42 |   200.76 |

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
  • Raw Worker IPC Round-Trip      : 0.0318 ms/op
  • End-to-End Runtime Task Cost    : 0.0401 ms/op
  • Scheduler + Graph Overhead     : 0.0083 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,912 |       0.33 |       0.35 |       0.35 |       0.35 |
|         100 |     1.0 ms |              101,028 |       0.29 |       0.44 |       0.61 |       0.61 |
|         500 |     2.0 ms |              248,246 |       1.02 |       1.51 |       1.54 |       1.57 |
|        1000 |     3.7 ms |              266,711 |       1.90 |       2.80 |       2.82 |       2.82 |
|        5000 |    25.5 ms |              195,827 |      14.35 |      17.72 |      17.77 |      17.79 |
|       10000 |    42.5 ms |              235,291 |      22.09 |      32.85 |      33.41 |      33.42 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.38 MB
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
| 1 CPU + 1 IO  |       2 |   56.0 ms |            178,459 |    24.63 |    42.99 |    43.36 |    43.53 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.2 ms |            231,532 |    23.23 |    32.95 |    33.09 |    33.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   36.4 ms |            274,932 |    18.61 |    29.00 |    29.39 |    29.70 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   39.9 ms |            250,445 |    21.07 |    31.40 |    31.50 |    31.64 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 108.1 ms
  • Peak Throughput Rate       : 231,224 ops/sec
  • Latency Distribution       : p50: 52.88ms | p90: 88.51ms | p99: 89.77ms | p99.9: 90.03ms | Max: 90.04ms
  • Memory (RSS)               : Baseline: 107.5 MB | Peak: 123.5 MB | Cooldown: 62.7 MB

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
|        1000 |   10.4 ms |             96,458 |     4.88 |     6.79 |     8.66 |       9.04 |     9.04 |
|        5000 |   19.6 ms |            255,738 |     9.17 |    11.71 |    12.22 |      12.23 |    12.24 |
|       10000 |   45.8 ms |            218,262 |    20.06 |    34.26 |    36.41 |      36.77 |    36.81 |
|       25000 |  107.6 ms |            232,394 |    54.09 |    76.65 |    79.57 |      79.77 |    79.78 |
|       50000 |  193.0 ms |            259,049 |    94.99 |   149.26 |   162.95 |     163.46 |   163.47 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.4 ms |             64,744 |     6.90 |    12.00 |    13.29 |      13.61 |    13.61 |
|        5000 |   41.1 ms |            121,567 |    22.33 |    32.47 |    33.58 |      33.61 |    33.61 |
|       10000 |   84.0 ms |            119,000 |    42.40 |    71.38 |    73.89 |      73.94 |    73.95 |
|       25000 |  255.1 ms |             97,991 |   122.24 |   221.56 |   232.37 |     232.90 |   232.94 |
|       50000 |  472.4 ms |            105,850 |   220.96 |   398.53 |   433.66 |     434.81 |   435.27 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   29.0 ms |             34,426 |    18.16 |    24.52 |    25.90 |      26.11 |    26.11 |
|        5000 |  106.3 ms |             47,044 |    51.90 |    94.47 |   102.16 |     103.68 |   103.80 |
|       10000 |  204.6 ms |             48,869 |    99.26 |   176.04 |   196.81 |     200.42 |   200.76 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 172.6 MB
  • Settled Cooldown RSS   : 72.1 MB (Clean GC release)

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
| Yatta     |      41,630 |     1.00x |    48% | 4.42ms | 4.85ms | 5.98ms |
| Raw Bun   |      43,059 |     1.03x |    13% | 2.42ms | 4.67ms | 5.19ms |
| Hono      |      47,183 |     1.13x |    35% | 1.94ms | 4.03ms | 4.75ms |
| Elysia    |      46,544 |     1.12x |     8% | 2.16ms | 4.28ms | 4.83ms |
| Express   |      15,415 |     0.37x |     6% | 5.66ms | 10.39ms | 11.68ms |
| Fastify   |      19,630 |     0.47x |    14% | 4.86ms | 8.02ms | 9.25ms |
| Koa       |      15,611 |     0.37x |     8% | 7.04ms | 10.04ms | 11.69ms |

  Yatta dispatch adds about 0.8µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 48%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
