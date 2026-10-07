# Yatta Benchmarks

> Last run: `2026-10-07T01:49:50Z` · commit [`3539c67`](https://github.com/psrockstar098/yatta.js/commit/3539c67efb146ad7b6296045f651c65049f89120) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 110.3 ms
  • End-to-End Runtime Task Cost    : 0.0349 ms/op
  • Peak RSS Memory        : 168.5 MB
  • RSS Heap Memory             : 75.67 MB
  • Raw Worker IPC Round-Trip      : 0.0308 ms/op
  • Scheduler + Graph Overhead     : 0.0041 ms/op
  • Settled Cooldown RSS   : 72.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.75 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive):

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      36,595 | 1.00x |      2.73ms | 2.94ms | 4.65ms | 7.08ms |
| Express   |      20,874 | 0.57x |      4.78ms | 4.48ms | 7.98ms | 10.11ms |
| Fastify   |      24,318 | 0.66x |      4.11ms | 4.08ms | 6.80ms | 9.15ms |
| Hono      |      48,187 | 1.32x |      2.07ms | 2.19ms | 3.03ms | 4.15ms |
| Elysia    |      36,625 | 1.00x |      2.72ms | 2.36ms | 5.06ms | 6.24ms |
| Koa       |      20,064 | 0.55x |      4.98ms | 4.76ms | 8.13ms | 9.16ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,694 |       0.35 |       0.36 |       0.36 |       0.36 |
|         100 |     0.7 ms |              140,901 |       0.29 |       0.42 |       0.44 |       0.44 |
|         500 |     2.2 ms |              224,477 |       0.96 |       1.33 |       1.34 |       1.34 |
|        1000 |     3.7 ms |              269,675 |       1.81 |       2.68 |       2.73 |       2.76 |
|        5000 |    24.4 ms |              204,802 |      13.65 |      17.93 |      18.02 |      18.07 |
|       10000 |    46.1 ms |              216,997 |      24.58 |      36.39 |      37.35 |      37.37 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.6 ms |             94,668 |     5.03 |     6.57 |     6.79 |       6.82 |     6.82 |
|        5000 |   23.9 ms |            209,020 |    10.38 |    13.82 |    14.34 |      14.36 |    14.37 |
|       10000 |   44.8 ms |            223,405 |    22.23 |    33.14 |    34.53 |      34.62 |    34.63 |
|       25000 |  105.7 ms |            236,445 |    50.93 |    77.32 |    81.77 |      81.81 |    81.82 |
|       50000 |  192.3 ms |            259,996 |    95.54 |   152.37 |   161.65 |     162.00 |   162.05 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.0 ms |             83,073 |     5.91 |     8.62 |     9.69 |       9.81 |     9.81 |
|        5000 |   36.4 ms |            137,350 |    19.86 |    28.45 |    29.39 |      29.44 |    29.45 |
|       10000 |   90.7 ms |            110,223 |    47.10 |    77.62 |    80.58 |      80.67 |    80.68 |
|       25000 |  232.0 ms |            107,766 |   119.53 |   194.31 |   205.44 |     206.15 |   206.17 |
|       50000 |  486.9 ms |            102,683 |   230.82 |   419.19 |   454.40 |     455.58 |   455.64 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.3 ms |             30,003 |    13.87 |    28.92 |    31.97 |      32.29 |    32.29 |
|        5000 |  142.2 ms |             35,151 |    55.99 |   124.16 |   137.20 |     138.77 |   138.91 |
|       10000 |  212.0 ms |             47,177 |   104.41 |   183.29 |   205.15 |     207.13 |   207.44 |

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
  • Raw Worker IPC Round-Trip      : 0.0308 ms/op
  • End-to-End Runtime Task Cost    : 0.0349 ms/op
  • Scheduler + Graph Overhead     : 0.0041 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,694 |       0.35 |       0.36 |       0.36 |       0.36 |
|         100 |     0.7 ms |              140,901 |       0.29 |       0.42 |       0.44 |       0.44 |
|         500 |     2.2 ms |              224,477 |       0.96 |       1.33 |       1.34 |       1.34 |
|        1000 |     3.7 ms |              269,675 |       1.81 |       2.68 |       2.73 |       2.76 |
|        5000 |    24.4 ms |              204,802 |      13.65 |      17.93 |      18.02 |      18.07 |
|       10000 |    46.1 ms |              216,997 |      24.58 |      36.39 |      37.35 |      37.37 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 75.67 MB
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
| 1 CPU + 1 IO  |       2 |   51.8 ms |            193,002 |    23.87 |    39.03 |    41.35 |    41.43 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   44.1 ms |            226,501 |    24.93 |    32.07 |    33.33 |    33.36 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   38.1 ms |            262,278 |    22.25 |    31.14 |    31.39 |    31.67 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.5 ms |            246,846 |    21.52 |    33.44 |    33.62 |    33.64 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
[ModuleGraph] Bun.ModuleGraph is unavailable: graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 110.3 ms
  • Peak Throughput Rate       : 226,753 ops/sec
  • Latency Distribution       : p50: 54.92ms | p90: 90.66ms | p99: 92.06ms | p99.9: 92.39ms | Max: 92.47ms
  • Memory (RSS)               : Baseline: 109.4 MB | Peak: 127.8 MB | Cooldown: 101.6 MB

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
|        1000 |   10.6 ms |             94,668 |     5.03 |     6.57 |     6.79 |       6.82 |     6.82 |
|        5000 |   23.9 ms |            209,020 |    10.38 |    13.82 |    14.34 |      14.36 |    14.37 |
|       10000 |   44.8 ms |            223,405 |    22.23 |    33.14 |    34.53 |      34.62 |    34.63 |
|       25000 |  105.7 ms |            236,445 |    50.93 |    77.32 |    81.77 |      81.81 |    81.82 |
|       50000 |  192.3 ms |            259,996 |    95.54 |   152.37 |   161.65 |     162.00 |   162.05 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.0 ms |             83,073 |     5.91 |     8.62 |     9.69 |       9.81 |     9.81 |
|        5000 |   36.4 ms |            137,350 |    19.86 |    28.45 |    29.39 |      29.44 |    29.45 |
|       10000 |   90.7 ms |            110,223 |    47.10 |    77.62 |    80.58 |      80.67 |    80.68 |
|       25000 |  232.0 ms |            107,766 |   119.53 |   194.31 |   205.44 |     206.15 |   206.17 |
|       50000 |  486.9 ms |            102,683 |   230.82 |   419.19 |   454.40 |     455.58 |   455.64 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   33.3 ms |             30,003 |    13.87 |    28.92 |    31.97 |      32.29 |    32.29 |
|        5000 |  142.2 ms |             35,151 |    55.99 |   124.16 |   137.20 |     138.77 |   138.91 |
|       10000 |  212.0 ms |             47,177 |   104.41 |   183.29 |   205.15 |     207.13 |   207.44 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 168.5 MB
  • Settled Cooldown RSS   : 72.7 MB (Clean GC release)

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

  * Yatta   :  36,595 req/s | avg 2.73ms | p99 7.08ms
  * Express :  20,874 req/s | avg 4.78ms | p99 10.11ms
  * Fastify :  24,318 req/s | avg 4.11ms | p99 9.15ms
  * Hono    :  48,187 req/s | avg 2.07ms | p99 4.15ms
  * Elysia  :  36,625 req/s | avg 2.72ms | p99 6.24ms
  * Koa     :  20,064 req/s | avg 4.98ms | p99 9.16ms

| Framework | Requests/sec | vs Yatta | Avg latency | p50 | p95 | p99 |
|-----------|-------------:|---------:|------------:|----:|----:|----:|
| Yatta     |      36,595 | 1.00x |      2.73ms | 2.94ms | 4.65ms | 7.08ms |
| Express   |      20,874 | 0.57x |      4.78ms | 4.48ms | 7.98ms | 10.11ms |
| Fastify   |      24,318 | 0.66x |      4.11ms | 4.08ms | 6.80ms | 9.15ms |
| Hono      |      48,187 | 1.32x |      2.07ms | 2.19ms | 3.03ms | 4.15ms |
| Elysia    |      36,625 | 1.00x |      2.72ms | 2.36ms | 5.06ms | 6.24ms |
| Koa       |      20,064 | 0.55x |      4.98ms | 4.76ms | 8.13ms | 9.16ms |

   COMPARISON BENCHMARK COMPLETE
=======================================================

Wrote /tmp/bench/comparison.json
```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
