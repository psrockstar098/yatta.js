# Yatta Benchmarks

> Last run: `2026-10-18T00:51:47Z` · commit [`3296e2b`](https://github.com/psrockstar098/yatta.js/commit/3296e2b3d702cab78110f25926593bbd6b49514f) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 117.3 ms
  • End-to-End Runtime Task Cost    : 0.0568 ms/op
  • Peak RSS Memory        : 122.5 MB
  • RSS Heap Memory             : 55.96 MB
  • Raw Worker IPC Round-Trip      : 0.0454 ms/op
  • Scheduler + Graph Overhead     : 0.0114 ms/op
  • Settled Cooldown RSS   : 90.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.17 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      35,961 |     1.00x |    22% | 3.00ms | 4.68ms | 5.94ms |
| Raw Bun   |      43,346 |     1.21x |    24% | 2.76ms | 5.02ms | 5.97ms |
| Hono      |      44,898 |     1.25x |    25% | 1.98ms | 3.81ms | 4.16ms |
| Elysia    |      44,723 |     1.24x |     8% | 2.30ms | 3.72ms | 5.13ms |
| Express   |      14,647 |     0.41x |     9% | 7.94ms | 11.03ms | 11.81ms |
| Fastify   |      20,479 |     0.57x |     4% | 4.25ms | 8.24ms | 9.43ms |
| Koa       |      15,596 |     0.43x |     7% | 6.63ms | 10.64ms | 11.77ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,039 |       0.39 |       0.42 |       0.42 |       0.42 |
|         100 |     1.1 ms |               87,572 |       0.38 |       0.68 |       0.69 |       0.69 |
|         500 |     2.6 ms |              189,902 |       1.30 |       1.62 |       1.67 |       1.70 |
|        1000 |     4.5 ms |              221,872 |       2.31 |       3.47 |       3.59 |       3.64 |
|        5000 |    35.7 ms |              140,062 |      18.71 |      24.87 |      25.46 |      25.50 |
|       10000 |    58.9 ms |              169,829 |      31.64 |      48.03 |      48.32 |      48.39 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.4 ms |            106,033 |     4.01 |     5.90 |     7.14 |       7.57 |     7.57 |
|        5000 |   27.5 ms |            181,683 |    13.44 |    19.54 |    20.11 |      20.12 |    20.12 |
|       10000 |   50.7 ms |            197,241 |    25.85 |    40.04 |    40.94 |      40.94 |    40.95 |
|       25000 |  122.2 ms |            204,529 |    57.11 |    93.23 |    97.88 |      98.38 |    98.39 |
|       50000 |  215.0 ms |            232,526 |   108.37 |   170.27 |   180.37 |     181.87 |   182.00 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.6 ms |             79,102 |     6.40 |     9.52 |    11.13 |      11.52 |    11.52 |
|        5000 |   57.0 ms |             87,760 |    30.17 |    42.72 |    43.84 |      43.85 |    43.85 |
|       10000 |  109.6 ms |             91,243 |    53.67 |    91.27 |    94.09 |      94.18 |    94.18 |
|       25000 |  269.5 ms |             92,771 |   137.94 |   226.27 |   241.26 |     241.77 |   241.80 |
|       50000 |  409.0 ms |            122,249 |   205.47 |   342.55 |   372.89 |     374.16 |   374.26 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   42.5 ms |             23,551 |    17.17 |    38.87 |    41.22 |      41.57 |    41.57 |
|        5000 |  143.6 ms |             34,812 |    66.84 |   125.84 |   137.18 |     138.85 |   139.03 |
|       10000 |  270.9 ms |             36,914 |   138.48 |   236.74 |   261.15 |     263.84 |   264.22 |

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
  • Raw Worker IPC Round-Trip      : 0.0454 ms/op
  • End-to-End Runtime Task Cost    : 0.0568 ms/op
  • Scheduler + Graph Overhead     : 0.0114 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,039 |       0.39 |       0.42 |       0.42 |       0.42 |
|         100 |     1.1 ms |               87,572 |       0.38 |       0.68 |       0.69 |       0.69 |
|         500 |     2.6 ms |              189,902 |       1.30 |       1.62 |       1.67 |       1.70 |
|        1000 |     4.5 ms |              221,872 |       2.31 |       3.47 |       3.59 |       3.64 |
|        5000 |    35.7 ms |              140,062 |      18.71 |      24.87 |      25.46 |      25.50 |
|       10000 |    58.9 ms |              169,829 |      31.64 |      48.03 |      48.32 |      48.39 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.17 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 55.96 MB
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
| 1 CPU + 1 IO  |       2 |   48.4 ms |            206,436 |    23.54 |    36.22 |    36.78 |    37.08 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   48.2 ms |            207,497 |    23.91 |    36.46 |    38.24 |    38.40 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   34.1 ms |            293,172 |    18.10 |    25.93 |    26.27 |    26.63 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   41.1 ms |            243,392 |    18.33 |    32.40 |    32.46 |    32.49 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 117.3 ms
  • Peak Throughput Rate       : 213,156 ops/sec
  • Latency Distribution       : p50: 60.39ms | p90: 94.15ms | p99: 97.31ms | p99.9: 97.45ms | Max: 97.47ms
  • Memory (RSS)               : Baseline: 114.5 MB | Peak: 130.2 MB | Cooldown: 102.7 MB

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
|        1000 |    9.4 ms |            106,033 |     4.01 |     5.90 |     7.14 |       7.57 |     7.57 |
|        5000 |   27.5 ms |            181,683 |    13.44 |    19.54 |    20.11 |      20.12 |    20.12 |
|       10000 |   50.7 ms |            197,241 |    25.85 |    40.04 |    40.94 |      40.94 |    40.95 |
|       25000 |  122.2 ms |            204,529 |    57.11 |    93.23 |    97.88 |      98.38 |    98.39 |
|       50000 |  215.0 ms |            232,526 |   108.37 |   170.27 |   180.37 |     181.87 |   182.00 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.6 ms |             79,102 |     6.40 |     9.52 |    11.13 |      11.52 |    11.52 |
|        5000 |   57.0 ms |             87,760 |    30.17 |    42.72 |    43.84 |      43.85 |    43.85 |
|       10000 |  109.6 ms |             91,243 |    53.67 |    91.27 |    94.09 |      94.18 |    94.18 |
|       25000 |  269.5 ms |             92,771 |   137.94 |   226.27 |   241.26 |     241.77 |   241.80 |
|       50000 |  409.0 ms |            122,249 |   205.47 |   342.55 |   372.89 |     374.16 |   374.26 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   42.5 ms |             23,551 |    17.17 |    38.87 |    41.22 |      41.57 |    41.57 |
|        5000 |  143.6 ms |             34,812 |    66.84 |   125.84 |   137.18 |     138.85 |   139.03 |
|       10000 |  270.9 ms |             36,914 |   138.48 |   236.74 |   261.15 |     263.84 |   264.22 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 122.5 MB
  • Settled Cooldown RSS   : 90.3 MB (Clean GC release)

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
| Yatta     |      35,961 |     1.00x |    22% | 3.00ms | 4.68ms | 5.94ms |
| Raw Bun   |      43,346 |     1.21x |    24% | 2.76ms | 5.02ms | 5.97ms |
| Hono      |      44,898 |     1.25x |    25% | 1.98ms | 3.81ms | 4.16ms |
| Elysia    |      44,723 |     1.24x |     8% | 2.30ms | 3.72ms | 5.13ms |
| Express   |      14,647 |     0.41x |     9% | 7.94ms | 11.03ms | 11.81ms |
| Fastify   |      20,479 |     0.57x |     4% | 4.25ms | 8.24ms | 9.43ms |
| Koa       |      15,596 |     0.43x |     7% | 6.63ms | 10.64ms | 11.77ms |

  Yatta dispatch adds about 4.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 22%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
