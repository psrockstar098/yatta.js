# Yatta Benchmarks

> Last run: `2026-10-17T04:47:06Z` · commit [`be209d2`](https://github.com/psrockstar098/yatta.js/commit/be209d22d6e8a8bd1642a93dd85bde095fa80dba) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 85.4 ms
  • End-to-End Runtime Task Cost    : 0.0287 ms/op
  • Peak RSS Memory        : 171.7 MB
  • RSS Heap Memory             : 80.66 MB
  • Raw Worker IPC Round-Trip      : 0.0244 ms/op
  • Scheduler + Graph Overhead     : 0.0043 ms/op
  • Settled Cooldown RSS   : 72.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 14.01 MB
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
| Yatta     |      53,807 |     1.00x |    14% | 2.40ms | 2.97ms | 3.63ms |
| Raw Bun   |      49,716 |     0.92x |    24% | 2.06ms | 4.35ms | 4.44ms |
| Hono      |      66,031 |     1.23x |     8% | 1.60ms | 2.16ms | 2.98ms |
| Elysia    |      56,456 |     1.05x |    29% | 1.90ms | 4.03ms | 4.23ms |
| Express   |      23,552 |     0.44x |     9% | 3.63ms | 6.92ms | 8.30ms |
| Fastify   |      34,217 |     0.64x |     8% | 2.82ms | 5.05ms | 6.71ms |
| Koa       |      25,660 |     0.48x |     5% | 3.74ms | 6.70ms | 9.12ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,021 |       0.29 |       0.29 |       0.29 |       0.29 |
|         100 |     0.8 ms |              131,581 |       0.29 |       0.46 |       0.47 |       0.47 |
|         500 |     1.7 ms |              292,581 |       0.83 |       1.32 |       1.38 |       1.42 |
|        1000 |     3.2 ms |              317,414 |       1.73 |       2.53 |       2.64 |       2.68 |
|        5000 |    23.7 ms |              210,861 |      12.76 |      18.19 |      18.27 |      18.33 |
|       10000 |    40.6 ms |              246,387 |      21.89 |      33.87 |      34.11 |      34.18 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.3 ms |            136,092 |     3.85 |     5.05 |     6.06 |       6.31 |     6.31 |
|        5000 |   20.5 ms |            244,461 |     9.42 |    14.25 |    14.68 |      14.69 |    14.69 |
|       10000 |   40.0 ms |            250,217 |    20.83 |    30.86 |    31.60 |      31.62 |    31.63 |
|       25000 |   86.8 ms |            288,177 |    40.58 |    68.63 |    71.59 |      71.63 |    71.69 |
|       50000 |  167.4 ms |            298,625 |    84.80 |   129.63 |   142.82 |     143.17 |   143.18 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            102,755 |     5.15 |     7.56 |     8.41 |       8.47 |     8.47 |
|        5000 |   31.6 ms |            158,259 |    16.11 |    25.10 |    25.95 |      26.01 |    26.02 |
|       10000 |   80.3 ms |            124,513 |    42.61 |    69.31 |    71.65 |      71.72 |    71.73 |
|       25000 |  204.1 ms |            122,503 |   100.60 |   177.54 |   186.76 |     187.15 |   187.18 |
|       50000 |  366.4 ms |            136,456 |   191.73 |   299.09 |   327.69 |     328.47 |   328.57 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.1 ms |             52,229 |    10.23 |    16.86 |    18.16 |      18.38 |    18.38 |
|        5000 |   91.7 ms |             54,549 |    42.84 |    81.37 |    87.81 |      88.49 |    88.59 |
|       10000 |  176.4 ms |             56,696 |    79.81 |   149.67 |   167.94 |     171.10 |   171.35 |

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
  • Raw Worker IPC Round-Trip      : 0.0244 ms/op
  • End-to-End Runtime Task Cost    : 0.0287 ms/op
  • Scheduler + Graph Overhead     : 0.0043 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               15,021 |       0.29 |       0.29 |       0.29 |       0.29 |
|         100 |     0.8 ms |              131,581 |       0.29 |       0.46 |       0.47 |       0.47 |
|         500 |     1.7 ms |              292,581 |       0.83 |       1.32 |       1.38 |       1.42 |
|        1000 |     3.2 ms |              317,414 |       1.73 |       2.53 |       2.64 |       2.68 |
|        5000 |    23.7 ms |              210,861 |      12.76 |      18.19 |      18.27 |      18.33 |
|       10000 |    40.6 ms |              246,387 |      21.89 |      33.87 |      34.11 |      34.18 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.66 MB
  • V8/JSC Heap Used             : 14.01 MB

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
| 1 CPU + 1 IO  |       2 |   46.1 ms |            217,024 |    24.73 |    35.51 |    36.09 |    36.25 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   38.2 ms |            261,947 |    20.08 |    29.00 |    29.03 |    29.07 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   32.0 ms |            312,490 |    15.30 |    24.42 |    25.29 |    25.63 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   38.4 ms |            260,360 |    18.09 |    29.29 |    29.55 |    29.58 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 85.4 ms
  • Peak Throughput Rate       : 292,595 ops/sec
  • Latency Distribution       : p50: 43.00ms | p90: 66.57ms | p99: 66.94ms | p99.9: 67.13ms | Max: 67.14ms
  • Memory (RSS)               : Baseline: 98.5 MB | Peak: 130.6 MB | Cooldown: 101.8 MB

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
|        1000 |    7.3 ms |            136,092 |     3.85 |     5.05 |     6.06 |       6.31 |     6.31 |
|        5000 |   20.5 ms |            244,461 |     9.42 |    14.25 |    14.68 |      14.69 |    14.69 |
|       10000 |   40.0 ms |            250,217 |    20.83 |    30.86 |    31.60 |      31.62 |    31.63 |
|       25000 |   86.8 ms |            288,177 |    40.58 |    68.63 |    71.59 |      71.63 |    71.69 |
|       50000 |  167.4 ms |            298,625 |    84.80 |   129.63 |   142.82 |     143.17 |   143.18 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            102,755 |     5.15 |     7.56 |     8.41 |       8.47 |     8.47 |
|        5000 |   31.6 ms |            158,259 |    16.11 |    25.10 |    25.95 |      26.01 |    26.02 |
|       10000 |   80.3 ms |            124,513 |    42.61 |    69.31 |    71.65 |      71.72 |    71.73 |
|       25000 |  204.1 ms |            122,503 |   100.60 |   177.54 |   186.76 |     187.15 |   187.18 |
|       50000 |  366.4 ms |            136,456 |   191.73 |   299.09 |   327.69 |     328.47 |   328.57 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   19.1 ms |             52,229 |    10.23 |    16.86 |    18.16 |      18.38 |    18.38 |
|        5000 |   91.7 ms |             54,549 |    42.84 |    81.37 |    87.81 |      88.49 |    88.59 |
|       10000 |  176.4 ms |             56,696 |    79.81 |   149.67 |   167.94 |     171.10 |   171.35 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 171.7 MB
  • Settled Cooldown RSS   : 72.0 MB (Clean GC release)

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
| Yatta     |      53,807 |     1.00x |    14% | 2.40ms | 2.97ms | 3.63ms |
| Raw Bun   |      49,716 |     0.92x |    24% | 2.06ms | 4.35ms | 4.44ms |
| Hono      |      66,031 |     1.23x |     8% | 1.60ms | 2.16ms | 2.98ms |
| Elysia    |      56,456 |     1.05x |    29% | 1.90ms | 4.03ms | 4.23ms |
| Express   |      23,552 |     0.44x |     9% | 3.63ms | 6.92ms | 8.30ms |
| Fastify   |      34,217 |     0.64x |     8% | 2.82ms | 5.05ms | 6.71ms |
| Koa       |      25,660 |     0.48x |     5% | 3.74ms | 6.70ms | 9.12ms |

  Yatta dispatch adds about -1.5µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
