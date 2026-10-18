# Yatta Benchmarks

> Last run: `2026-10-18T03:34:10Z` · commit [`aa890f0`](https://github.com/psrockstar098/yatta.js/commit/aa890f0e0a1c7b8fff290aa9d7afa6acfb1ad59b) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 109.4 ms
  • End-to-End Runtime Task Cost    : 0.0522 ms/op
  • Peak RSS Memory        : 211.5 MB
  • RSS Heap Memory             : 77.58 MB
  • Raw Worker IPC Round-Trip      : 0.0395 ms/op
  • Scheduler + Graph Overhead     : 0.0127 ms/op
  • Settled Cooldown RSS   : 72.8 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      39,181 |     1.00x |    15% | 2.31ms | 4.46ms | 4.73ms |
| Raw Bun   |      48,471 |     1.24x |     7% | 1.85ms | 3.59ms | 4.75ms |
| Hono      |      45,163 |     1.15x |    20% | 2.08ms | 4.15ms | 4.74ms |
| Elysia    |      52,929 |     1.35x |     7% | 1.75ms | 3.10ms | 4.69ms |
| Express   |      14,750 |     0.38x |     9% | 6.24ms | 10.90ms | 12.00ms |
| Fastify   |      18,947 |     0.48x |    10% | 4.42ms | 8.29ms | 9.94ms |
| Koa       |      15,389 |     0.39x |     2% | 6.09ms | 10.44ms | 12.19ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,851 |       0.41 |       0.42 |       0.42 |       0.42 |
|         100 |     0.7 ms |              142,747 |       0.29 |       0.51 |       0.54 |       0.54 |
|         500 |     2.3 ms |              216,471 |       1.18 |       1.85 |       1.97 |       2.00 |
|        1000 |     4.2 ms |              237,657 |       2.24 |       3.46 |       3.62 |       3.67 |
|        5000 |    23.8 ms |              210,099 |      12.83 |      16.69 |      16.78 |      16.78 |
|       10000 |    39.1 ms |              255,702 |      18.98 |      31.00 |      31.70 |      31.73 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.3 ms |             81,080 |     6.23 |     8.06 |    10.26 |      10.73 |    10.73 |
|        5000 |   29.0 ms |            172,269 |    13.36 |    18.99 |    19.53 |      19.54 |    19.54 |
|       10000 |   59.4 ms |            168,285 |    31.00 |    45.96 |    48.23 |      48.36 |    48.38 |
|       25000 |  118.8 ms |            210,403 |    62.32 |    84.16 |    88.66 |      88.70 |    88.71 |
|       50000 |  219.3 ms |            228,011 |   117.91 |   176.03 |   185.94 |     186.31 |   186.33 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,346 |     7.03 |    10.31 |    11.55 |      11.68 |    11.68 |
|        5000 |   51.8 ms |             96,598 |    26.14 |    39.40 |    40.69 |      41.15 |    41.18 |
|       10000 |  117.8 ms |             84,916 |    60.34 |    96.88 |   103.59 |     103.78 |   103.81 |
|       25000 |  300.7 ms |             83,140 |   163.59 |   262.89 |   275.51 |     278.00 |   278.26 |
|       50000 |  583.5 ms |             85,694 |   312.22 |   492.15 |   531.15 |     537.17 |   537.33 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   38.0 ms |             26,314 |    22.20 |    32.41 |    36.38 |      36.80 |    36.80 |
|        5000 |  159.6 ms |             31,337 |    80.58 |   134.22 |   153.78 |     155.89 |   156.08 |
|       10000 |  294.5 ms |             33,954 |   148.06 |   246.76 |   281.90 |     287.98 |   288.41 |

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
  • Raw Worker IPC Round-Trip      : 0.0395 ms/op
  • End-to-End Runtime Task Cost    : 0.0522 ms/op
  • Scheduler + Graph Overhead     : 0.0127 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,851 |       0.41 |       0.42 |       0.42 |       0.42 |
|         100 |     0.7 ms |              142,747 |       0.29 |       0.51 |       0.54 |       0.54 |
|         500 |     2.3 ms |              216,471 |       1.18 |       1.85 |       1.97 |       2.00 |
|        1000 |     4.2 ms |              237,657 |       2.24 |       3.46 |       3.62 |       3.67 |
|        5000 |    23.8 ms |              210,099 |      12.83 |      16.69 |      16.78 |      16.78 |
|       10000 |    39.1 ms |              255,702 |      18.98 |      31.00 |      31.70 |      31.73 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.58 MB
  • V8/JSC Heap Used             : 0.78 MB

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
| 1 CPU + 1 IO  |       2 |   57.0 ms |            175,295 |    29.87 |    45.28 |    46.39 |    46.55 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   49.2 ms |            203,389 |    22.61 |    37.65 |    37.96 |    37.99 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   38.4 ms |            260,513 |    19.65 |    27.93 |    28.31 |    28.40 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   42.6 ms |            234,550 |    20.99 |    33.55 |    33.91 |    33.98 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 109.4 ms
  • Peak Throughput Rate       : 228,539 ops/sec
  • Latency Distribution       : p50: 56.23ms | p90: 87.24ms | p99: 89.91ms | p99.9: 89.98ms | Max: 89.99ms
  • Memory (RSS)               : Baseline: 103.2 MB | Peak: 127.5 MB | Cooldown: 101.8 MB

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
|        1000 |   12.3 ms |             81,080 |     6.23 |     8.06 |    10.26 |      10.73 |    10.73 |
|        5000 |   29.0 ms |            172,269 |    13.36 |    18.99 |    19.53 |      19.54 |    19.54 |
|       10000 |   59.4 ms |            168,285 |    31.00 |    45.96 |    48.23 |      48.36 |    48.38 |
|       25000 |  118.8 ms |            210,403 |    62.32 |    84.16 |    88.66 |      88.70 |    88.71 |
|       50000 |  219.3 ms |            228,011 |   117.91 |   176.03 |   185.94 |     186.31 |   186.33 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   15.1 ms |             66,346 |     7.03 |    10.31 |    11.55 |      11.68 |    11.68 |
|        5000 |   51.8 ms |             96,598 |    26.14 |    39.40 |    40.69 |      41.15 |    41.18 |
|       10000 |  117.8 ms |             84,916 |    60.34 |    96.88 |   103.59 |     103.78 |   103.81 |
|       25000 |  300.7 ms |             83,140 |   163.59 |   262.89 |   275.51 |     278.00 |   278.26 |
|       50000 |  583.5 ms |             85,694 |   312.22 |   492.15 |   531.15 |     537.17 |   537.33 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   38.0 ms |             26,314 |    22.20 |    32.41 |    36.38 |      36.80 |    36.80 |
|        5000 |  159.6 ms |             31,337 |    80.58 |   134.22 |   153.78 |     155.89 |   156.08 |
|       10000 |  294.5 ms |             33,954 |   148.06 |   246.76 |   281.90 |     287.98 |   288.41 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 211.5 MB
  • Settled Cooldown RSS   : 72.8 MB (Clean GC release)

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
| Yatta     |      39,181 |     1.00x |    15% | 2.31ms | 4.46ms | 4.73ms |
| Raw Bun   |      48,471 |     1.24x |     7% | 1.85ms | 3.59ms | 4.75ms |
| Hono      |      45,163 |     1.15x |    20% | 2.08ms | 4.15ms | 4.74ms |
| Elysia    |      52,929 |     1.35x |     7% | 1.75ms | 3.10ms | 4.69ms |
| Express   |      14,750 |     0.38x |     9% | 6.24ms | 10.90ms | 12.00ms |
| Fastify   |      18,947 |     0.48x |    10% | 4.42ms | 8.29ms | 9.94ms |
| Koa       |      15,389 |     0.39x |     2% | 6.09ms | 10.44ms | 12.19ms |

  Yatta dispatch adds about 4.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
