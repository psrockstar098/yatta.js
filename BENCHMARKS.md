# Yatta Benchmarks

> Last run: `2026-10-07T00:04:17Z` · commit [`8c79d8a`](https://github.com/psrockstar098/yatta.js/commit/8c79d8a59fa8f811f4aacf98bb9f8152a6cd2b9a) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 85.4 ms
  • End-to-End Runtime Task Cost    : 0.0400 ms/op
  • Peak RSS Memory        : 227.9 MB
  • RSS Heap Memory             : 79.45 MB
  • Raw Worker IPC Round-Trip      : 0.0393 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op
  • Settled Cooldown RSS   : 195.2 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.81 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      51,051 | 1.00x |      1.96ms | 1.81ms | 3.24ms | 4.27ms |
| Express   |      22,211 | 0.44x |      4.50ms | 4.10ms | 8.07ms | 11.12ms |
| Fastify   |      29,717 | 0.58x |      3.36ms | 3.12ms | 5.88ms | 7.60ms |
| Hono      |      52,066 | 1.02x |      1.92ms | 1.63ms | 3.18ms | 4.29ms |
| Elysia    |      69,001 | 1.35x |      1.45ms | 1.39ms | 2.39ms | 3.12ms |
| Koa       |      27,256 | 0.53x |      3.66ms | 3.48ms | 6.38ms | 7.67ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,410 |       0.36 |       0.37 |       0.37 |       0.37 |
|         100 |     0.7 ms |              136,729 |       0.34 |       0.44 |       0.47 |       0.47 |
|         500 |     2.8 ms |              177,918 |       1.64 |       2.25 |       2.33 |       2.36 |
|        1000 |     3.8 ms |              261,996 |       1.90 |       2.82 |       2.90 |       2.93 |
|        5000 |    25.5 ms |              195,837 |      15.39 |      18.17 |      18.28 |      18.31 |
|       10000 |    46.5 ms |              214,928 |      24.12 |      38.38 |      38.47 |      39.11 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.9 ms |            126,686 |     3.36 |     4.70 |     6.23 |       6.59 |     6.59 |
|        5000 |   21.5 ms |            232,736 |    10.32 |    13.55 |    14.10 |      14.11 |    14.11 |
|       10000 |   40.0 ms |            250,020 |    18.77 |    28.27 |    30.20 |      30.31 |    30.34 |
|       25000 |   84.8 ms |            294,925 |    42.37 |    55.64 |    59.60 |      59.67 |    59.69 |
|       50000 |  140.5 ms |            355,842 |    72.31 |    98.98 |   107.37 |     107.51 |   107.52 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.4 ms |             74,542 |     6.14 |     8.50 |     9.59 |       9.72 |     9.72 |
|        5000 |   44.6 ms |            112,218 |    22.84 |    33.99 |    35.01 |      35.07 |    35.08 |
|       10000 |   87.0 ms |            114,965 |    44.34 |    75.64 |    77.86 |      77.96 |    77.97 |
|       25000 |  250.2 ms |             99,911 |   119.96 |   212.29 |   231.11 |     231.62 |   231.65 |
|       50000 |  448.8 ms |            111,398 |   214.56 |   385.19 |   407.72 |     408.73 |   409.24 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   25.8 ms |             38,821 |    12.38 |    21.58 |    24.41 |      24.78 |    24.78 |
|        5000 |  110.9 ms |             45,101 |    57.75 |    97.78 |   107.11 |     108.29 |   108.44 |
|       10000 |  212.9 ms |             46,964 |   108.92 |   186.99 |   205.68 |     208.79 |   209.12 |

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
  • Raw Worker IPC Round-Trip      : 0.0393 ms/op
  • End-to-End Runtime Task Cost    : 0.0400 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,410 |       0.36 |       0.37 |       0.37 |       0.37 |
|         100 |     0.7 ms |              136,729 |       0.34 |       0.44 |       0.47 |       0.47 |
|         500 |     2.8 ms |              177,918 |       1.64 |       2.25 |       2.33 |       2.36 |
|        1000 |     3.8 ms |              261,996 |       1.90 |       2.82 |       2.90 |       2.93 |
|        5000 |    25.5 ms |              195,837 |      15.39 |      18.17 |      18.28 |      18.31 |
|       10000 |    46.5 ms |              214,928 |      24.12 |      38.38 |      38.47 |      39.11 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 79.45 MB
  • V8/JSC Heap Used             : 13.81 MB

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
| 1 CPU + 1 IO  |       2 |   49.2 ms |            203,388 |    22.99 |    36.72 |    37.14 |    37.26 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   37.7 ms |            264,954 |    22.43 |    27.36 |    27.64 |    27.91 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   35.1 ms |            285,189 |    17.39 |    25.17 |    26.03 |    26.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   33.7 ms |            296,488 |    18.33 |    25.73 |    26.00 |    26.02 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 85.4 ms
  • Peak Throughput Rate       : 292,700 ops/sec
  • Latency Distribution       : p50: 41.98ms | p90: 64.54ms | p99: 66.61ms | p99.9: 66.73ms | Max: 66.74ms
  • Memory (RSS)               : Baseline: 111.1 MB | Peak: 131.7 MB | Cooldown: 103.1 MB

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
|        1000 |    7.9 ms |            126,686 |     3.36 |     4.70 |     6.23 |       6.59 |     6.59 |
|        5000 |   21.5 ms |            232,736 |    10.32 |    13.55 |    14.10 |      14.11 |    14.11 |
|       10000 |   40.0 ms |            250,020 |    18.77 |    28.27 |    30.20 |      30.31 |    30.34 |
|       25000 |   84.8 ms |            294,925 |    42.37 |    55.64 |    59.60 |      59.67 |    59.69 |
|       50000 |  140.5 ms |            355,842 |    72.31 |    98.98 |   107.37 |     107.51 |   107.52 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.4 ms |             74,542 |     6.14 |     8.50 |     9.59 |       9.72 |     9.72 |
|        5000 |   44.6 ms |            112,218 |    22.84 |    33.99 |    35.01 |      35.07 |    35.08 |
|       10000 |   87.0 ms |            114,965 |    44.34 |    75.64 |    77.86 |      77.96 |    77.97 |
|       25000 |  250.2 ms |             99,911 |   119.96 |   212.29 |   231.11 |     231.62 |   231.65 |
|       50000 |  448.8 ms |            111,398 |   214.56 |   385.19 |   407.72 |     408.73 |   409.24 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   25.8 ms |             38,821 |    12.38 |    21.58 |    24.41 |      24.78 |    24.78 |
|        5000 |  110.9 ms |             45,101 |    57.75 |    97.78 |   107.11 |     108.29 |   108.44 |
|       10000 |  212.9 ms |             46,964 |   108.92 |   186.99 |   205.68 |     208.79 |   209.12 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 227.9 MB
  • Settled Cooldown RSS   : 195.2 MB (Clean GC release)

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

Route: GET /json
Load: 20,000 requests, 100 concurrent, keep-alive

  * Yatta   :  51,051 req/s | avg 1.96ms | p99 4.27ms
  * Express :  22,211 req/s | avg 4.50ms | p99 11.12ms
  * Fastify :  29,717 req/s | avg 3.36ms | p99 7.60ms
  * Hono    :  52,066 req/s | avg 1.92ms | p99 4.29ms
  * Elysia  :  69,001 req/s | avg 1.45ms | p99 3.12ms
  * Koa     :  27,256 req/s | avg 3.66ms | p99 7.67ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      51,051 | 1.00x |      1.96ms | 1.81ms | 3.24ms | 4.27ms |
| Express   |      22,211 | 0.44x |      4.50ms | 4.10ms | 8.07ms | 11.12ms |
| Fastify   |      29,717 | 0.58x |      3.36ms | 3.12ms | 5.88ms | 7.60ms |
| Hono      |      52,066 | 1.02x |      1.92ms | 1.63ms | 3.18ms | 4.29ms |
| Elysia    |      69,001 | 1.35x |      1.45ms | 1.39ms | 2.39ms | 3.12ms |
| Koa       |      27,256 | 0.53x |      3.66ms | 3.48ms | 6.38ms | 7.67ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
