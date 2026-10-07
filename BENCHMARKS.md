# Yatta Benchmarks

> Last run: `2026-10-07T00:32:53Z` · commit [`dd6459f`](https://github.com/psrockstar098/yatta.js/commit/dd6459fa0b719346676f241908dab07b0eb65041) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 129.6 ms
  • End-to-End Runtime Task Cost    : 0.0473 ms/op
  • Peak RSS Memory        : 187.4 MB
  • RSS Heap Memory             : 77.43 MB
  • Raw Worker IPC Round-Trip      : 0.0401 ms/op
  • Scheduler + Graph Overhead     : 0.0072 ms/op
  • Settled Cooldown RSS   : 70.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      35,229 | 1.00x |      2.83ms | 2.41ms | 4.34ms | 5.21ms |
| Express   |      15,650 | 0.44x |      6.38ms | 5.87ms | 10.17ms | 11.49ms |
| Fastify   |      20,360 | 0.58x |      4.90ms | 4.43ms | 7.99ms | 8.63ms |
| Hono      |      42,123 | 1.20x |      2.37ms | 2.03ms | 4.18ms | 5.67ms |
| Elysia    |      51,635 | 1.47x |      1.93ms | 1.80ms | 2.98ms | 3.69ms |
| Koa       |      13,722 | 0.39x |      7.28ms | 8.15ms | 10.93ms | 12.41ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,898 |       0.38 |       0.40 |       0.40 |       0.40 |
|         100 |     0.7 ms |              136,938 |       0.28 |       0.45 |       0.49 |       0.49 |
|         500 |     1.9 ms |              264,250 |       0.87 |       1.31 |       1.36 |       1.41 |
|        1000 |     3.7 ms |              270,978 |       1.96 |       2.74 |       2.75 |       2.76 |
|        5000 |    24.0 ms |              208,340 |      13.28 |      17.08 |      17.14 |      17.15 |
|       10000 |    38.9 ms |              256,999 |      20.14 |      31.49 |      31.65 |      31.69 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            102,680 |     5.01 |     6.43 |     7.77 |       8.15 |     8.15 |
|        5000 |   25.9 ms |            192,935 |    11.36 |    15.29 |    16.01 |      16.14 |    16.16 |
|       10000 |   66.3 ms |            150,883 |    35.48 |    51.72 |    54.21 |      54.24 |    54.24 |
|       25000 |  123.6 ms |            202,302 |    66.33 |    91.37 |    94.66 |      95.15 |    95.20 |
|       50000 |  203.6 ms |            245,562 |   104.27 |   159.30 |   170.54 |     171.02 |   171.07 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.2 ms |             58,007 |    10.40 |    14.12 |    15.92 |      16.22 |    16.22 |
|        5000 |   54.0 ms |             92,642 |    27.30 |    41.17 |    42.20 |      42.25 |    42.25 |
|       10000 |  100.7 ms |             99,347 |    49.56 |    82.31 |    86.60 |      86.73 |    86.75 |
|       25000 |  281.9 ms |             88,697 |   136.40 |   237.79 |   253.60 |     253.98 |   254.00 |
|       50000 |  481.8 ms |            103,784 |   247.45 |   411.41 |   439.61 |     441.54 |   441.68 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.4 ms |             27,491 |    19.43 |    31.14 |    33.97 |      34.37 |    34.37 |
|        5000 |  148.6 ms |             33,650 |    79.93 |   132.44 |   144.58 |     146.15 |   146.30 |
|       10000 |  269.8 ms |             37,063 |   132.24 |   235.38 |   261.97 |     265.45 |   265.81 |

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
  • Raw Worker IPC Round-Trip      : 0.0401 ms/op
  • End-to-End Runtime Task Cost    : 0.0473 ms/op
  • Scheduler + Graph Overhead     : 0.0072 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,898 |       0.38 |       0.40 |       0.40 |       0.40 |
|         100 |     0.7 ms |              136,938 |       0.28 |       0.45 |       0.49 |       0.49 |
|         500 |     1.9 ms |              264,250 |       0.87 |       1.31 |       1.36 |       1.41 |
|        1000 |     3.7 ms |              270,978 |       1.96 |       2.74 |       2.75 |       2.76 |
|        5000 |    24.0 ms |              208,340 |      13.28 |      17.08 |      17.14 |      17.15 |
|       10000 |    38.9 ms |              256,999 |      20.14 |      31.49 |      31.65 |      31.69 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.43 MB
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
| 1 CPU + 1 IO  |       2 |   67.5 ms |            148,192 |    30.12 |    51.81 |    52.63 |    53.53 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   48.6 ms |            205,861 |    29.63 |    35.97 |    36.51 |    36.68 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   44.3 ms |            225,822 |    21.11 |    35.01 |    35.94 |    36.28 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   48.7 ms |            205,529 |    26.08 |    37.06 |    37.62 |    37.74 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 129.6 ms
  • Peak Throughput Rate       : 192,859 ops/sec
  • Latency Distribution       : p50: 60.29ms | p90: 105.44ms | p99: 107.00ms | p99.9: 107.06ms | Max: 107.07ms
  • Memory (RSS)               : Baseline: 99.1 MB | Peak: 130.9 MB | Cooldown: 101.3 MB

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
|        1000 |    9.7 ms |            102,680 |     5.01 |     6.43 |     7.77 |       8.15 |     8.15 |
|        5000 |   25.9 ms |            192,935 |    11.36 |    15.29 |    16.01 |      16.14 |    16.16 |
|       10000 |   66.3 ms |            150,883 |    35.48 |    51.72 |    54.21 |      54.24 |    54.24 |
|       25000 |  123.6 ms |            202,302 |    66.33 |    91.37 |    94.66 |      95.15 |    95.20 |
|       50000 |  203.6 ms |            245,562 |   104.27 |   159.30 |   170.54 |     171.02 |   171.07 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.2 ms |             58,007 |    10.40 |    14.12 |    15.92 |      16.22 |    16.22 |
|        5000 |   54.0 ms |             92,642 |    27.30 |    41.17 |    42.20 |      42.25 |    42.25 |
|       10000 |  100.7 ms |             99,347 |    49.56 |    82.31 |    86.60 |      86.73 |    86.75 |
|       25000 |  281.9 ms |             88,697 |   136.40 |   237.79 |   253.60 |     253.98 |   254.00 |
|       50000 |  481.8 ms |            103,784 |   247.45 |   411.41 |   439.61 |     441.54 |   441.68 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.4 ms |             27,491 |    19.43 |    31.14 |    33.97 |      34.37 |    34.37 |
|        5000 |  148.6 ms |             33,650 |    79.93 |   132.44 |   144.58 |     146.15 |   146.30 |
|       10000 |  269.8 ms |             37,063 |   132.24 |   235.38 |   261.97 |     265.45 |   265.81 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 187.4 MB
  • Settled Cooldown RSS   : 70.8 MB (Clean GC release)

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

  * Yatta   :  35,229 req/s | avg 2.83ms | p99 5.21ms
  * Express :  15,650 req/s | avg 6.38ms | p99 11.49ms
  * Fastify :  20,360 req/s | avg 4.90ms | p99 8.63ms
  * Hono    :  42,123 req/s | avg 2.37ms | p99 5.67ms
  * Elysia  :  51,635 req/s | avg 1.93ms | p99 3.69ms
  * Koa     :  13,722 req/s | avg 7.28ms | p99 12.41ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      35,229 | 1.00x |      2.83ms | 2.41ms | 4.34ms | 5.21ms |
| Express   |      15,650 | 0.44x |      6.38ms | 5.87ms | 10.17ms | 11.49ms |
| Fastify   |      20,360 | 0.58x |      4.90ms | 4.43ms | 7.99ms | 8.63ms |
| Hono      |      42,123 | 1.20x |      2.37ms | 2.03ms | 4.18ms | 5.67ms |
| Elysia    |      51,635 | 1.47x |      1.93ms | 1.80ms | 2.98ms | 3.69ms |
| Koa       |      13,722 | 0.39x |      7.28ms | 8.15ms | 10.93ms | 12.41ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
