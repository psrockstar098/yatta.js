# Yatta Benchmarks

> Last run: `2026-10-07T02:40:12Z` · commit [`3fea883`](https://github.com/psrockstar098/yatta.js/commit/3fea883daf412dd06f0b5d650c8a2a23c2848b8f) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 55.3 ms
  • End-to-End Runtime Task Cost    : 0.0326 ms/op
  • Peak RSS Memory        : 112.4 MB
  • RSS Heap Memory             : 95.27 MB
  • Raw Worker IPC Round-Trip      : 0.0315 ms/op
  • Scheduler + Graph Overhead     : 0.0011 ms/op
  • Settled Cooldown RSS   : 71.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 12.80 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      81,429 | 1.00x |      1.23ms | 1.18ms | 2.04ms | 2.89ms |
| Express   |      35,070 | 0.43x |      2.85ms | 2.57ms | 4.90ms | 6.24ms |
| Fastify   |      50,571 | 0.62x |      1.97ms | 1.84ms | 3.17ms | 4.17ms |
| Hono      |      83,345 | 1.02x |      1.20ms | 1.21ms | 1.89ms | 2.64ms |
| Elysia    |      96,514 | 1.19x |      1.03ms | 1.02ms | 1.58ms | 2.82ms |
| Koa       |      37,987 | 0.47x |      2.63ms | 2.51ms | 4.38ms | 5.73ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               21,353 |       0.22 |       0.25 |       0.25 |       0.25 |
|         100 |     0.4 ms |              226,835 |       0.18 |       0.29 |       0.32 |       0.32 |
|         500 |     1.3 ms |              374,685 |       0.63 |       0.99 |       1.02 |       1.06 |
|        1000 |     2.6 ms |              386,756 |       1.20 |       1.63 |       1.65 |       1.67 |
|        5000 |    15.3 ms |              326,540 |       9.16 |      10.56 |      10.67 |      10.68 |
|       10000 |    25.6 ms |              390,623 |      13.00 |      19.81 |      20.33 |      20.51 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.6 ms |            151,574 |     2.95 |     3.49 |     3.96 |       4.17 |     4.17 |
|        5000 |   15.5 ms |            322,238 |     6.59 |     8.54 |     8.92 |       8.93 |     8.93 |
|       10000 |   28.6 ms |            350,194 |    14.72 |    21.41 |    21.89 |      21.89 |    21.89 |
|       25000 |   55.9 ms |            447,093 |    22.72 |    40.10 |    41.59 |      41.65 |    41.66 |
|       50000 |  114.4 ms |            437,169 |    55.08 |    86.00 |    89.37 |      90.27 |    90.29 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.0 ms |             99,958 |     4.94 |     7.31 |     8.22 |       8.34 |     8.34 |
|        5000 |   35.3 ms |            141,564 |    15.79 |    26.38 |    28.06 |      28.41 |    28.44 |
|       10000 |   70.1 ms |            142,647 |    30.21 |    51.29 |    55.18 |      55.26 |    55.28 |
|       25000 |  173.3 ms |            144,248 |    83.54 |   142.20 |   153.08 |     153.58 |   153.61 |
|       50000 |  377.3 ms |            132,513 |   199.99 |   327.99 |   346.74 |     349.93 |   350.11 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.6 ms |             31,681 |    19.34 |    26.19 |    29.45 |      29.74 |    29.74 |
|        5000 |   87.7 ms |             56,992 |    43.00 |    77.66 |    84.32 |      85.50 |    85.62 |
|       10000 |  199.0 ms |             50,253 |    80.91 |   170.28 |   192.45 |     195.62 |   195.93 |

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
  • Raw Worker IPC Round-Trip      : 0.0315 ms/op
  • End-to-End Runtime Task Cost    : 0.0326 ms/op
  • Scheduler + Graph Overhead     : 0.0011 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               21,353 |       0.22 |       0.25 |       0.25 |       0.25 |
|         100 |     0.4 ms |              226,835 |       0.18 |       0.29 |       0.32 |       0.32 |
|         500 |     1.3 ms |              374,685 |       0.63 |       0.99 |       1.02 |       1.06 |
|        1000 |     2.6 ms |              386,756 |       1.20 |       1.63 |       1.65 |       1.67 |
|        5000 |    15.3 ms |              326,540 |       9.16 |      10.56 |      10.67 |      10.68 |
|       10000 |    25.6 ms |              390,623 |      13.00 |      19.81 |      20.33 |      20.51 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 95.27 MB
  • V8/JSC Heap Used             : 12.80 MB

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
| 1 CPU + 1 IO  |       2 |   32.9 ms |            303,633 |    16.88 |    25.12 |    25.77 |    25.97 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   25.3 ms |            394,730 |    12.44 |    18.51 |    18.69 |    18.71 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   22.9 ms |            436,259 |    11.22 |    18.48 |    19.17 |    19.36 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   23.8 ms |            419,399 |    11.97 |    18.72 |    19.18 |    19.20 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 55.3 ms
  • Peak Throughput Rate       : 451,865 ops/sec
  • Latency Distribution       : p50: 29.53ms | p90: 43.06ms | p99: 43.49ms | p99.9: 43.59ms | Max: 43.61ms
  • Memory (RSS)               : Baseline: 111.5 MB | Peak: 127.7 MB | Cooldown: 86.3 MB

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
|        1000 |    6.6 ms |            151,574 |     2.95 |     3.49 |     3.96 |       4.17 |     4.17 |
|        5000 |   15.5 ms |            322,238 |     6.59 |     8.54 |     8.92 |       8.93 |     8.93 |
|       10000 |   28.6 ms |            350,194 |    14.72 |    21.41 |    21.89 |      21.89 |    21.89 |
|       25000 |   55.9 ms |            447,093 |    22.72 |    40.10 |    41.59 |      41.65 |    41.66 |
|       50000 |  114.4 ms |            437,169 |    55.08 |    86.00 |    89.37 |      90.27 |    90.29 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.0 ms |             99,958 |     4.94 |     7.31 |     8.22 |       8.34 |     8.34 |
|        5000 |   35.3 ms |            141,564 |    15.79 |    26.38 |    28.06 |      28.41 |    28.44 |
|       10000 |   70.1 ms |            142,647 |    30.21 |    51.29 |    55.18 |      55.26 |    55.28 |
|       25000 |  173.3 ms |            144,248 |    83.54 |   142.20 |   153.08 |     153.58 |   153.61 |
|       50000 |  377.3 ms |            132,513 |   199.99 |   327.99 |   346.74 |     349.93 |   350.11 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.6 ms |             31,681 |    19.34 |    26.19 |    29.45 |      29.74 |    29.74 |
|        5000 |   87.7 ms |             56,992 |    43.00 |    77.66 |    84.32 |      85.50 |    85.62 |
|       10000 |  199.0 ms |             50,253 |    80.91 |   170.28 |   192.45 |     195.62 |   195.93 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 112.4 MB
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

Route: GET /json
Load: 20,000 requests, 100 concurrent, keep-alive

  * Yatta   :  81,429 req/s | avg 1.23ms | p99 2.89ms
  * Express :  35,070 req/s | avg 2.85ms | p99 6.24ms
  * Fastify :  50,571 req/s | avg 1.97ms | p99 4.17ms
  * Hono    :  83,345 req/s | avg 1.20ms | p99 2.64ms
  * Elysia  :  96,514 req/s | avg 1.03ms | p99 2.82ms
  * Koa     :  37,987 req/s | avg 2.63ms | p99 5.73ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      81,429 | 1.00x |      1.23ms | 1.18ms | 2.04ms | 2.89ms |
| Express   |      35,070 | 0.43x |      2.85ms | 2.57ms | 4.90ms | 6.24ms |
| Fastify   |      50,571 | 0.62x |      1.97ms | 1.84ms | 3.17ms | 4.17ms |
| Hono      |      83,345 | 1.02x |      1.20ms | 1.21ms | 1.89ms | 2.64ms |
| Elysia    |      96,514 | 1.19x |      1.03ms | 1.02ms | 1.58ms | 2.82ms |
| Koa       |      37,987 | 0.47x |      2.63ms | 2.51ms | 4.38ms | 5.73ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
