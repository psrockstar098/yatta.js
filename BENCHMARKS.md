# Yatta Benchmarks

> Last run: `2026-11-24T11:04:39Z` · commit [`8b010fc`](https://github.com/psrockstar098/yatta.js/commit/8b010fc08668d39a5efd70aa93f018b66563a2e0) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 60.5 ms
  • End-to-End Runtime Task Cost    : 0.0192 ms/op
  • Peak RSS Memory        : 175.4 MB
  • RSS Heap Memory             : 98.07 MB
  • Raw Worker IPC Round-Trip      : 0.0190 ms/op
  • Scheduler + Graph Overhead     : 0.0002 ms/op
  • Settled Cooldown RSS   : 79.1 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.63 MB
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      70,786 |     1.00x |     9% | 1.26ms | 2.81ms | 3.38ms |
| Raw Bun   |      57,892 |     0.82x |     2% | 1.47ms | 3.04ms | 3.15ms |
| Hono      |      62,616 |     0.88x |     5% | 1.36ms | 2.95ms | 3.08ms |
| Elysia    |      60,462 |     0.85x |    18% | 1.31ms | 2.72ms | 2.95ms |
| Express   |      43,728 |     0.62x |    10% | 2.13ms | 3.92ms | 5.24ms |
| Fastify   |      52,854 |     0.75x |     7% | 1.89ms | 3.27ms | 4.83ms |
| Koa       |      48,316 |     0.68x |     1% | 1.91ms | 3.58ms | 4.50ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               20,992 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.4 ms |              251,412 |       0.18 |       0.30 |       0.31 |       0.31 |
|         500 |     1.0 ms |              497,787 |       0.49 |       0.77 |       0.79 |       0.81 |
|        1000 |     2.0 ms |              493,021 |       1.05 |       1.53 |       1.55 |       1.57 |
|        5000 |    13.1 ms |              381,222 |       6.77 |       8.74 |       8.76 |       8.76 |
|       10000 |    23.9 ms |              418,917 |      11.28 |      18.14 |      18.47 |      18.56 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    4.6 ms |            218,250 |     1.91 |     2.87 |     3.56 |       3.77 |     3.77 |
|        5000 |   11.9 ms |            419,437 |     5.31 |     8.06 |     8.36 |       8.39 |     8.39 |
|       10000 |   23.2 ms |            431,125 |    12.35 |    17.40 |    18.34 |      18.41 |    18.42 |
|       25000 |   56.9 ms |            439,354 |    23.97 |    41.00 |    42.62 |      42.68 |    42.69 |
|       50000 |  112.4 ms |            444,797 |    51.95 |    85.20 |    93.05 |      93.18 |    93.24 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.4 ms |            157,347 |     3.04 |     4.46 |     5.01 |       5.30 |     5.30 |
|        5000 |   27.2 ms |            184,038 |    12.52 |    20.83 |    21.50 |      21.52 |    21.53 |
|       10000 |   59.4 ms |            168,319 |    30.37 |    48.51 |    50.24 |      50.32 |    50.32 |
|       25000 |  143.5 ms |            174,250 |    65.55 |   118.33 |   127.15 |     127.63 |   127.65 |
|       50000 |  331.9 ms |            150,654 |   166.83 |   287.58 |   312.75 |     313.30 |   313.51 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   23.7 ms |             42,179 |    14.50 |    20.38 |    22.83 |      23.10 |    23.10 |
|        5000 |   65.6 ms |             76,237 |    28.66 |    46.79 |    55.35 |      60.86 |    60.94 |
|       10000 |  127.3 ms |             78,543 |    61.48 |   104.85 |   123.04 |     124.87 |   125.05 |

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
  • Raw Worker IPC Round-Trip      : 0.0190 ms/op
  • End-to-End Runtime Task Cost    : 0.0192 ms/op
  • Scheduler + Graph Overhead     : 0.0002 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.5 ms |               20,992 |       0.25 |       0.27 |       0.27 |       0.27 |
|         100 |     0.4 ms |              251,412 |       0.18 |       0.30 |       0.31 |       0.31 |
|         500 |     1.0 ms |              497,787 |       0.49 |       0.77 |       0.79 |       0.81 |
|        1000 |     2.0 ms |              493,021 |       1.05 |       1.53 |       1.55 |       1.57 |
|        5000 |    13.1 ms |              381,222 |       6.77 |       8.74 |       8.76 |       8.76 |
|       10000 |    23.9 ms |              418,917 |      11.28 |      18.14 |      18.47 |      18.56 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 98.07 MB
  • V8/JSC Heap Used             : 13.63 MB

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
| 1 CPU + 1 IO  |       2 |   29.2 ms |            342,956 |    13.44 |    21.31 |    21.80 |    21.91 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   25.7 ms |            389,624 |    11.29 |    19.86 |    20.29 |    20.32 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   20.6 ms |            484,380 |     8.88 |    15.52 |    15.97 |    16.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   20.9 ms |            478,466 |    10.32 |    16.72 |    16.97 |    17.00 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 60.5 ms
  • Peak Throughput Rate       : 412,915 ops/sec
  • Latency Distribution       : p50: 31.97ms | p90: 49.16ms | p99: 49.29ms | p99.9: 49.54ms | Max: 49.57ms
  • Memory (RSS)               : Baseline: 101.0 MB | Peak: 133.0 MB | Cooldown: 104.0 MB

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
|        1000 |    4.6 ms |            218,250 |     1.91 |     2.87 |     3.56 |       3.77 |     3.77 |
|        5000 |   11.9 ms |            419,437 |     5.31 |     8.06 |     8.36 |       8.39 |     8.39 |
|       10000 |   23.2 ms |            431,125 |    12.35 |    17.40 |    18.34 |      18.41 |    18.42 |
|       25000 |   56.9 ms |            439,354 |    23.97 |    41.00 |    42.62 |      42.68 |    42.69 |
|       50000 |  112.4 ms |            444,797 |    51.95 |    85.20 |    93.05 |      93.18 |    93.24 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.4 ms |            157,347 |     3.04 |     4.46 |     5.01 |       5.30 |     5.30 |
|        5000 |   27.2 ms |            184,038 |    12.52 |    20.83 |    21.50 |      21.52 |    21.53 |
|       10000 |   59.4 ms |            168,319 |    30.37 |    48.51 |    50.24 |      50.32 |    50.32 |
|       25000 |  143.5 ms |            174,250 |    65.55 |   118.33 |   127.15 |     127.63 |   127.65 |
|       50000 |  331.9 ms |            150,654 |   166.83 |   287.58 |   312.75 |     313.30 |   313.51 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   23.7 ms |             42,179 |    14.50 |    20.38 |    22.83 |      23.10 |    23.10 |
|        5000 |   65.6 ms |             76,237 |    28.66 |    46.79 |    55.35 |      60.86 |    60.94 |
|       10000 |  127.3 ms |             78,543 |    61.48 |   104.85 |   123.04 |     124.87 |   125.05 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 175.4 MB
  • Settled Cooldown RSS   : 79.1 MB (Clean GC release)

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
| Yatta     |      70,786 |     1.00x |     9% | 1.26ms | 2.81ms | 3.38ms |
| Raw Bun   |      57,892 |     0.82x |     2% | 1.47ms | 3.04ms | 3.15ms |
| Hono      |      62,616 |     0.88x |     5% | 1.36ms | 2.95ms | 3.08ms |
| Elysia    |      60,462 |     0.85x |    18% | 1.31ms | 2.72ms | 2.95ms |
| Express   |      43,728 |     0.62x |    10% | 2.13ms | 3.92ms | 5.24ms |
| Fastify   |      52,854 |     0.75x |     7% | 1.89ms | 3.27ms | 4.83ms |
| Koa       |      48,316 |     0.68x |     1% | 1.91ms | 3.58ms | 4.50ms |

  Yatta dispatch adds about -3.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
