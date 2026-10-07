# Yatta Benchmarks

> Last run: `2026-10-07T01:56:08Z` · commit [`47aa5bf`](https://github.com/psrockstar098/yatta.js/commit/47aa5bf0df3a81bb1b213ea5410a2943a21297b8) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 118.7 ms
  • End-to-End Runtime Task Cost    : 0.0524 ms/op
  • Peak RSS Memory        : 123.1 MB
  • RSS Heap Memory             : 71.38 MB
  • Raw Worker IPC Round-Trip      : 0.0340 ms/op
  • Scheduler + Graph Overhead     : 0.0184 ms/op
  • Settled Cooldown RSS   : 69.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      37,282 | 1.00x |      2.68ms | 2.34ms | 4.64ms | 5.33ms |
| Express   |      14,495 | 0.39x |      6.89ms | 6.57ms | 11.08ms | 11.91ms |
| Fastify   |      17,841 | 0.48x |      5.60ms | 5.78ms | 8.50ms | 9.54ms |
| Hono      |      37,118 | 1.00x |      2.69ms | 2.48ms | 4.57ms | 5.83ms |
| Elysia    |      36,653 | 0.98x |      2.72ms | 2.99ms | 4.65ms | 5.79ms |
| Koa       |      14,549 | 0.39x |      6.87ms | 6.03ms | 11.17ms | 12.41ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.0 ms |               10,102 |       0.40 |       0.42 |       0.42 |       0.42 |
|         100 |     1.0 ms |               96,985 |       0.47 |       0.63 |       0.68 |       0.68 |
|         500 |     2.5 ms |              198,001 |       1.18 |       1.41 |       1.43 |       1.45 |
|        1000 |     4.3 ms |              230,758 |       2.09 |       2.67 |       2.79 |       2.85 |
|        5000 |    31.0 ms |              161,379 |      18.03 |      22.87 |      23.22 |      23.29 |
|       10000 |    49.1 ms |              203,530 |      26.30 |      39.40 |      39.74 |      39.81 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.7 ms |             93,457 |     4.95 |     6.72 |     8.55 |       8.66 |     8.66 |
|        5000 |   31.1 ms |            160,981 |    12.97 |    20.09 |    20.69 |      20.70 |    20.71 |
|       10000 |   51.5 ms |            194,058 |    25.13 |    38.61 |    40.58 |      40.89 |    40.92 |
|       25000 |  105.4 ms |            237,214 |    53.05 |    77.96 |    81.18 |      81.28 |    81.29 |
|       50000 |  215.9 ms |            231,541 |   109.66 |   172.07 |   177.84 |     178.29 |   178.31 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.0 ms |             71,415 |     6.59 |    10.08 |    11.85 |      12.03 |    12.03 |
|        5000 |   49.4 ms |            101,167 |    26.12 |    37.77 |    38.79 |      38.86 |    38.86 |
|       10000 |  107.1 ms |             93,355 |    56.65 |    92.13 |    95.52 |      95.58 |    95.60 |
|       25000 |  270.3 ms |             92,506 |   140.91 |   233.58 |   248.68 |     248.91 |   248.93 |
|       50000 |  460.3 ms |            108,629 |   257.36 |   388.36 |   421.10 |     422.48 |   422.55 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.8 ms |             31,443 |    16.60 |    28.35 |    30.66 |      30.93 |    30.93 |
|        5000 |  147.9 ms |             33,800 |    68.28 |   131.69 |   142.96 |     144.19 |   144.38 |
|       10000 |  281.2 ms |             35,557 |   146.13 |   249.23 |   273.45 |     275.62 |   275.98 |

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
  • Raw Worker IPC Round-Trip      : 0.0340 ms/op
  • End-to-End Runtime Task Cost    : 0.0524 ms/op
  • Scheduler + Graph Overhead     : 0.0184 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.0 ms |               10,102 |       0.40 |       0.42 |       0.42 |       0.42 |
|         100 |     1.0 ms |               96,985 |       0.47 |       0.63 |       0.68 |       0.68 |
|         500 |     2.5 ms |              198,001 |       1.18 |       1.41 |       1.43 |       1.45 |
|        1000 |     4.3 ms |              230,758 |       2.09 |       2.67 |       2.79 |       2.85 |
|        5000 |    31.0 ms |              161,379 |      18.03 |      22.87 |      23.22 |      23.29 |
|       10000 |    49.1 ms |              203,530 |      26.30 |      39.40 |      39.74 |      39.81 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 71.38 MB
  • V8/JSC Heap Used             : 0.75 MB

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
| 1 CPU + 1 IO  |       2 |   55.9 ms |            178,796 |    27.65 |    43.06 |    43.57 |    43.79 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   48.8 ms |            204,824 |    27.09 |    37.09 |    37.14 |    37.15 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   36.9 ms |            270,646 |    17.71 |    30.02 |    30.27 |    30.39 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   47.0 ms |            212,846 |    24.97 |    37.07 |    37.38 |    37.42 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 118.7 ms
  • Peak Throughput Rate       : 210,544 ops/sec
  • Latency Distribution       : p50: 58.65ms | p90: 93.39ms | p99: 94.71ms | p99.9: 94.75ms | Max: 94.76ms
  • Memory (RSS)               : Baseline: 104.8 MB | Peak: 128.3 MB | Cooldown: 101.9 MB

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
|        1000 |   10.7 ms |             93,457 |     4.95 |     6.72 |     8.55 |       8.66 |     8.66 |
|        5000 |   31.1 ms |            160,981 |    12.97 |    20.09 |    20.69 |      20.70 |    20.71 |
|       10000 |   51.5 ms |            194,058 |    25.13 |    38.61 |    40.58 |      40.89 |    40.92 |
|       25000 |  105.4 ms |            237,214 |    53.05 |    77.96 |    81.18 |      81.28 |    81.29 |
|       50000 |  215.9 ms |            231,541 |   109.66 |   172.07 |   177.84 |     178.29 |   178.31 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.0 ms |             71,415 |     6.59 |    10.08 |    11.85 |      12.03 |    12.03 |
|        5000 |   49.4 ms |            101,167 |    26.12 |    37.77 |    38.79 |      38.86 |    38.86 |
|       10000 |  107.1 ms |             93,355 |    56.65 |    92.13 |    95.52 |      95.58 |    95.60 |
|       25000 |  270.3 ms |             92,506 |   140.91 |   233.58 |   248.68 |     248.91 |   248.93 |
|       50000 |  460.3 ms |            108,629 |   257.36 |   388.36 |   421.10 |     422.48 |   422.55 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.8 ms |             31,443 |    16.60 |    28.35 |    30.66 |      30.93 |    30.93 |
|        5000 |  147.9 ms |             33,800 |    68.28 |   131.69 |   142.96 |     144.19 |   144.38 |
|       10000 |  281.2 ms |             35,557 |   146.13 |   249.23 |   273.45 |     275.62 |   275.98 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 123.1 MB
  • Settled Cooldown RSS   : 69.9 MB (Clean GC release)

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

  * Yatta   :  37,282 req/s | avg 2.68ms | p99 5.33ms
  * Express :  14,495 req/s | avg 6.89ms | p99 11.91ms
  * Fastify :  17,841 req/s | avg 5.60ms | p99 9.54ms
  * Hono    :  37,118 req/s | avg 2.69ms | p99 5.83ms
  * Elysia  :  36,653 req/s | avg 2.72ms | p99 5.79ms
  * Koa     :  14,549 req/s | avg 6.87ms | p99 12.41ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      37,282 | 1.00x |      2.68ms | 2.34ms | 4.64ms | 5.33ms |
| Express   |      14,495 | 0.39x |      6.89ms | 6.57ms | 11.08ms | 11.91ms |
| Fastify   |      17,841 | 0.48x |      5.60ms | 5.78ms | 8.50ms | 9.54ms |
| Hono      |      37,118 | 1.00x |      2.69ms | 2.48ms | 4.57ms | 5.83ms |
| Elysia    |      36,653 | 0.98x |      2.72ms | 2.99ms | 4.65ms | 5.79ms |
| Koa       |      14,549 | 0.39x |      6.87ms | 6.03ms | 11.17ms | 12.41ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
