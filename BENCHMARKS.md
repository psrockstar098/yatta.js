# Yatta Benchmarks

> Last run: `2026-10-07T02:20:19Z` · commit [`b0c316c`](https://github.com/psrockstar098/yatta.js/commit/b0c316c4e02b35a66a9ac99af05287cdd75afeb0) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 105.4 ms
  • End-to-End Runtime Task Cost    : 0.0570 ms/op
  • Peak RSS Memory        : 211.1 MB
  • RSS Heap Memory             : 79.92 MB
  • Raw Worker IPC Round-Trip      : 0.0378 ms/op
  • Scheduler + Graph Overhead     : 0.0192 ms/op
  • Settled Cooldown RSS   : 73.0 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      34,609 | 1.00x |      2.89ms | 2.38ms | 4.74ms | 5.60ms |
| Express   |      15,133 | 0.44x |      6.59ms | 6.08ms | 10.88ms | 12.34ms |
| Fastify   |      18,741 | 0.54x |      5.33ms | 5.01ms | 8.90ms | 10.14ms |
| Hono      |      38,200 | 1.10x |      2.61ms | 2.29ms | 4.19ms | 5.33ms |
| Elysia    |      41,479 | 1.20x |      2.41ms | 2.30ms | 4.32ms | 5.17ms |
| Koa       |      14,112 | 0.41x |      7.07ms | 6.80ms | 11.17ms | 12.00ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,422 |       0.49 |       0.51 |       0.51 |       0.51 |
|         100 |     0.9 ms |              111,562 |       0.40 |       0.46 |       0.49 |       0.49 |
|         500 |     3.0 ms |              167,852 |       1.33 |       1.70 |       1.80 |       1.84 |
|        1000 |     5.1 ms |              195,961 |       2.52 |       3.42 |       3.56 |       3.61 |
|        5000 |    27.9 ms |              179,109 |      13.80 |      18.42 |      18.69 |      18.93 |
|       10000 |    54.0 ms |              185,215 |      25.07 |      44.81 |      45.11 |      45.24 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.9 ms |            126,169 |     3.52 |     4.78 |     5.85 |       6.00 |     6.00 |
|        5000 |   20.1 ms |            248,654 |     8.14 |    12.61 |    13.45 |      13.45 |    13.46 |
|       10000 |   44.5 ms |            224,879 |    24.23 |    34.63 |    35.38 |      35.40 |    35.40 |
|       25000 |  114.5 ms |            218,293 |    52.54 |    86.58 |    90.88 |      91.03 |    91.03 |
|       50000 |  217.7 ms |            229,655 |   108.24 |   165.74 |   173.24 |     176.05 |   176.26 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.4 ms |             69,218 |     7.32 |    11.00 |    12.45 |      12.61 |    12.61 |
|        5000 |   56.7 ms |             88,131 |    30.37 |    44.38 |    45.42 |      45.43 |    45.43 |
|       10000 |  104.5 ms |             95,690 |    49.72 |    81.39 |    90.45 |      90.54 |    90.56 |
|       25000 |  304.9 ms |             81,990 |   144.02 |   258.47 |   277.38 |     279.80 |   280.19 |
|       50000 |  570.4 ms |             87,653 |   287.66 |   485.33 |   526.00 |     526.75 |   526.80 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.1 ms |             27,666 |    18.79 |    29.60 |    34.84 |      35.32 |    35.32 |
|        5000 |  147.1 ms |             34,000 |    70.48 |   119.91 |   141.11 |     143.20 |   143.37 |
|       10000 |  280.5 ms |             35,653 |   132.64 |   232.05 |   271.04 |     275.66 |   276.11 |

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
  • Raw Worker IPC Round-Trip      : 0.0378 ms/op
  • End-to-End Runtime Task Cost    : 0.0570 ms/op
  • Scheduler + Graph Overhead     : 0.0192 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               11,422 |       0.49 |       0.51 |       0.51 |       0.51 |
|         100 |     0.9 ms |              111,562 |       0.40 |       0.46 |       0.49 |       0.49 |
|         500 |     3.0 ms |              167,852 |       1.33 |       1.70 |       1.80 |       1.84 |
|        1000 |     5.1 ms |              195,961 |       2.52 |       3.42 |       3.56 |       3.61 |
|        5000 |    27.9 ms |              179,109 |      13.80 |      18.42 |      18.69 |      18.93 |
|       10000 |    54.0 ms |              185,215 |      25.07 |      44.81 |      45.11 |      45.24 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 79.92 MB
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
| 1 CPU + 1 IO  |       2 |   58.9 ms |            169,787 |    28.66 |    46.19 |    48.00 |    48.06 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   52.6 ms |            190,145 |    27.28 |    40.05 |    40.11 |    40.14 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   36.3 ms |            275,360 |    20.30 |    29.21 |    30.16 |    30.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.6 ms |            246,315 |    21.19 |    30.73 |    31.00 |    31.03 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 105.4 ms
  • Peak Throughput Rate       : 237,263 ops/sec
  • Latency Distribution       : p50: 51.29ms | p90: 83.91ms | p99: 85.00ms | p99.9: 85.61ms | Max: 85.68ms
  • Memory (RSS)               : Baseline: 110.4 MB | Peak: 131.5 MB | Cooldown: 105.6 MB

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
|        1000 |    7.9 ms |            126,169 |     3.52 |     4.78 |     5.85 |       6.00 |     6.00 |
|        5000 |   20.1 ms |            248,654 |     8.14 |    12.61 |    13.45 |      13.45 |    13.46 |
|       10000 |   44.5 ms |            224,879 |    24.23 |    34.63 |    35.38 |      35.40 |    35.40 |
|       25000 |  114.5 ms |            218,293 |    52.54 |    86.58 |    90.88 |      91.03 |    91.03 |
|       50000 |  217.7 ms |            229,655 |   108.24 |   165.74 |   173.24 |     176.05 |   176.26 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.4 ms |             69,218 |     7.32 |    11.00 |    12.45 |      12.61 |    12.61 |
|        5000 |   56.7 ms |             88,131 |    30.37 |    44.38 |    45.42 |      45.43 |    45.43 |
|       10000 |  104.5 ms |             95,690 |    49.72 |    81.39 |    90.45 |      90.54 |    90.56 |
|       25000 |  304.9 ms |             81,990 |   144.02 |   258.47 |   277.38 |     279.80 |   280.19 |
|       50000 |  570.4 ms |             87,653 |   287.66 |   485.33 |   526.00 |     526.75 |   526.80 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.1 ms |             27,666 |    18.79 |    29.60 |    34.84 |      35.32 |    35.32 |
|        5000 |  147.1 ms |             34,000 |    70.48 |   119.91 |   141.11 |     143.20 |   143.37 |
|       10000 |  280.5 ms |             35,653 |   132.64 |   232.05 |   271.04 |     275.66 |   276.11 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 211.1 MB
  • Settled Cooldown RSS   : 73.0 MB (Clean GC release)

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

  * Yatta   :  34,609 req/s | avg 2.89ms | p99 5.60ms
  * Express :  15,133 req/s | avg 6.59ms | p99 12.34ms
  * Fastify :  18,741 req/s | avg 5.33ms | p99 10.14ms
  * Hono    :  38,200 req/s | avg 2.61ms | p99 5.33ms
  * Elysia  :  41,479 req/s | avg 2.41ms | p99 5.17ms
  * Koa     :  14,112 req/s | avg 7.07ms | p99 12.00ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      34,609 | 1.00x |      2.89ms | 2.38ms | 4.74ms | 5.60ms |
| Express   |      15,133 | 0.44x |      6.59ms | 6.08ms | 10.88ms | 12.34ms |
| Fastify   |      18,741 | 0.54x |      5.33ms | 5.01ms | 8.90ms | 10.14ms |
| Hono      |      38,200 | 1.10x |      2.61ms | 2.29ms | 4.19ms | 5.33ms |
| Elysia    |      41,479 | 1.20x |      2.41ms | 2.30ms | 4.32ms | 5.17ms |
| Koa       |      14,112 | 0.41x |      7.07ms | 6.80ms | 11.17ms | 12.00ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
