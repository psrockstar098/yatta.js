# Yatta Benchmarks

> Last run: `2026-10-07T02:01:42Z` · commit [`c5395fd`](https://github.com/psrockstar098/yatta.js/commit/c5395fdd91cb5f5945b145a1fdb00bbb588b06c1) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 100.6 ms
  • End-to-End Runtime Task Cost    : 0.0566 ms/op
  • Peak RSS Memory        : 186.3 MB
  • RSS Heap Memory             : 74.23 MB
  • Raw Worker IPC Round-Trip      : 0.0405 ms/op
  • Scheduler + Graph Overhead     : 0.0161 ms/op
  • Settled Cooldown RSS   : 75.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.76 MB
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      43,244 | 1.00x |      2.31ms | 2.22ms | 4.34ms | 5.09ms |
| Express   |      13,443 | 0.31x |      7.43ms | 7.82ms | 10.98ms | 12.32ms |
| Fastify   |      20,725 | 0.48x |      4.82ms | 4.24ms | 8.34ms | 9.63ms |
| Hono      |      50,251 | 1.16x |      1.99ms | 2.03ms | 3.54ms | 4.64ms |
| Elysia    |      44,336 | 1.03x |      2.25ms | 1.98ms | 4.54ms | 5.89ms |
| Koa       |      14,266 | 0.33x |      7.00ms | 6.95ms | 11.14ms | 12.14ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,286 |       0.36 |       0.41 |       0.41 |       0.41 |
|         100 |     1.4 ms |               72,587 |       0.42 |       0.93 |       0.94 |       0.94 |
|         500 |     2.4 ms |              210,759 |       1.18 |       1.88 |       1.96 |       2.00 |
|        1000 |     5.2 ms |              192,446 |       2.28 |       2.96 |       3.09 |       3.13 |
|        5000 |    29.9 ms |              167,320 |      16.92 |      20.76 |      20.97 |      21.05 |
|       10000 |    51.0 ms |              196,051 |      26.99 |      40.59 |      41.80 |      41.81 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,078 |     4.26 |     5.94 |     8.16 |       8.33 |     8.33 |
|        5000 |   22.5 ms |            221,850 |    10.94 |    14.61 |    15.12 |      15.13 |    15.13 |
|       10000 |   51.4 ms |            194,439 |    25.92 |    38.97 |    40.10 |      40.11 |    40.11 |
|       25000 |   98.9 ms |            252,802 |    44.67 |    71.57 |    74.81 |      75.06 |    75.08 |
|       50000 |  199.9 ms |            250,082 |    95.78 |   157.63 |   168.35 |     168.43 |   168.45 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.6 ms |             68,430 |     6.79 |     9.88 |    11.37 |      11.65 |    11.65 |
|        5000 |   51.0 ms |             98,093 |    24.44 |    39.13 |    40.05 |      40.07 |    40.07 |
|       10000 |  107.9 ms |             92,640 |    54.20 |    89.63 |    91.96 |      93.97 |    94.09 |
|       25000 |  311.8 ms |             80,172 |   143.34 |   254.98 |   275.70 |     278.39 |   278.60 |
|       50000 |  545.7 ms |             91,626 |   275.00 |   444.83 |   480.45 |     484.12 |   486.37 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   35.0 ms |             28,605 |    15.11 |    28.12 |    32.94 |      33.63 |    33.63 |
|        5000 |  149.3 ms |             33,489 |    80.13 |   133.40 |   144.86 |     146.50 |   146.68 |
|       10000 |  279.4 ms |             35,792 |   138.81 |   240.91 |   267.61 |     272.18 |   272.56 |

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
  • Raw Worker IPC Round-Trip      : 0.0405 ms/op
  • End-to-End Runtime Task Cost    : 0.0566 ms/op
  • Scheduler + Graph Overhead     : 0.0161 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,286 |       0.36 |       0.41 |       0.41 |       0.41 |
|         100 |     1.4 ms |               72,587 |       0.42 |       0.93 |       0.94 |       0.94 |
|         500 |     2.4 ms |              210,759 |       1.18 |       1.88 |       1.96 |       2.00 |
|        1000 |     5.2 ms |              192,446 |       2.28 |       2.96 |       3.09 |       3.13 |
|        5000 |    29.9 ms |              167,320 |      16.92 |      20.76 |      20.97 |      21.05 |
|       10000 |    51.0 ms |              196,051 |      26.99 |      40.59 |      41.80 |      41.81 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 74.23 MB
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
| 1 CPU + 1 IO  |       2 |   52.5 ms |            190,635 |    26.02 |    39.15 |    40.00 |    40.27 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   40.5 ms |            247,167 |    20.91 |    30.97 |    32.11 |    32.21 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   47.7 ms |            209,755 |    22.06 |    37.11 |    38.78 |    39.41 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   39.1 ms |            256,052 |    19.21 |    31.44 |    31.70 |    31.74 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 100.6 ms
  • Peak Throughput Rate       : 248,469 ops/sec
  • Latency Distribution       : p50: 51.18ms | p90: 79.11ms | p99: 80.07ms | p99.9: 80.31ms | Max: 80.32ms
  • Memory (RSS)               : Baseline: 100.3 MB | Peak: 127.4 MB | Cooldown: 100.5 MB

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
|        1000 |    9.5 ms |            105,078 |     4.26 |     5.94 |     8.16 |       8.33 |     8.33 |
|        5000 |   22.5 ms |            221,850 |    10.94 |    14.61 |    15.12 |      15.13 |    15.13 |
|       10000 |   51.4 ms |            194,439 |    25.92 |    38.97 |    40.10 |      40.11 |    40.11 |
|       25000 |   98.9 ms |            252,802 |    44.67 |    71.57 |    74.81 |      75.06 |    75.08 |
|       50000 |  199.9 ms |            250,082 |    95.78 |   157.63 |   168.35 |     168.43 |   168.45 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.6 ms |             68,430 |     6.79 |     9.88 |    11.37 |      11.65 |    11.65 |
|        5000 |   51.0 ms |             98,093 |    24.44 |    39.13 |    40.05 |      40.07 |    40.07 |
|       10000 |  107.9 ms |             92,640 |    54.20 |    89.63 |    91.96 |      93.97 |    94.09 |
|       25000 |  311.8 ms |             80,172 |   143.34 |   254.98 |   275.70 |     278.39 |   278.60 |
|       50000 |  545.7 ms |             91,626 |   275.00 |   444.83 |   480.45 |     484.12 |   486.37 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   35.0 ms |             28,605 |    15.11 |    28.12 |    32.94 |      33.63 |    33.63 |
|        5000 |  149.3 ms |             33,489 |    80.13 |   133.40 |   144.86 |     146.50 |   146.68 |
|       10000 |  279.4 ms |             35,792 |   138.81 |   240.91 |   267.61 |     272.18 |   272.56 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 186.3 MB
  • Settled Cooldown RSS   : 75.9 MB (Clean GC release)

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

  * Yatta   :  43,244 req/s | avg 2.31ms | p99 5.09ms
  * Express :  13,443 req/s | avg 7.43ms | p99 12.32ms
  * Fastify :  20,725 req/s | avg 4.82ms | p99 9.63ms
  * Hono    :  50,251 req/s | avg 1.99ms | p99 4.64ms
  * Elysia  :  44,336 req/s | avg 2.25ms | p99 5.89ms
  * Koa     :  14,266 req/s | avg 7.00ms | p99 12.14ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      43,244 | 1.00x |      2.31ms | 2.22ms | 4.34ms | 5.09ms |
| Express   |      13,443 | 0.31x |      7.43ms | 7.82ms | 10.98ms | 12.32ms |
| Fastify   |      20,725 | 0.48x |      4.82ms | 4.24ms | 8.34ms | 9.63ms |
| Hono      |      50,251 | 1.16x |      1.99ms | 2.03ms | 3.54ms | 4.64ms |
| Elysia    |      44,336 | 1.03x |      2.25ms | 1.98ms | 4.54ms | 5.89ms |
| Koa       |      14,266 | 0.33x |      7.00ms | 6.95ms | 11.14ms | 12.14ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
