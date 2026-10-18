# Yatta Benchmarks

> Last run: `2026-10-18T00:34:34Z` · commit [`f2c3d51`](https://github.com/psrockstar098/yatta.js/commit/f2c3d511c0fc0e4faf58a8853ea0e99047fe4817) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 100.6 ms
  • End-to-End Runtime Task Cost    : 0.0577 ms/op
  • Peak RSS Memory        : 211.1 MB
  • RSS Heap Memory             : 76.77 MB
  • Raw Worker IPC Round-Trip      : 0.0398 ms/op
  • Scheduler + Graph Overhead     : 0.0179 ms/op
  • Settled Cooldown RSS   : 78.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      42,439 |     1.00x |    23% | 2.25ms | 4.34ms | 4.94ms |
| Raw Bun   |      46,986 |     1.11x |     4% | 2.02ms | 4.73ms | 5.20ms |
| Hono      |      42,362 |     1.00x |    14% | 2.38ms | 3.59ms | 3.90ms |
| Elysia    |      48,469 |     1.14x |     4% | 1.81ms | 3.74ms | 4.97ms |
| Express   |      15,085 |     0.36x |     5% | 5.69ms | 11.05ms | 12.61ms |
| Fastify   |      20,624 |     0.49x |     1% | 4.21ms | 8.29ms | 9.07ms |
| Koa       |      16,054 |     0.38x |     7% | 6.82ms | 10.14ms | 12.05ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,149 |       0.35 |       0.37 |       0.37 |       0.37 |
|         100 |     0.8 ms |              127,777 |       0.36 |       0.46 |       0.48 |       0.48 |
|         500 |     2.0 ms |              244,040 |       0.99 |       1.61 |       1.69 |       1.73 |
|        1000 |     3.9 ms |              259,680 |       2.00 |       2.83 |       2.85 |       2.87 |
|        5000 |    24.0 ms |              207,990 |      13.23 |      17.02 |      17.12 |      17.14 |
|       10000 |    39.2 ms |              255,096 |      20.27 |      30.01 |      30.51 |      30.67 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.9 ms |            100,640 |     4.14 |     6.17 |     8.55 |       8.96 |     8.96 |
|        5000 |   22.5 ms |            222,114 |    11.03 |    15.33 |    15.79 |      15.83 |    15.83 |
|       10000 |   46.6 ms |            214,647 |    22.64 |    34.77 |    37.20 |      37.24 |    37.24 |
|       25000 |  103.7 ms |            241,126 |    49.64 |    73.82 |    77.14 |      77.21 |    77.22 |
|       50000 |  198.4 ms |            252,051 |   102.38 |   156.04 |   168.51 |     168.55 |   168.56 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.9 ms |             77,392 |     5.60 |     8.73 |    10.21 |      10.52 |    10.52 |
|        5000 |   36.6 ms |            136,769 |    18.00 |    28.08 |    29.05 |      29.11 |    29.12 |
|       10000 |   80.8 ms |            123,785 |    41.02 |    63.40 |    65.42 |      65.44 |    65.44 |
|       25000 |  274.5 ms |             91,061 |   140.25 |   238.28 |   255.15 |     255.44 |   255.45 |
|       50000 |  574.2 ms |             87,083 |   324.99 |   497.60 |   530.42 |     531.34 |   531.50 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   38.0 ms |             26,300 |    20.88 |    33.97 |    36.66 |      37.10 |    37.10 |
|        5000 |  147.4 ms |             33,918 |    67.47 |   116.33 |   141.40 |     143.58 |   143.74 |
|       10000 |  274.6 ms |             36,419 |   132.13 |   240.03 |   267.29 |     269.33 |   269.80 |

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
  • Raw Worker IPC Round-Trip      : 0.0398 ms/op
  • End-to-End Runtime Task Cost    : 0.0577 ms/op
  • Scheduler + Graph Overhead     : 0.0179 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               14,149 |       0.35 |       0.37 |       0.37 |       0.37 |
|         100 |     0.8 ms |              127,777 |       0.36 |       0.46 |       0.48 |       0.48 |
|         500 |     2.0 ms |              244,040 |       0.99 |       1.61 |       1.69 |       1.73 |
|        1000 |     3.9 ms |              259,680 |       2.00 |       2.83 |       2.85 |       2.87 |
|        5000 |    24.0 ms |              207,990 |      13.23 |      17.02 |      17.12 |      17.14 |
|       10000 |    39.2 ms |              255,096 |      20.27 |      30.01 |      30.51 |      30.67 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.12 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 76.77 MB
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
| 1 CPU + 1 IO  |       2 |   60.2 ms |            166,219 |    27.86 |    46.62 |    47.74 |    47.81 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   43.7 ms |            228,962 |    21.99 |    34.65 |    34.88 |    34.92 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   37.3 ms |            268,140 |    16.91 |    30.03 |    30.84 |    31.04 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   43.7 ms |            228,834 |    23.34 |    34.03 |    34.13 |    34.15 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 100.6 ms
  • Peak Throughput Rate       : 248,522 ops/sec
  • Latency Distribution       : p50: 48.86ms | p90: 79.84ms | p99: 81.94ms | p99.9: 82.17ms | Max: 82.21ms
  • Memory (RSS)               : Baseline: 94.4 MB | Peak: 129.6 MB | Cooldown: 102.3 MB

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
|        1000 |    9.9 ms |            100,640 |     4.14 |     6.17 |     8.55 |       8.96 |     8.96 |
|        5000 |   22.5 ms |            222,114 |    11.03 |    15.33 |    15.79 |      15.83 |    15.83 |
|       10000 |   46.6 ms |            214,647 |    22.64 |    34.77 |    37.20 |      37.24 |    37.24 |
|       25000 |  103.7 ms |            241,126 |    49.64 |    73.82 |    77.14 |      77.21 |    77.22 |
|       50000 |  198.4 ms |            252,051 |   102.38 |   156.04 |   168.51 |     168.55 |   168.56 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.9 ms |             77,392 |     5.60 |     8.73 |    10.21 |      10.52 |    10.52 |
|        5000 |   36.6 ms |            136,769 |    18.00 |    28.08 |    29.05 |      29.11 |    29.12 |
|       10000 |   80.8 ms |            123,785 |    41.02 |    63.40 |    65.42 |      65.44 |    65.44 |
|       25000 |  274.5 ms |             91,061 |   140.25 |   238.28 |   255.15 |     255.44 |   255.45 |
|       50000 |  574.2 ms |             87,083 |   324.99 |   497.60 |   530.42 |     531.34 |   531.50 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   38.0 ms |             26,300 |    20.88 |    33.97 |    36.66 |      37.10 |    37.10 |
|        5000 |  147.4 ms |             33,918 |    67.47 |   116.33 |   141.40 |     143.58 |   143.74 |
|       10000 |  274.6 ms |             36,419 |   132.13 |   240.03 |   267.29 |     269.33 |   269.80 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 211.1 MB
  • Settled Cooldown RSS   : 78.1 MB (Clean GC release)

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
| Yatta     |      42,439 |     1.00x |    23% | 2.25ms | 4.34ms | 4.94ms |
| Raw Bun   |      46,986 |     1.11x |     4% | 2.02ms | 4.73ms | 5.20ms |
| Hono      |      42,362 |     1.00x |    14% | 2.38ms | 3.59ms | 3.90ms |
| Elysia    |      48,469 |     1.14x |     4% | 1.81ms | 3.74ms | 4.97ms |
| Express   |      15,085 |     0.36x |     5% | 5.69ms | 11.05ms | 12.61ms |
| Fastify   |      20,624 |     0.49x |     1% | 4.21ms | 8.29ms | 9.07ms |
| Koa       |      16,054 |     0.38x |     7% | 6.82ms | 10.14ms | 12.05ms |

  Yatta dispatch adds about 2.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 23%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
