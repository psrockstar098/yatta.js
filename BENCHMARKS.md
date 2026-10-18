# Yatta Benchmarks

> Last run: `2026-10-18T01:26:34Z` · commit [`8fdfc35`](https://github.com/psrockstar098/yatta.js/commit/8fdfc35c3f8ac6d3d4d3534a67acd083d128aedf) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 65.1 ms
  • End-to-End Runtime Task Cost    : 0.0233 ms/op
  • Peak RSS Memory        : 222.9 MB
  • RSS Heap Memory             : 94.11 MB
  • Raw Worker IPC Round-Trip      : 0.0194 ms/op
  • Scheduler + Graph Overhead     : 0.0039 ms/op
  • Settled Cooldown RSS   : 77.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.42 MB
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
| Yatta     |      67,155 |     1.00x |     5% | 1.32ms | 3.10ms | 3.62ms |
| Raw Bun   |      53,685 |     0.80x |     6% | 1.62ms | 3.39ms | 3.51ms |
| Hono      |      65,779 |     0.98x |    26% | 1.24ms | 1.91ms | 2.90ms |
| Elysia    |      60,494 |     0.90x |    34% | 1.60ms | 3.28ms | 3.77ms |
| Express   |      35,547 |     0.53x |     6% | 2.85ms | 5.41ms | 7.14ms |
| Fastify   |      48,052 |     0.72x |     6% | 2.18ms | 3.22ms | 4.67ms |
| Koa       |      42,359 |     0.63x |     7% | 2.40ms | 4.43ms | 6.46ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,774 |       0.27 |       0.29 |       0.29 |       0.29 |
|         100 |     0.5 ms |              189,355 |       0.21 |       0.29 |       0.29 |       0.29 |
|         500 |     1.1 ms |              444,970 |       0.54 |       0.86 |       0.91 |       0.95 |
|        1000 |     1.9 ms |              517,216 |       0.81 |       1.22 |       1.29 |       1.32 |
|        5000 |    13.3 ms |              375,881 |       7.48 |       9.48 |       9.58 |       9.58 |
|       10000 |    24.7 ms |              404,981 |      13.44 |      19.14 |      19.27 |      19.30 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.4 ms |            226,773 |     1.91 |     2.70 |     3.39 |       3.44 |     3.44 |
|        5000 |   12.5 ms |            400,580 |     5.50 |     8.00 |     8.33 |       8.34 |     8.34 |
|       10000 |   25.9 ms |            385,839 |    12.58 |    19.36 |    20.30 |      20.32 |    20.32 |
|       25000 |   65.5 ms |            381,921 |    32.84 |    49.62 |    51.82 |      51.86 |    51.87 |
|       50000 |  120.3 ms |            415,602 |    60.29 |    95.12 |   100.31 |     100.34 |   100.35 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.1 ms |            141,054 |     3.45 |     4.85 |     5.19 |       5.26 |     5.26 |
|        5000 |   29.7 ms |            168,087 |    15.38 |    23.41 |    24.13 |      24.18 |    24.18 |
|       10000 |   63.7 ms |            156,897 |    33.28 |    54.59 |    56.01 |      56.12 |    56.13 |
|       25000 |  168.4 ms |            148,479 |    85.04 |   145.16 |   155.37 |     155.89 |   155.90 |
|       50000 |  292.9 ms |            170,684 |   156.32 |   247.41 |   268.48 |     269.07 |   269.12 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   22.5 ms |             44,403 |    14.14 |    19.36 |    21.68 |      21.92 |    21.92 |
|        5000 |   67.0 ms |             74,680 |    32.83 |    57.56 |    64.05 |      65.46 |    65.57 |
|       10000 |  151.0 ms |             66,204 |    79.04 |   134.76 |   146.99 |     148.41 |   148.58 |

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
  • Raw Worker IPC Round-Trip      : 0.0194 ms/op
  • End-to-End Runtime Task Cost    : 0.0233 ms/op
  • Scheduler + Graph Overhead     : 0.0039 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               15,774 |       0.27 |       0.29 |       0.29 |       0.29 |
|         100 |     0.5 ms |              189,355 |       0.21 |       0.29 |       0.29 |       0.29 |
|         500 |     1.1 ms |              444,970 |       0.54 |       0.86 |       0.91 |       0.95 |
|        1000 |     1.9 ms |              517,216 |       0.81 |       1.22 |       1.29 |       1.32 |
|        5000 |    13.3 ms |              375,881 |       7.48 |       9.48 |       9.58 |       9.58 |
|       10000 |    24.7 ms |              404,981 |      13.44 |      19.14 |      19.27 |      19.30 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 94.11 MB
  • V8/JSC Heap Used             : 13.42 MB

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
| 1 CPU + 1 IO  |       2 |   29.7 ms |            336,186 |    14.20 |    22.35 |    22.69 |    22.75 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   27.9 ms |            358,398 |    13.82 |    22.33 |    22.65 |    22.67 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   24.0 ms |            415,809 |    10.88 |    18.12 |    18.95 |    19.06 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   23.4 ms |            427,219 |    11.03 |    18.39 |    18.51 |    18.59 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 65.1 ms
  • Peak Throughput Rate       : 384,152 ops/sec
  • Latency Distribution       : p50: 32.75ms | p90: 52.55ms | p99: 53.91ms | p99.9: 54.20ms | Max: 54.23ms
  • Memory (RSS)               : Baseline: 100.5 MB | Peak: 132.5 MB | Cooldown: 101.9 MB

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
|        1000 |    4.4 ms |            226,773 |     1.91 |     2.70 |     3.39 |       3.44 |     3.44 |
|        5000 |   12.5 ms |            400,580 |     5.50 |     8.00 |     8.33 |       8.34 |     8.34 |
|       10000 |   25.9 ms |            385,839 |    12.58 |    19.36 |    20.30 |      20.32 |    20.32 |
|       25000 |   65.5 ms |            381,921 |    32.84 |    49.62 |    51.82 |      51.86 |    51.87 |
|       50000 |  120.3 ms |            415,602 |    60.29 |    95.12 |   100.31 |     100.34 |   100.35 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.1 ms |            141,054 |     3.45 |     4.85 |     5.19 |       5.26 |     5.26 |
|        5000 |   29.7 ms |            168,087 |    15.38 |    23.41 |    24.13 |      24.18 |    24.18 |
|       10000 |   63.7 ms |            156,897 |    33.28 |    54.59 |    56.01 |      56.12 |    56.13 |
|       25000 |  168.4 ms |            148,479 |    85.04 |   145.16 |   155.37 |     155.89 |   155.90 |
|       50000 |  292.9 ms |            170,684 |   156.32 |   247.41 |   268.48 |     269.07 |   269.12 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   22.5 ms |             44,403 |    14.14 |    19.36 |    21.68 |      21.92 |    21.92 |
|        5000 |   67.0 ms |             74,680 |    32.83 |    57.56 |    64.05 |      65.46 |    65.57 |
|       10000 |  151.0 ms |             66,204 |    79.04 |   134.76 |   146.99 |     148.41 |   148.58 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 222.9 MB
  • Settled Cooldown RSS   : 77.1 MB (Clean GC release)

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
| Yatta     |      67,155 |     1.00x |     5% | 1.32ms | 3.10ms | 3.62ms |
| Raw Bun   |      53,685 |     0.80x |     6% | 1.62ms | 3.39ms | 3.51ms |
| Hono      |      65,779 |     0.98x |    26% | 1.24ms | 1.91ms | 2.90ms |
| Elysia    |      60,494 |     0.90x |    34% | 1.60ms | 3.28ms | 3.77ms |
| Express   |      35,547 |     0.53x |     6% | 2.85ms | 5.41ms | 7.14ms |
| Fastify   |      48,052 |     0.72x |     6% | 2.18ms | 3.22ms | 4.67ms |
| Koa       |      42,359 |     0.63x |     7% | 2.40ms | 4.43ms | 6.46ms |

  Yatta dispatch adds about -3.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
