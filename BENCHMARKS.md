# Yatta Benchmarks

> Last run: `2026-10-18T10:03:21Z` · commit [`5a8fd00`](https://github.com/psrockstar098/yatta.js/commit/5a8fd00970eff7cbac5fd9cec5c2e4260cc574eb) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 64.5 ms
  • End-to-End Runtime Task Cost    : 0.0203 ms/op
  • Peak RSS Memory        : 211.9 MB
  • RSS Heap Memory             : 94.18 MB
  • Raw Worker IPC Round-Trip      : 0.0186 ms/op
  • Scheduler + Graph Overhead     : 0.0017 ms/op
  • Settled Cooldown RSS   : 73.6 MB (Clean GC release)
  • V8/JSC Heap Used             : 9.94 MB
  • Worker Fleet Event Loop Lag : 10.08 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      71,188 |     1.00x |    21% | 1.23ms | 2.67ms | 2.88ms |
| Raw Bun   |      56,853 |     0.80x |     9% | 1.49ms | 3.09ms | 3.17ms |
| Hono      |      57,945 |     0.81x |     6% | 1.53ms | 3.18ms | 3.24ms |
| Elysia    |      56,943 |     0.80x |     7% | 1.49ms | 3.11ms | 3.24ms |
| Express   |      48,004 |     0.67x |     3% | 2.01ms | 3.77ms | 5.84ms |
| Fastify   |      57,081 |     0.80x |     5% | 1.94ms | 2.63ms | 3.15ms |
| Koa       |      49,754 |     0.70x |     5% | 1.99ms | 3.47ms | 5.81ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               26,339 |       0.17 |       0.19 |       0.19 |       0.19 |
|         100 |     0.4 ms |              224,359 |       0.17 |       0.24 |       0.25 |       0.25 |
|         500 |     1.1 ms |              474,175 |       0.52 |       0.81 |       0.84 |       0.85 |
|        1000 |     2.3 ms |              440,466 |       1.03 |       1.43 |       1.48 |       1.50 |
|        5000 |    12.2 ms |              411,146 |       6.59 |       8.39 |       8.48 |       8.52 |
|       10000 |    21.3 ms |              468,793 |      11.07 |      16.43 |      16.55 |      16.57 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.8 ms |            206,619 |     2.06 |     2.77 |     3.37 |       3.42 |     3.42 |
|        5000 |   11.5 ms |            435,859 |     5.69 |     7.72 |     7.83 |       7.84 |     7.84 |
|       10000 |   24.0 ms |            417,023 |    11.70 |    17.83 |    18.43 |      18.45 |    18.45 |
|       25000 |   55.8 ms |            448,184 |    26.64 |    41.84 |    45.10 |      45.21 |    45.22 |
|       50000 |  111.1 ms |            450,118 |    56.54 |    87.04 |    92.88 |      93.18 |    93.19 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.2 ms |            161,059 |     2.97 |     4.54 |     5.30 |       5.56 |     5.56 |
|        5000 |   22.4 ms |            223,442 |    10.53 |    17.40 |    18.01 |      18.05 |    18.06 |
|       10000 |   49.0 ms |            204,285 |    26.02 |    41.79 |    43.76 |      43.82 |    43.82 |
|       25000 |  146.8 ms |            170,333 |    74.41 |   127.41 |   136.30 |     136.62 |   136.64 |
|       50000 |  301.8 ms |            165,661 |   163.16 |   255.41 |   278.67 |     279.11 |   279.32 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,015 |     8.00 |    13.02 |    14.40 |      14.60 |    14.60 |
|        5000 |   64.5 ms |             77,508 |    33.95 |    57.15 |    62.20 |      62.96 |    63.05 |
|       10000 |  145.7 ms |             68,626 |    76.09 |   130.03 |   141.82 |     143.41 |   143.59 |

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
  • Raw Worker IPC Round-Trip      : 0.0186 ms/op
  • End-to-End Runtime Task Cost    : 0.0203 ms/op
  • Scheduler + Graph Overhead     : 0.0017 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               26,339 |       0.17 |       0.19 |       0.19 |       0.19 |
|         100 |     0.4 ms |              224,359 |       0.17 |       0.24 |       0.25 |       0.25 |
|         500 |     1.1 ms |              474,175 |       0.52 |       0.81 |       0.84 |       0.85 |
|        1000 |     2.3 ms |              440,466 |       1.03 |       1.43 |       1.48 |       1.50 |
|        5000 |    12.2 ms |              411,146 |       6.59 |       8.39 |       8.48 |       8.52 |
|       10000 |    21.3 ms |              468,793 |      11.07 |      16.43 |      16.55 |      16.57 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.08 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 94.18 MB
  • V8/JSC Heap Used             : 9.94 MB

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
| 1 CPU + 1 IO  |       2 |   24.4 ms |            409,711 |    11.52 |    18.38 |    18.62 |    18.66 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   24.3 ms |            411,051 |    12.62 |    17.76 |    17.91 |    17.93 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   19.6 ms |            510,760 |     8.67 |    15.44 |    15.85 |    15.98 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   19.7 ms |            507,373 |     9.24 |    15.03 |    15.31 |    15.36 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 64.5 ms
  • Peak Throughput Rate       : 387,532 ops/sec
  • Latency Distribution       : p50: 29.90ms | p90: 49.88ms | p99: 50.90ms | p99.9: 51.04ms | Max: 51.06ms
  • Memory (RSS)               : Baseline: 101.7 MB | Peak: 129.4 MB | Cooldown: 101.7 MB

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
|        1000 |    4.8 ms |            206,619 |     2.06 |     2.77 |     3.37 |       3.42 |     3.42 |
|        5000 |   11.5 ms |            435,859 |     5.69 |     7.72 |     7.83 |       7.84 |     7.84 |
|       10000 |   24.0 ms |            417,023 |    11.70 |    17.83 |    18.43 |      18.45 |    18.45 |
|       25000 |   55.8 ms |            448,184 |    26.64 |    41.84 |    45.10 |      45.21 |    45.22 |
|       50000 |  111.1 ms |            450,118 |    56.54 |    87.04 |    92.88 |      93.18 |    93.19 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.2 ms |            161,059 |     2.97 |     4.54 |     5.30 |       5.56 |     5.56 |
|        5000 |   22.4 ms |            223,442 |    10.53 |    17.40 |    18.01 |      18.05 |    18.06 |
|       10000 |   49.0 ms |            204,285 |    26.02 |    41.79 |    43.76 |      43.82 |    43.82 |
|       25000 |  146.8 ms |            170,333 |    74.41 |   127.41 |   136.30 |     136.62 |   136.64 |
|       50000 |  301.8 ms |            165,661 |   163.16 |   255.41 |   278.67 |     279.11 |   279.32 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,015 |     8.00 |    13.02 |    14.40 |      14.60 |    14.60 |
|        5000 |   64.5 ms |             77,508 |    33.95 |    57.15 |    62.20 |      62.96 |    63.05 |
|       10000 |  145.7 ms |             68,626 |    76.09 |   130.03 |   141.82 |     143.41 |   143.59 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 211.9 MB
  • Settled Cooldown RSS   : 73.6 MB (Clean GC release)

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
| Yatta     |      71,188 |     1.00x |    21% | 1.23ms | 2.67ms | 2.88ms |
| Raw Bun   |      56,853 |     0.80x |     9% | 1.49ms | 3.09ms | 3.17ms |
| Hono      |      57,945 |     0.81x |     6% | 1.53ms | 3.18ms | 3.24ms |
| Elysia    |      56,943 |     0.80x |     7% | 1.49ms | 3.11ms | 3.24ms |
| Express   |      48,004 |     0.67x |     3% | 2.01ms | 3.77ms | 5.84ms |
| Fastify   |      57,081 |     0.80x |     5% | 1.94ms | 2.63ms | 3.15ms |
| Koa       |      49,754 |     0.70x |     5% | 1.99ms | 3.47ms | 5.81ms |

  Yatta dispatch adds about -3.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 21%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
