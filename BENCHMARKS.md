# Yatta Benchmarks

> Last run: `2026-10-18T01:46:29Z` · commit [`8e9fe58`](https://github.com/psrockstar098/yatta.js/commit/8e9fe5833ad386436c168bb5b3699f7dc80fc621) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 110.8 ms
  • End-to-End Runtime Task Cost    : 0.0499 ms/op
  • Peak RSS Memory        : 124.8 MB
  • RSS Heap Memory             : 56.41 MB
  • Raw Worker IPC Round-Trip      : 0.0397 ms/op
  • Scheduler + Graph Overhead     : 0.0102 ms/op
  • Settled Cooldown RSS   : 82.8 MB (Clean GC release)
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
| Yatta     |      39,418 |     1.00x |     9% | 2.18ms | 4.21ms | 4.74ms |
| Raw Bun   |      48,016 |     1.22x |    31% | 2.63ms | 4.94ms | 6.08ms |
| Hono      |      47,962 |     1.22x |    36% | 3.02ms | 4.55ms | 5.37ms |
| Elysia    |      40,456 |     1.03x |    35% | 2.51ms | 4.79ms | 5.26ms |
| Express   |      14,934 |     0.38x |     5% | 6.70ms | 11.07ms | 12.01ms |
| Fastify   |      21,110 |     0.54x |     5% | 4.31ms | 8.18ms | 9.09ms |
| Koa       |      15,439 |     0.39x |     4% | 6.58ms | 9.95ms | 11.97ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               11,823 |       0.45 |       0.49 |       0.49 |       0.49 |
|         100 |     0.7 ms |              137,874 |       0.28 |       0.44 |       0.50 |       0.50 |
|         500 |     2.5 ms |              198,913 |       1.23 |       1.82 |       1.92 |       1.95 |
|        1000 |     4.3 ms |              232,711 |       2.25 |       3.48 |       3.57 |       3.61 |
|        5000 |    28.3 ms |              176,498 |      16.20 |      19.99 |      20.03 |      20.04 |
|       10000 |    53.2 ms |              188,134 |      27.20 |      43.74 |      44.29 |      44.32 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.4 ms |            105,926 |     4.24 |     6.13 |     7.94 |       8.08 |     8.08 |
|        5000 |   22.1 ms |            226,445 |    10.14 |    14.35 |    14.93 |      14.94 |    14.94 |
|       10000 |   49.2 ms |            203,075 |    22.47 |    35.03 |    37.09 |      37.18 |    37.20 |
|       25000 |   99.4 ms |            251,601 |    46.76 |    74.32 |    77.97 |      78.08 |    78.10 |
|       50000 |  180.7 ms |            276,732 |    94.40 |   141.48 |   152.18 |     152.37 |   152.39 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,364 |     6.20 |     9.59 |    11.22 |      11.40 |    11.40 |
|        5000 |   47.5 ms |            105,262 |    21.76 |    36.34 |    37.29 |      37.34 |    37.35 |
|       10000 |   88.9 ms |            112,543 |    44.01 |    71.23 |    74.05 |      74.12 |    74.13 |
|       25000 |  240.6 ms |            103,919 |   122.16 |   208.19 |   221.91 |     222.38 |   222.40 |
|       50000 |  413.6 ms |            120,884 |   202.13 |   347.26 |   379.43 |     380.36 |   380.42 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.0 ms |             30,342 |    17.21 |    28.60 |    31.55 |      31.96 |    31.96 |
|        5000 |  135.1 ms |             37,005 |    70.14 |   119.54 |   131.03 |     132.53 |   132.68 |
|       10000 |  291.5 ms |             34,305 |   143.55 |   250.46 |   279.95 |     283.99 |   284.48 |

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
  • Raw Worker IPC Round-Trip      : 0.0397 ms/op
  • End-to-End Runtime Task Cost    : 0.0499 ms/op
  • Scheduler + Graph Overhead     : 0.0102 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               11,823 |       0.45 |       0.49 |       0.49 |       0.49 |
|         100 |     0.7 ms |              137,874 |       0.28 |       0.44 |       0.50 |       0.50 |
|         500 |     2.5 ms |              198,913 |       1.23 |       1.82 |       1.92 |       1.95 |
|        1000 |     4.3 ms |              232,711 |       2.25 |       3.48 |       3.57 |       3.61 |
|        5000 |    28.3 ms |              176,498 |      16.20 |      19.99 |      20.03 |      20.04 |
|       10000 |    53.2 ms |              188,134 |      27.20 |      43.74 |      44.29 |      44.32 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 56.41 MB
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
| 1 CPU + 1 IO  |       2 |   49.3 ms |            202,732 |    24.97 |    38.07 |    38.73 |    38.84 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   46.7 ms |            213,976 |    24.56 |    34.75 |    35.47 |    35.49 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   33.2 ms |            301,163 |    17.61 |    26.20 |    26.67 |    26.91 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   39.6 ms |            252,522 |    20.28 |    30.81 |    31.40 |    31.47 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 110.8 ms
  • Peak Throughput Rate       : 225,560 ops/sec
  • Latency Distribution       : p50: 55.64ms | p90: 89.34ms | p99: 91.27ms | p99.9: 91.30ms | Max: 91.30ms
  • Memory (RSS)               : Baseline: 108.0 MB | Peak: 129.7 MB | Cooldown: 103.1 MB

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
|        1000 |    9.4 ms |            105,926 |     4.24 |     6.13 |     7.94 |       8.08 |     8.08 |
|        5000 |   22.1 ms |            226,445 |    10.14 |    14.35 |    14.93 |      14.94 |    14.94 |
|       10000 |   49.2 ms |            203,075 |    22.47 |    35.03 |    37.09 |      37.18 |    37.20 |
|       25000 |   99.4 ms |            251,601 |    46.76 |    74.32 |    77.97 |      78.08 |    78.10 |
|       50000 |  180.7 ms |            276,732 |    94.40 |   141.48 |   152.18 |     152.37 |   152.39 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.4 ms |             80,364 |     6.20 |     9.59 |    11.22 |      11.40 |    11.40 |
|        5000 |   47.5 ms |            105,262 |    21.76 |    36.34 |    37.29 |      37.34 |    37.35 |
|       10000 |   88.9 ms |            112,543 |    44.01 |    71.23 |    74.05 |      74.12 |    74.13 |
|       25000 |  240.6 ms |            103,919 |   122.16 |   208.19 |   221.91 |     222.38 |   222.40 |
|       50000 |  413.6 ms |            120,884 |   202.13 |   347.26 |   379.43 |     380.36 |   380.42 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.0 ms |             30,342 |    17.21 |    28.60 |    31.55 |      31.96 |    31.96 |
|        5000 |  135.1 ms |             37,005 |    70.14 |   119.54 |   131.03 |     132.53 |   132.68 |
|       10000 |  291.5 ms |             34,305 |   143.55 |   250.46 |   279.95 |     283.99 |   284.48 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 124.8 MB
  • Settled Cooldown RSS   : 82.8 MB (Clean GC release)

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
| Yatta     |      39,418 |     1.00x |     9% | 2.18ms | 4.21ms | 4.74ms |
| Raw Bun   |      48,016 |     1.22x |    31% | 2.63ms | 4.94ms | 6.08ms |
| Hono      |      47,962 |     1.22x |    36% | 3.02ms | 4.55ms | 5.37ms |
| Elysia    |      40,456 |     1.03x |    35% | 2.51ms | 4.79ms | 5.26ms |
| Express   |      14,934 |     0.38x |     5% | 6.70ms | 11.07ms | 12.01ms |
| Fastify   |      21,110 |     0.54x |     5% | 4.31ms | 8.18ms | 9.09ms |
| Koa       |      15,439 |     0.39x |     4% | 6.58ms | 9.95ms | 11.97ms |

  Yatta dispatch adds about 4.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
