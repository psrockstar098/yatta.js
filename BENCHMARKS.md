# Yatta Benchmarks

> Last run: `2026-11-05T03:32:57Z` · commit [`15f9bc9`](https://github.com/psrockstar098/yatta.js/commit/15f9bc96605fd2b0f1862d56f83c7551078c194a) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 105.2 ms
  • End-to-End Runtime Task Cost    : 0.0391 ms/op
  • Peak RSS Memory        : 149.0 MB
  • RSS Heap Memory             : 70.85 MB
  • Raw Worker IPC Round-Trip      : 0.0326 ms/op
  • Scheduler + Graph Overhead     : 0.0065 ms/op
  • Settled Cooldown RSS   : 76.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      43,545 |     1.00x |    24% | 2.27ms | 4.75ms | 5.46ms |
| Raw Bun   |      40,672 |     0.93x |    10% | 2.21ms | 4.70ms | 4.98ms |
| Hono      |      50,350 |     1.16x |     8% | 1.85ms | 3.50ms | 4.46ms |
| Elysia    |      42,264 |     0.97x |    20% | 2.15ms | 4.71ms | 4.80ms |
| Express   |      14,955 |     0.34x |     9% | 5.84ms | 9.84ms | 10.75ms |
| Fastify   |      20,461 |     0.47x |    11% | 4.23ms | 8.30ms | 9.70ms |
| Koa       |      15,457 |     0.35x |    12% | 6.47ms | 9.98ms | 10.95ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,096 |       0.41 |       0.43 |       0.43 |       0.43 |
|         100 |     1.4 ms |               70,623 |       0.32 |       0.75 |       0.76 |       0.76 |
|         500 |     1.9 ms |              257,647 |       0.92 |       1.45 |       1.52 |       1.56 |
|        1000 |     4.1 ms |              244,019 |       2.10 |       3.34 |       3.50 |       3.55 |
|        5000 |    27.0 ms |              185,129 |      16.48 |      19.73 |      19.82 |      19.84 |
|       10000 |    54.2 ms |              184,611 |      30.09 |      42.48 |      43.17 |      43.30 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.9 ms |            126,774 |     3.75 |     5.42 |     6.48 |       6.90 |     6.90 |
|        5000 |   22.3 ms |            224,643 |    10.84 |    14.41 |    14.91 |      14.94 |    14.94 |
|       10000 |   43.9 ms |            227,973 |    20.71 |    31.17 |    33.70 |      33.78 |    33.78 |
|       25000 |  101.8 ms |            245,638 |    53.09 |    73.09 |    75.67 |      76.07 |    76.12 |
|       50000 |  188.5 ms |            265,288 |    95.66 |   145.50 |   154.09 |     154.59 |   154.61 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             79,040 |     6.43 |     9.87 |    11.32 |      11.48 |    11.48 |
|        5000 |   51.0 ms |             97,982 |    23.30 |    37.91 |    38.89 |      38.94 |    38.94 |
|       10000 |   97.7 ms |            102,359 |    46.99 |    80.36 |    82.80 |      82.90 |    82.92 |
|       25000 |  249.5 ms |            100,194 |   122.95 |   216.09 |   228.84 |     229.36 |   229.37 |
|       50000 |  562.9 ms |             88,833 |   303.31 |   463.15 |   504.42 |     506.08 |   506.20 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   28.3 ms |             35,356 |    15.03 |    23.95 |    26.69 |      27.04 |    27.04 |
|        5000 |  118.9 ms |             42,056 |    67.42 |   104.26 |   113.05 |     114.75 |   114.88 |
|       10000 |  227.9 ms |             43,886 |   115.58 |   185.57 |   216.70 |     221.75 |   222.07 |

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
  • Raw Worker IPC Round-Trip      : 0.0326 ms/op
  • End-to-End Runtime Task Cost    : 0.0391 ms/op
  • Scheduler + Graph Overhead     : 0.0065 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,096 |       0.41 |       0.43 |       0.43 |       0.43 |
|         100 |     1.4 ms |               70,623 |       0.32 |       0.75 |       0.76 |       0.76 |
|         500 |     1.9 ms |              257,647 |       0.92 |       1.45 |       1.52 |       1.56 |
|        1000 |     4.1 ms |              244,019 |       2.10 |       3.34 |       3.50 |       3.55 |
|        5000 |    27.0 ms |              185,129 |      16.48 |      19.73 |      19.82 |      19.84 |
|       10000 |    54.2 ms |              184,611 |      30.09 |      42.48 |      43.17 |      43.30 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 70.85 MB
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
| 1 CPU + 1 IO  |       2 |   52.0 ms |            192,341 |    25.19 |    40.91 |    41.48 |    41.66 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   45.6 ms |            219,522 |    21.50 |    35.26 |    35.46 |    35.49 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   33.7 ms |            296,864 |    15.71 |    26.23 |    26.89 |    27.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   40.7 ms |            245,632 |    19.15 |    31.90 |    32.07 |    32.09 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 105.2 ms
  • Peak Throughput Rate       : 237,601 ops/sec
  • Latency Distribution       : p50: 51.91ms | p90: 85.30ms | p99: 86.15ms | p99.9: 86.41ms | Max: 86.41ms
  • Memory (RSS)               : Baseline: 101.3 MB | Peak: 128.9 MB | Cooldown: 102.4 MB

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
|        1000 |    7.9 ms |            126,774 |     3.75 |     5.42 |     6.48 |       6.90 |     6.90 |
|        5000 |   22.3 ms |            224,643 |    10.84 |    14.41 |    14.91 |      14.94 |    14.94 |
|       10000 |   43.9 ms |            227,973 |    20.71 |    31.17 |    33.70 |      33.78 |    33.78 |
|       25000 |  101.8 ms |            245,638 |    53.09 |    73.09 |    75.67 |      76.07 |    76.12 |
|       50000 |  188.5 ms |            265,288 |    95.66 |   145.50 |   154.09 |     154.59 |   154.61 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             79,040 |     6.43 |     9.87 |    11.32 |      11.48 |    11.48 |
|        5000 |   51.0 ms |             97,982 |    23.30 |    37.91 |    38.89 |      38.94 |    38.94 |
|       10000 |   97.7 ms |            102,359 |    46.99 |    80.36 |    82.80 |      82.90 |    82.92 |
|       25000 |  249.5 ms |            100,194 |   122.95 |   216.09 |   228.84 |     229.36 |   229.37 |
|       50000 |  562.9 ms |             88,833 |   303.31 |   463.15 |   504.42 |     506.08 |   506.20 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   28.3 ms |             35,356 |    15.03 |    23.95 |    26.69 |      27.04 |    27.04 |
|        5000 |  118.9 ms |             42,056 |    67.42 |   104.26 |   113.05 |     114.75 |   114.88 |
|       10000 |  227.9 ms |             43,886 |   115.58 |   185.57 |   216.70 |     221.75 |   222.07 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 149.0 MB
  • Settled Cooldown RSS   : 76.9 MB (Clean GC release)

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
| Yatta     |      43,545 |     1.00x |    24% | 2.27ms | 4.75ms | 5.46ms |
| Raw Bun   |      40,672 |     0.93x |    10% | 2.21ms | 4.70ms | 4.98ms |
| Hono      |      50,350 |     1.16x |     8% | 1.85ms | 3.50ms | 4.46ms |
| Elysia    |      42,264 |     0.97x |    20% | 2.15ms | 4.71ms | 4.80ms |
| Express   |      14,955 |     0.34x |     9% | 5.84ms | 9.84ms | 10.75ms |
| Fastify   |      20,461 |     0.47x |    11% | 4.23ms | 8.30ms | 9.70ms |
| Koa       |      15,457 |     0.35x |    12% | 6.47ms | 9.98ms | 10.95ms |

  Yatta dispatch adds about -1.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 24%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
