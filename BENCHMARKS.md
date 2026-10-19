# Yatta Benchmarks

> Last run: `2026-10-19T13:47:53Z` · commit [`ab647c5`](https://github.com/psrockstar098/yatta.js/commit/ab647c50f5063f25516f7d0da2a81b0c584c3ba0) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 118.9 ms
  • End-to-End Runtime Task Cost    : 0.0522 ms/op
  • Peak RSS Memory        : 124.0 MB
  • RSS Heap Memory             : 56.57 MB
  • Raw Worker IPC Round-Trip      : 0.0416 ms/op
  • Scheduler + Graph Overhead     : 0.0106 ms/op
  • Settled Cooldown RSS   : 71.7 MB (Clean GC release)
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
| Yatta     |      35,482 |     1.00x |    14% | 2.18ms | 4.33ms | 4.96ms |
| Raw Bun   |      48,443 |     1.37x |    17% | 2.04ms | 3.27ms | 4.74ms |
| Hono      |      42,211 |     1.19x |     6% | 1.93ms | 3.58ms | 3.92ms |
| Elysia    |      44,933 |     1.27x |     3% | 2.10ms | 4.86ms | 5.04ms |
| Express   |      15,943 |     0.45x |     8% | 5.72ms | 10.47ms | 11.62ms |
| Fastify   |      21,185 |     0.60x |    10% | 4.08ms | 8.22ms | 10.19ms |
| Koa       |      16,260 |     0.46x |     3% | 5.86ms | 10.14ms | 10.88ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,212 |       0.36 |       0.43 |       0.43 |       0.43 |
|         100 |     1.2 ms |               85,806 |       0.36 |       0.63 |       0.67 |       0.67 |
|         500 |     2.7 ms |              184,613 |       1.29 |       2.05 |       2.10 |       2.12 |
|        1000 |     5.4 ms |              183,691 |       2.83 |       4.19 |       4.28 |       4.32 |
|        5000 |    26.7 ms |              187,507 |      16.04 |      19.09 |      19.14 |      19.20 |
|       10000 |    45.2 ms |              221,182 |      23.21 |      33.51 |      34.21 |      34.44 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.0 ms |            111,029 |     3.87 |     5.66 |     6.86 |       6.95 |     6.95 |
|        5000 |   22.6 ms |            220,909 |    10.64 |    14.28 |    14.81 |      14.82 |    14.82 |
|       10000 |   53.9 ms |            185,417 |    27.32 |    41.04 |    43.24 |      43.28 |    43.29 |
|       25000 |  114.2 ms |            218,873 |    58.27 |    83.23 |    89.16 |      89.26 |    89.27 |
|       50000 |  212.3 ms |            235,565 |   119.03 |   170.64 |   177.89 |     178.35 |   178.39 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.2 ms |             61,763 |     9.40 |    12.69 |    14.74 |      14.90 |    14.90 |
|        5000 |   49.5 ms |            100,992 |    23.63 |    38.79 |    39.94 |      40.00 |    40.01 |
|       10000 |  112.2 ms |             89,166 |    57.66 |    93.79 |    97.37 |      97.46 |    97.46 |
|       25000 |  266.0 ms |             93,995 |   146.38 |   230.40 |   243.63 |     243.70 |   243.71 |
|       50000 |  449.0 ms |            111,359 |   213.21 |   374.24 |   409.96 |     410.97 |   411.05 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.3 ms |             30,004 |    17.75 |    28.00 |    30.35 |      30.72 |    30.72 |
|        5000 |  146.2 ms |             34,191 |    79.24 |   131.56 |   143.18 |     144.38 |   144.54 |
|       10000 |  281.6 ms |             35,513 |   145.06 |   247.69 |   272.03 |     275.48 |   275.95 |

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
  • Raw Worker IPC Round-Trip      : 0.0416 ms/op
  • End-to-End Runtime Task Cost    : 0.0522 ms/op
  • Scheduler + Graph Overhead     : 0.0106 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,212 |       0.36 |       0.43 |       0.43 |       0.43 |
|         100 |     1.2 ms |               85,806 |       0.36 |       0.63 |       0.67 |       0.67 |
|         500 |     2.7 ms |              184,613 |       1.29 |       2.05 |       2.10 |       2.12 |
|        1000 |     5.4 ms |              183,691 |       2.83 |       4.19 |       4.28 |       4.32 |
|        5000 |    26.7 ms |              187,507 |      16.04 |      19.09 |      19.14 |      19.20 |
|       10000 |    45.2 ms |              221,182 |      23.21 |      33.51 |      34.21 |      34.44 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 56.57 MB
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
| 1 CPU + 1 IO  |       2 |   62.5 ms |            160,102 |    25.58 |    46.02 |    49.21 |    49.23 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   52.8 ms |            189,526 |    28.97 |    40.54 |    40.85 |    40.85 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   48.0 ms |            208,130 |    23.51 |    39.07 |    39.94 |    40.15 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.7 ms |            245,641 |    20.89 |    31.94 |    32.15 |    32.17 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 118.9 ms
  • Peak Throughput Rate       : 210,339 ops/sec
  • Latency Distribution       : p50: 54.60ms | p90: 93.32ms | p99: 96.73ms | p99.9: 97.22ms | Max: 97.27ms
  • Memory (RSS)               : Baseline: 96.7 MB | Peak: 129.8 MB | Cooldown: 102.0 MB

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
|        1000 |    9.0 ms |            111,029 |     3.87 |     5.66 |     6.86 |       6.95 |     6.95 |
|        5000 |   22.6 ms |            220,909 |    10.64 |    14.28 |    14.81 |      14.82 |    14.82 |
|       10000 |   53.9 ms |            185,417 |    27.32 |    41.04 |    43.24 |      43.28 |    43.29 |
|       25000 |  114.2 ms |            218,873 |    58.27 |    83.23 |    89.16 |      89.26 |    89.27 |
|       50000 |  212.3 ms |            235,565 |   119.03 |   170.64 |   177.89 |     178.35 |   178.39 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.2 ms |             61,763 |     9.40 |    12.69 |    14.74 |      14.90 |    14.90 |
|        5000 |   49.5 ms |            100,992 |    23.63 |    38.79 |    39.94 |      40.00 |    40.01 |
|       10000 |  112.2 ms |             89,166 |    57.66 |    93.79 |    97.37 |      97.46 |    97.46 |
|       25000 |  266.0 ms |             93,995 |   146.38 |   230.40 |   243.63 |     243.70 |   243.71 |
|       50000 |  449.0 ms |            111,359 |   213.21 |   374.24 |   409.96 |     410.97 |   411.05 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.3 ms |             30,004 |    17.75 |    28.00 |    30.35 |      30.72 |    30.72 |
|        5000 |  146.2 ms |             34,191 |    79.24 |   131.56 |   143.18 |     144.38 |   144.54 |
|       10000 |  281.6 ms |             35,513 |   145.06 |   247.69 |   272.03 |     275.48 |   275.95 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 124.0 MB
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
| Yatta     |      35,482 |     1.00x |    14% | 2.18ms | 4.33ms | 4.96ms |
| Raw Bun   |      48,443 |     1.37x |    17% | 2.04ms | 3.27ms | 4.74ms |
| Hono      |      42,211 |     1.19x |     6% | 1.93ms | 3.58ms | 3.92ms |
| Elysia    |      44,933 |     1.27x |     3% | 2.10ms | 4.86ms | 5.04ms |
| Express   |      15,943 |     0.45x |     8% | 5.72ms | 10.47ms | 11.62ms |
| Fastify   |      21,185 |     0.60x |    10% | 4.08ms | 8.22ms | 10.19ms |
| Koa       |      16,260 |     0.46x |     3% | 5.86ms | 10.14ms | 10.88ms |

  Yatta dispatch adds about 7.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
