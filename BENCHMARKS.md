# Yatta Benchmarks

> Last run: `2026-10-07T02:07:24Z` · commit [`c67d02c`](https://github.com/psrockstar098/yatta.js/commit/c67d02c537cfe73b5025e4d1053698c69b1557e6) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 136.7 ms
  • End-to-End Runtime Task Cost    : 0.0538 ms/op
  • Peak RSS Memory        : 121.3 MB
  • RSS Heap Memory             : 56.89 MB
  • Raw Worker IPC Round-Trip      : 0.0428 ms/op
  • Scheduler + Graph Overhead     : 0.0110 ms/op
  • Settled Cooldown RSS   : 72.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.76 MB
  • Worker Fleet Event Loop Lag : 10.86 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      29,358 | 1.00x |      3.40ms | 2.98ms | 5.43ms | 6.58ms |
| Express   |      13,039 | 0.44x |      7.66ms | 7.66ms | 11.79ms | 13.04ms |
| Fastify   |      15,522 | 0.53x |      6.43ms | 6.47ms | 9.91ms | 10.76ms |
| Hono      |      31,215 | 1.06x |      3.20ms | 3.48ms | 5.08ms | 7.07ms |
| Elysia    |      42,848 | 1.46x |      2.32ms | 2.05ms | 4.05ms | 5.22ms |
| Koa       |      14,860 | 0.51x |      6.72ms | 6.48ms | 10.53ms | 11.52ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,586 |       0.38 |       0.41 |       0.41 |       0.41 |
|         100 |     1.7 ms |               58,103 |       0.53 |       1.03 |       1.15 |       1.15 |
|         500 |     3.0 ms |              169,050 |       1.31 |       2.35 |       2.42 |       2.47 |
|        1000 |     5.1 ms |              197,818 |       2.74 |       4.02 |       4.15 |       4.20 |
|        5000 |    31.6 ms |              158,179 |      18.98 |      24.14 |      24.24 |      24.26 |
|       10000 |    55.6 ms |              179,861 |      32.37 |      46.15 |      46.29 |      46.31 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.4 ms |            106,516 |     3.99 |     5.83 |     7.59 |       7.67 |     7.67 |
|        5000 |   27.3 ms |            182,872 |    14.27 |    19.11 |    19.65 |      19.70 |    19.70 |
|       10000 |   58.7 ms |            170,486 |    25.27 |    45.16 |    47.51 |      47.65 |    47.66 |
|       25000 |  126.1 ms |            198,181 |    60.60 |    95.80 |   102.07 |     102.18 |   102.21 |
|       50000 |  216.3 ms |            231,194 |   114.15 |   173.57 |   184.07 |     184.56 |   184.56 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             78,827 |     5.91 |     9.45 |    11.05 |      11.39 |    11.39 |
|        5000 |   51.3 ms |             97,449 |    25.59 |    40.94 |    41.99 |      42.02 |    42.02 |
|       10000 |  111.0 ms |             90,064 |    56.35 |    93.27 |    96.47 |      96.54 |    96.55 |
|       25000 |  276.7 ms |             90,341 |   143.82 |   238.70 |   246.73 |     247.91 |   248.04 |
|       50000 |  453.1 ms |            110,345 |   242.56 |   380.52 |   410.46 |     411.55 |   411.85 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.0 ms |             31,279 |    17.14 |    27.86 |    30.69 |      31.05 |    31.05 |
|        5000 |  156.6 ms |             31,926 |    70.97 |   135.91 |   149.78 |     151.98 |   152.15 |
|       10000 |  288.5 ms |             34,665 |   142.36 |   248.73 |   277.52 |     279.96 |   280.36 |

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
  • Raw Worker IPC Round-Trip      : 0.0428 ms/op
  • End-to-End Runtime Task Cost    : 0.0538 ms/op
  • Scheduler + Graph Overhead     : 0.0110 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,586 |       0.38 |       0.41 |       0.41 |       0.41 |
|         100 |     1.7 ms |               58,103 |       0.53 |       1.03 |       1.15 |       1.15 |
|         500 |     3.0 ms |              169,050 |       1.31 |       2.35 |       2.42 |       2.47 |
|        1000 |     5.1 ms |              197,818 |       2.74 |       4.02 |       4.15 |       4.20 |
|        5000 |    31.6 ms |              158,179 |      18.98 |      24.14 |      24.24 |      24.26 |
|       10000 |    55.6 ms |              179,861 |      32.37 |      46.15 |      46.29 |      46.31 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.86 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 56.89 MB
  • V8/JSC Heap Used             : 0.76 MB

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
| 1 CPU + 1 IO  |       2 |   55.3 ms |            180,837 |    25.88 |    43.43 |    44.34 |    44.53 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   67.0 ms |            149,265 |    35.13 |    52.43 |    54.81 |    55.01 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   49.1 ms |            203,787 |    25.85 |    40.98 |    41.32 |    41.37 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   49.0 ms |            203,973 |    25.99 |    41.60 |    41.83 |    42.08 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 136.7 ms
  • Peak Throughput Rate       : 182,878 ops/sec
  • Latency Distribution       : p50: 64.87ms | p90: 110.05ms | p99: 112.15ms | p99.9: 112.23ms | Max: 112.24ms
  • Memory (RSS)               : Baseline: 107.5 MB | Peak: 126.7 MB | Cooldown: 77.8 MB

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
|        1000 |    9.4 ms |            106,516 |     3.99 |     5.83 |     7.59 |       7.67 |     7.67 |
|        5000 |   27.3 ms |            182,872 |    14.27 |    19.11 |    19.65 |      19.70 |    19.70 |
|       10000 |   58.7 ms |            170,486 |    25.27 |    45.16 |    47.51 |      47.65 |    47.66 |
|       25000 |  126.1 ms |            198,181 |    60.60 |    95.80 |   102.07 |     102.18 |   102.21 |
|       50000 |  216.3 ms |            231,194 |   114.15 |   173.57 |   184.07 |     184.56 |   184.56 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             78,827 |     5.91 |     9.45 |    11.05 |      11.39 |    11.39 |
|        5000 |   51.3 ms |             97,449 |    25.59 |    40.94 |    41.99 |      42.02 |    42.02 |
|       10000 |  111.0 ms |             90,064 |    56.35 |    93.27 |    96.47 |      96.54 |    96.55 |
|       25000 |  276.7 ms |             90,341 |   143.82 |   238.70 |   246.73 |     247.91 |   248.04 |
|       50000 |  453.1 ms |            110,345 |   242.56 |   380.52 |   410.46 |     411.55 |   411.85 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   32.0 ms |             31,279 |    17.14 |    27.86 |    30.69 |      31.05 |    31.05 |
|        5000 |  156.6 ms |             31,926 |    70.97 |   135.91 |   149.78 |     151.98 |   152.15 |
|       10000 |  288.5 ms |             34,665 |   142.36 |   248.73 |   277.52 |     279.96 |   280.36 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 121.3 MB
  • Settled Cooldown RSS   : 72.9 MB (Clean GC release)

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

  * Yatta   :  29,358 req/s | avg 3.40ms | p99 6.58ms
  * Express :  13,039 req/s | avg 7.66ms | p99 13.04ms
  * Fastify :  15,522 req/s | avg 6.43ms | p99 10.76ms
  * Hono    :  31,215 req/s | avg 3.20ms | p99 7.07ms
  * Elysia  :  42,848 req/s | avg 2.32ms | p99 5.22ms
  * Koa     :  14,860 req/s | avg 6.72ms | p99 11.52ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      29,358 | 1.00x |      3.40ms | 2.98ms | 5.43ms | 6.58ms |
| Express   |      13,039 | 0.44x |      7.66ms | 7.66ms | 11.79ms | 13.04ms |
| Fastify   |      15,522 | 0.53x |      6.43ms | 6.47ms | 9.91ms | 10.76ms |
| Hono      |      31,215 | 1.06x |      3.20ms | 3.48ms | 5.08ms | 7.07ms |
| Elysia    |      42,848 | 1.46x |      2.32ms | 2.05ms | 4.05ms | 5.22ms |
| Koa       |      14,860 | 0.51x |      6.72ms | 6.48ms | 10.53ms | 11.52ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
