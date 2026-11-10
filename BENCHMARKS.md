# Yatta Benchmarks

> Last run: `2026-11-10T19:49:50Z` · commit [`e7be6fc`](https://github.com/psrockstar098/yatta.js/commit/e7be6fc900a09a843a28b74a5cde3706897aac18) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 95.4 ms
  • End-to-End Runtime Task Cost    : 0.0410 ms/op
  • Peak RSS Memory        : 139.6 MB
  • RSS Heap Memory             : 77.68 MB
  • Raw Worker IPC Round-Trip      : 0.0316 ms/op
  • Scheduler + Graph Overhead     : 0.0094 ms/op
  • Settled Cooldown RSS   : 88.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.79 MB
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
| Yatta     |      46,942 |     1.00x |     5% | 1.98ms | 3.76ms | 4.65ms |
| Raw Bun   |      43,011 |     0.92x |    21% | 2.27ms | 4.71ms | 4.84ms |
| Hono      |      48,560 |     1.03x |    34% | 1.85ms | 3.53ms | 4.20ms |
| Elysia    |      47,022 |     1.00x |     8% | 2.17ms | 3.70ms | 5.16ms |
| Express   |      15,487 |     0.33x |     4% | 6.40ms | 10.13ms | 11.49ms |
| Fastify   |      22,094 |     0.47x |     6% | 4.07ms | 7.61ms | 8.98ms |
| Koa       |      15,459 |     0.33x |     5% | 6.51ms | 10.06ms | 11.30ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,601 |       0.31 |       0.35 |       0.35 |       0.35 |
|         100 |     0.8 ms |              132,900 |       0.27 |       0.59 |       0.62 |       0.62 |
|         500 |     1.9 ms |              269,029 |       0.91 |       1.27 |       1.35 |       1.40 |
|        1000 |     3.5 ms |              287,926 |       1.83 |       2.63 |       2.67 |       2.70 |
|        5000 |    20.0 ms |              250,588 |      11.15 |      13.85 |      14.30 |      14.34 |
|       10000 |    43.4 ms |              230,234 |      20.92 |      32.73 |      33.72 |      33.94 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    8.0 ms |            125,499 |     3.46 |     4.89 |     6.00 |       6.12 |     6.12 |
|        5000 |   20.0 ms |            250,036 |    10.41 |    11.86 |    12.03 |      12.04 |    12.04 |
|       10000 |   42.8 ms |            233,469 |    22.50 |    32.56 |    33.69 |      33.70 |    33.70 |
|       25000 |  101.7 ms |            245,919 |    51.55 |    75.86 |    79.67 |      80.18 |    80.25 |
|       50000 |  189.0 ms |            264,577 |    94.38 |   151.09 |   159.98 |     160.48 |   160.53 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.5 ms |             74,030 |     6.86 |    10.49 |    12.20 |      12.36 |    12.36 |
|        5000 |   38.7 ms |            129,173 |    18.73 |    29.60 |    30.63 |      30.70 |    30.70 |
|       10000 |   87.5 ms |            114,329 |    42.84 |    74.39 |    77.62 |      77.72 |    77.73 |
|       25000 |  253.8 ms |             98,508 |   132.80 |   220.07 |   233.71 |     234.19 |   234.22 |
|       50000 |  446.9 ms |            111,888 |   243.90 |   372.79 |   407.20 |     408.38 |   408.45 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   27.3 ms |             36,614 |    14.09 |    23.31 |    25.90 |      26.22 |    26.22 |
|        5000 |   97.3 ms |             51,389 |    48.35 |    84.66 |    93.46 |      95.02 |    95.19 |
|       10000 |  229.8 ms |             43,515 |   118.34 |   200.81 |   220.55 |     223.62 |   223.92 |

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
  • Raw Worker IPC Round-Trip      : 0.0316 ms/op
  • End-to-End Runtime Task Cost    : 0.0410 ms/op
  • Scheduler + Graph Overhead     : 0.0094 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,601 |       0.31 |       0.35 |       0.35 |       0.35 |
|         100 |     0.8 ms |              132,900 |       0.27 |       0.59 |       0.62 |       0.62 |
|         500 |     1.9 ms |              269,029 |       0.91 |       1.27 |       1.35 |       1.40 |
|        1000 |     3.5 ms |              287,926 |       1.83 |       2.63 |       2.67 |       2.70 |
|        5000 |    20.0 ms |              250,588 |      11.15 |      13.85 |      14.30 |      14.34 |
|       10000 |    43.4 ms |              230,234 |      20.92 |      32.73 |      33.72 |      33.94 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.68 MB
  • V8/JSC Heap Used             : 0.79 MB

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
| 1 CPU + 1 IO  |       2 |   48.8 ms |            204,836 |    21.69 |    34.21 |    36.76 |    36.90 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.5 ms |            230,068 |    22.70 |    32.17 |    33.52 |    33.56 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   34.0 ms |            294,336 |    17.09 |    26.71 |    27.32 |    27.62 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   35.1 ms |            284,922 |    19.38 |    26.24 |    26.47 |    26.50 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 95.4 ms
  • Peak Throughput Rate       : 262,136 ops/sec
  • Latency Distribution       : p50: 47.32ms | p90: 74.18ms | p99: 77.09ms | p99.9: 77.18ms | Max: 77.20ms
  • Memory (RSS)               : Baseline: 102.4 MB | Peak: 131.6 MB | Cooldown: 84.4 MB

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
|        1000 |    8.0 ms |            125,499 |     3.46 |     4.89 |     6.00 |       6.12 |     6.12 |
|        5000 |   20.0 ms |            250,036 |    10.41 |    11.86 |    12.03 |      12.04 |    12.04 |
|       10000 |   42.8 ms |            233,469 |    22.50 |    32.56 |    33.69 |      33.70 |    33.70 |
|       25000 |  101.7 ms |            245,919 |    51.55 |    75.86 |    79.67 |      80.18 |    80.25 |
|       50000 |  189.0 ms |            264,577 |    94.38 |   151.09 |   159.98 |     160.48 |   160.53 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.5 ms |             74,030 |     6.86 |    10.49 |    12.20 |      12.36 |    12.36 |
|        5000 |   38.7 ms |            129,173 |    18.73 |    29.60 |    30.63 |      30.70 |    30.70 |
|       10000 |   87.5 ms |            114,329 |    42.84 |    74.39 |    77.62 |      77.72 |    77.73 |
|       25000 |  253.8 ms |             98,508 |   132.80 |   220.07 |   233.71 |     234.19 |   234.22 |
|       50000 |  446.9 ms |            111,888 |   243.90 |   372.79 |   407.20 |     408.38 |   408.45 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   27.3 ms |             36,614 |    14.09 |    23.31 |    25.90 |      26.22 |    26.22 |
|        5000 |   97.3 ms |             51,389 |    48.35 |    84.66 |    93.46 |      95.02 |    95.19 |
|       10000 |  229.8 ms |             43,515 |   118.34 |   200.81 |   220.55 |     223.62 |   223.92 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 139.6 MB
  • Settled Cooldown RSS   : 88.7 MB (Clean GC release)

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
| Yatta     |      46,942 |     1.00x |     5% | 1.98ms | 3.76ms | 4.65ms |
| Raw Bun   |      43,011 |     0.92x |    21% | 2.27ms | 4.71ms | 4.84ms |
| Hono      |      48,560 |     1.03x |    34% | 1.85ms | 3.53ms | 4.20ms |
| Elysia    |      47,022 |     1.00x |     8% | 2.17ms | 3.70ms | 5.16ms |
| Express   |      15,487 |     0.33x |     4% | 6.40ms | 10.13ms | 11.49ms |
| Fastify   |      22,094 |     0.47x |     6% | 4.07ms | 7.61ms | 8.98ms |
| Koa       |      15,459 |     0.33x |     5% | 6.51ms | 10.06ms | 11.30ms |

  Yatta dispatch adds about -1.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
