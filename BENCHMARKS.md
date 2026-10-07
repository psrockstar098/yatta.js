# Yatta Benchmarks

> Last run: `2026-10-07T02:03:15Z` · commit [`bfa7643`](https://github.com/psrockstar098/yatta.js/commit/bfa7643d15b04a63b54c4d0e006348594d623571) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 76.2 ms
  • End-to-End Runtime Task Cost    : 0.0203 ms/op
  • Peak RSS Memory        : 205.0 MB
  • RSS Heap Memory             : 88.52 MB
  • Raw Worker IPC Round-Trip      : 0.0196 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op
  • Settled Cooldown RSS   : 91.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.68 MB
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      79,988 | 1.00x |      1.25ms | 1.29ms | 1.83ms | 3.06ms |
| Express   |      43,255 | 0.54x |      2.31ms | 2.24ms | 3.81ms | 5.98ms |
| Fastify   |      52,473 | 0.66x |      1.90ms | 1.95ms | 2.79ms | 4.54ms |
| Hono      |      79,850 | 1.00x |      1.25ms | 1.22ms | 2.52ms | 3.05ms |
| Elysia    |      56,207 | 0.70x |      1.78ms | 1.51ms | 3.14ms | 3.42ms |
| Koa       |      46,526 | 0.58x |      2.15ms | 2.18ms | 3.54ms | 4.60ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               25,045 |       0.20 |       0.22 |       0.22 |       0.22 |
|         100 |     0.6 ms |              171,568 |       0.29 |       0.50 |       0.51 |       0.51 |
|         500 |     0.9 ms |              543,691 |       0.48 |       0.69 |       0.72 |       0.74 |
|        1000 |     1.9 ms |              521,541 |       1.00 |       1.45 |       1.48 |       1.49 |
|        5000 |    11.7 ms |              427,640 |       5.94 |       8.07 |       8.12 |       8.16 |
|       10000 |    25.1 ms |              398,371 |      14.19 |      19.85 |      19.94 |      19.96 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.2 ms |            160,399 |     3.32 |     3.82 |     4.04 |       4.06 |     4.06 |
|        5000 |   17.6 ms |            284,048 |     9.20 |    11.92 |    12.22 |      12.22 |    12.22 |
|       10000 |   26.7 ms |            373,931 |    12.95 |    18.75 |    19.38 |      19.41 |    19.42 |
|       25000 |   67.3 ms |            371,551 |    32.39 |    46.11 |    53.31 |      53.51 |    53.53 |
|       50000 |  103.1 ms |            485,040 |    49.50 |    77.49 |    80.79 |      81.13 |    81.14 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.9 ms |            144,310 |     3.16 |     4.58 |     5.19 |       5.25 |     5.25 |
|        5000 |   21.9 ms |            227,998 |    11.05 |    17.01 |    17.65 |      17.80 |    17.81 |
|       10000 |   57.2 ms |            174,838 |    29.48 |    46.50 |    50.14 |      50.25 |    50.25 |
|       25000 |  152.9 ms |            163,522 |    76.97 |   134.09 |   142.60 |     142.86 |   142.87 |
|       50000 |  286.3 ms |            174,652 |   156.34 |   249.27 |   266.81 |     267.60 |   267.67 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.9 ms |             67,007 |     8.16 |    13.21 |    14.26 |      14.36 |    14.36 |
|        5000 |   64.8 ms |             77,202 |    34.38 |    56.74 |    61.47 |      61.94 |    62.02 |
|       10000 |  143.6 ms |             69,622 |    64.96 |   116.54 |   140.14 |     141.35 |   141.52 |

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
  • Raw Worker IPC Round-Trip      : 0.0196 ms/op
  • End-to-End Runtime Task Cost    : 0.0203 ms/op
  • Scheduler + Graph Overhead     : 0.0007 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.4 ms |               25,045 |       0.20 |       0.22 |       0.22 |       0.22 |
|         100 |     0.6 ms |              171,568 |       0.29 |       0.50 |       0.51 |       0.51 |
|         500 |     0.9 ms |              543,691 |       0.48 |       0.69 |       0.72 |       0.74 |
|        1000 |     1.9 ms |              521,541 |       1.00 |       1.45 |       1.48 |       1.49 |
|        5000 |    11.7 ms |              427,640 |       5.94 |       8.07 |       8.12 |       8.16 |
|       10000 |    25.1 ms |              398,371 |      14.19 |      19.85 |      19.94 |      19.96 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 88.52 MB
  • V8/JSC Heap Used             : 13.68 MB

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
| 1 CPU + 1 IO  |       2 |   35.3 ms |            283,302 |    14.64 |    27.70 |    28.40 |    28.44 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   34.5 ms |            290,160 |    17.33 |    25.19 |    25.38 |    25.39 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   24.5 ms |            407,479 |    13.15 |    19.16 |    19.71 |    19.96 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   22.4 ms |            445,825 |    11.97 |    16.39 |    16.61 |    16.65 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 76.2 ms
  • Peak Throughput Rate       : 328,123 ops/sec
  • Latency Distribution       : p50: 35.60ms | p90: 57.96ms | p99: 58.46ms | p99.9: 58.72ms | Max: 58.77ms
  • Memory (RSS)               : Baseline: 106.7 MB | Peak: 129.3 MB | Cooldown: 102.9 MB

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
|        1000 |    6.2 ms |            160,399 |     3.32 |     3.82 |     4.04 |       4.06 |     4.06 |
|        5000 |   17.6 ms |            284,048 |     9.20 |    11.92 |    12.22 |      12.22 |    12.22 |
|       10000 |   26.7 ms |            373,931 |    12.95 |    18.75 |    19.38 |      19.41 |    19.42 |
|       25000 |   67.3 ms |            371,551 |    32.39 |    46.11 |    53.31 |      53.51 |    53.53 |
|       50000 |  103.1 ms |            485,040 |    49.50 |    77.49 |    80.79 |      81.13 |    81.14 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.9 ms |            144,310 |     3.16 |     4.58 |     5.19 |       5.25 |     5.25 |
|        5000 |   21.9 ms |            227,998 |    11.05 |    17.01 |    17.65 |      17.80 |    17.81 |
|       10000 |   57.2 ms |            174,838 |    29.48 |    46.50 |    50.14 |      50.25 |    50.25 |
|       25000 |  152.9 ms |            163,522 |    76.97 |   134.09 |   142.60 |     142.86 |   142.87 |
|       50000 |  286.3 ms |            174,652 |   156.34 |   249.27 |   266.81 |     267.60 |   267.67 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.9 ms |             67,007 |     8.16 |    13.21 |    14.26 |      14.36 |    14.36 |
|        5000 |   64.8 ms |             77,202 |    34.38 |    56.74 |    61.47 |      61.94 |    62.02 |
|       10000 |  143.6 ms |             69,622 |    64.96 |   116.54 |   140.14 |     141.35 |   141.52 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 205.0 MB
  • Settled Cooldown RSS   : 91.4 MB (Clean GC release)

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

  * Yatta   :  79,988 req/s | avg 1.25ms | p99 3.06ms
  * Express :  43,255 req/s | avg 2.31ms | p99 5.98ms
  * Fastify :  52,473 req/s | avg 1.90ms | p99 4.54ms
  * Hono    :  79,850 req/s | avg 1.25ms | p99 3.05ms
  * Elysia  :  56,207 req/s | avg 1.78ms | p99 3.42ms
  * Koa     :  46,526 req/s | avg 2.15ms | p99 4.60ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      79,988 | 1.00x |      1.25ms | 1.29ms | 1.83ms | 3.06ms |
| Express   |      43,255 | 0.54x |      2.31ms | 2.24ms | 3.81ms | 5.98ms |
| Fastify   |      52,473 | 0.66x |      1.90ms | 1.95ms | 2.79ms | 4.54ms |
| Hono      |      79,850 | 1.00x |      1.25ms | 1.22ms | 2.52ms | 3.05ms |
| Elysia    |      56,207 | 0.70x |      1.78ms | 1.51ms | 3.14ms | 3.42ms |
| Koa       |      46,526 | 0.58x |      2.15ms | 2.18ms | 3.54ms | 4.60ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
