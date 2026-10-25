# Yatta Benchmarks

> Last run: `2026-10-25T10:20:25Z` · commit [`c72c732`](https://github.com/psrockstar098/yatta.js/commit/c72c7326f8baa0672e605f0a2124baa41a882f9e) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 103.9 ms
  • End-to-End Runtime Task Cost    : 0.0651 ms/op
  • Peak RSS Memory        : 187.9 MB
  • RSS Heap Memory             : 76.68 MB
  • Raw Worker IPC Round-Trip      : 0.0357 ms/op
  • Scheduler + Graph Overhead     : 0.0294 ms/op
  • Settled Cooldown RSS   : 72.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.20 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      39,476 |     1.00x |    25% | 2.17ms | 4.42ms | 4.88ms |
| Raw Bun   |      45,429 |     1.15x |    32% | 1.72ms | 3.35ms | 5.12ms |
| Hono      |      44,081 |     1.12x |    21% | 1.94ms | 3.81ms | 4.07ms |
| Elysia    |      47,985 |     1.22x |    13% | 1.83ms | 3.21ms | 4.64ms |
| Express   |      14,601 |     0.37x |     2% | 6.39ms | 10.98ms | 11.93ms |
| Fastify   |      21,321 |     0.54x |    12% | 4.08ms | 8.50ms | 9.66ms |
| Koa       |      14,935 |     0.38x |     6% | 5.70ms | 10.37ms | 11.37ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.0 ms |               10,356 |       0.37 |       0.44 |       0.44 |       0.44 |
|         100 |     1.3 ms |               77,363 |       0.33 |       0.88 |       0.90 |       0.90 |
|         500 |     2.6 ms |              192,399 |       1.29 |       1.85 |       1.92 |       1.94 |
|        1000 |     6.5 ms |              153,431 |       4.35 |       5.33 |       5.40 |       5.46 |
|        5000 |    30.6 ms |              163,546 |      15.95 |      21.79 |      22.57 |      22.57 |
|       10000 |    53.8 ms |              185,751 |      29.21 |      42.38 |      42.62 |      43.05 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.9 ms |            127,015 |     3.66 |     5.33 |     6.52 |       6.69 |     6.69 |
|        5000 |   25.4 ms |            196,910 |    11.24 |    17.70 |    18.21 |      18.21 |    18.22 |
|       10000 |   50.1 ms |            199,593 |    22.69 |    38.99 |    39.88 |      39.95 |    39.96 |
|       25000 |  103.7 ms |            240,967 |    51.36 |    75.79 |    80.34 |      80.38 |    80.39 |
|       50000 |  193.2 ms |            258,831 |    93.06 |   152.28 |   162.89 |     163.16 |   163.62 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.9 ms |             67,160 |     6.75 |     9.71 |    11.35 |      11.53 |    11.53 |
|        5000 |   52.1 ms |             95,971 |    27.47 |    37.80 |    41.49 |      41.97 |    42.00 |
|       10000 |  113.0 ms |             88,502 |    56.29 |    93.30 |    99.07 |      99.47 |    99.49 |
|       25000 |  282.5 ms |             88,501 |   145.82 |   233.32 |   248.79 |     251.18 |   251.42 |
|       50000 |  539.1 ms |             92,746 |   267.08 |   459.97 |   500.98 |     502.85 |   503.00 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   39.6 ms |             25,258 |    25.35 |    34.40 |    37.73 |      38.23 |    38.23 |
|        5000 |  157.8 ms |             31,677 |    84.61 |   138.78 |   152.29 |     154.57 |   154.78 |
|       10000 |  268.7 ms |             37,218 |   133.57 |   234.96 |   259.29 |     262.90 |   263.29 |

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
  • Raw Worker IPC Round-Trip      : 0.0357 ms/op
  • End-to-End Runtime Task Cost    : 0.0651 ms/op
  • Scheduler + Graph Overhead     : 0.0294 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     1.0 ms |               10,356 |       0.37 |       0.44 |       0.44 |       0.44 |
|         100 |     1.3 ms |               77,363 |       0.33 |       0.88 |       0.90 |       0.90 |
|         500 |     2.6 ms |              192,399 |       1.29 |       1.85 |       1.92 |       1.94 |
|        1000 |     6.5 ms |              153,431 |       4.35 |       5.33 |       5.40 |       5.46 |
|        5000 |    30.6 ms |              163,546 |      15.95 |      21.79 |      22.57 |      22.57 |
|       10000 |    53.8 ms |              185,751 |      29.21 |      42.38 |      42.62 |      43.05 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.20 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 76.68 MB
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
| 1 CPU + 1 IO  |       2 |   58.4 ms |            171,140 |    28.41 |    43.40 |    47.05 |    47.55 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   44.2 ms |            226,372 |    21.58 |    34.22 |    34.81 |    34.88 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   45.0 ms |            222,380 |    22.52 |    35.41 |    36.77 |    37.34 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   41.0 ms |            244,106 |    20.88 |    34.42 |    34.46 |    34.51 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 103.9 ms
  • Peak Throughput Rate       : 240,652 ops/sec
  • Latency Distribution       : p50: 51.59ms | p90: 82.17ms | p99: 84.96ms | p99.9: 85.11ms | Max: 85.12ms
  • Memory (RSS)               : Baseline: 102.3 MB | Peak: 129.5 MB | Cooldown: 103.0 MB

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
|        1000 |    7.9 ms |            127,015 |     3.66 |     5.33 |     6.52 |       6.69 |     6.69 |
|        5000 |   25.4 ms |            196,910 |    11.24 |    17.70 |    18.21 |      18.21 |    18.22 |
|       10000 |   50.1 ms |            199,593 |    22.69 |    38.99 |    39.88 |      39.95 |    39.96 |
|       25000 |  103.7 ms |            240,967 |    51.36 |    75.79 |    80.34 |      80.38 |    80.39 |
|       50000 |  193.2 ms |            258,831 |    93.06 |   152.28 |   162.89 |     163.16 |   163.62 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   14.9 ms |             67,160 |     6.75 |     9.71 |    11.35 |      11.53 |    11.53 |
|        5000 |   52.1 ms |             95,971 |    27.47 |    37.80 |    41.49 |      41.97 |    42.00 |
|       10000 |  113.0 ms |             88,502 |    56.29 |    93.30 |    99.07 |      99.47 |    99.49 |
|       25000 |  282.5 ms |             88,501 |   145.82 |   233.32 |   248.79 |     251.18 |   251.42 |
|       50000 |  539.1 ms |             92,746 |   267.08 |   459.97 |   500.98 |     502.85 |   503.00 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   39.6 ms |             25,258 |    25.35 |    34.40 |    37.73 |      38.23 |    38.23 |
|        5000 |  157.8 ms |             31,677 |    84.61 |   138.78 |   152.29 |     154.57 |   154.78 |
|       10000 |  268.7 ms |             37,218 |   133.57 |   234.96 |   259.29 |     262.90 |   263.29 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 187.9 MB
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

Route:  GET /json
Load:   20,000 requests, 100 concurrent, keep-alive
Method: one process per framework, 3 repetitions each, median reported

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      39,476 |     1.00x |    25% | 2.17ms | 4.42ms | 4.88ms |
| Raw Bun   |      45,429 |     1.15x |    32% | 1.72ms | 3.35ms | 5.12ms |
| Hono      |      44,081 |     1.12x |    21% | 1.94ms | 3.81ms | 4.07ms |
| Elysia    |      47,985 |     1.22x |    13% | 1.83ms | 3.21ms | 4.64ms |
| Express   |      14,601 |     0.37x |     2% | 6.39ms | 10.98ms | 11.93ms |
| Fastify   |      21,321 |     0.54x |    12% | 4.08ms | 8.50ms | 9.66ms |
| Koa       |      14,935 |     0.38x |     6% | 5.70ms | 10.37ms | 11.37ms |

  Yatta dispatch adds about 3.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 25%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
