# Yatta Benchmarks

> Last run: `2026-10-31T02:42:45Z` · commit [`6851181`](https://github.com/psrockstar098/yatta.js/commit/68511817590e9a2ce8a662e773ff3a5b7f62fb42) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 106.4 ms
  • End-to-End Runtime Task Cost    : 0.0464 ms/op
  • Peak RSS Memory        : 184.9 MB
  • RSS Heap Memory             : 80.68 MB
  • Raw Worker IPC Round-Trip      : 0.0343 ms/op
  • Scheduler + Graph Overhead     : 0.0121 ms/op
  • Settled Cooldown RSS   : 71.8 MB (Clean GC release)
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
| Yatta     |      45,205 |     1.00x |    20% | 2.08ms | 3.64ms | 4.66ms |
| Raw Bun   |      44,642 |     0.99x |    12% | 2.03ms | 4.61ms | 4.79ms |
| Hono      |      49,551 |     1.10x |    13% | 1.93ms | 3.64ms | 4.17ms |
| Elysia    |      52,389 |     1.16x |    19% | 2.21ms | 4.55ms | 4.86ms |
| Express   |      14,879 |     0.33x |    11% | 6.51ms | 10.73ms | 12.09ms |
| Fastify   |      20,259 |     0.45x |     7% | 4.39ms | 7.89ms | 8.81ms |
| Koa       |      15,403 |     0.34x |     4% | 6.44ms | 10.05ms | 11.31ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,896 |       0.50 |       0.54 |       0.54 |       0.54 |
|         100 |     1.6 ms |               64,422 |       0.74 |       1.06 |       1.11 |       1.11 |
|         500 |     4.3 ms |              116,746 |       1.51 |       2.73 |       2.76 |       2.78 |
|        1000 |     5.5 ms |              183,388 |       2.70 |       3.89 |       4.00 |       4.05 |
|        5000 |    27.8 ms |              179,939 |      14.60 |      19.65 |      19.78 |      19.79 |
|       10000 |    57.7 ms |              173,318 |      27.45 |      46.11 |      47.53 |      47.58 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            104,983 |     4.63 |     6.59 |     8.27 |       8.43 |     8.43 |
|        5000 |   21.9 ms |            227,794 |    10.42 |    13.55 |    14.02 |      14.03 |    14.03 |
|       10000 |   43.3 ms |            231,001 |    20.90 |    32.94 |    34.17 |      34.19 |    34.19 |
|       25000 |  103.4 ms |            241,667 |    48.99 |    75.53 |    79.96 |      80.01 |    80.03 |
|       50000 |  192.3 ms |            260,000 |    96.01 |   148.44 |   157.50 |     157.95 |   157.97 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             83,844 |     6.22 |     9.08 |    10.32 |      10.54 |    10.54 |
|        5000 |   37.5 ms |            133,173 |    18.86 |    29.31 |    30.28 |      30.33 |    30.33 |
|       10000 |   79.4 ms |            125,969 |    35.00 |    60.56 |    63.72 |      63.82 |    63.83 |
|       25000 |  254.4 ms |             98,251 |   127.82 |   221.11 |   234.93 |     235.46 |   235.49 |
|       50000 |  449.9 ms |            111,141 |   253.56 |   385.46 |   413.94 |     415.03 |   415.25 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.1 ms |             32,203 |    15.79 |    23.89 |    25.55 |      25.73 |    25.73 |
|        5000 |  106.6 ms |             46,897 |    49.32 |    93.87 |   102.82 |     104.19 |   104.30 |
|       10000 |  199.1 ms |             50,230 |    94.00 |   172.19 |   192.43 |     195.44 |   195.74 |

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
  • Raw Worker IPC Round-Trip      : 0.0343 ms/op
  • End-to-End Runtime Task Cost    : 0.0464 ms/op
  • Scheduler + Graph Overhead     : 0.0121 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,896 |       0.50 |       0.54 |       0.54 |       0.54 |
|         100 |     1.6 ms |               64,422 |       0.74 |       1.06 |       1.11 |       1.11 |
|         500 |     4.3 ms |              116,746 |       1.51 |       2.73 |       2.76 |       2.78 |
|        1000 |     5.5 ms |              183,388 |       2.70 |       3.89 |       4.00 |       4.05 |
|        5000 |    27.8 ms |              179,939 |      14.60 |      19.65 |      19.78 |      19.79 |
|       10000 |    57.7 ms |              173,318 |      27.45 |      46.11 |      47.53 |      47.58 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.68 MB
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
| 1 CPU + 1 IO  |       2 |   59.2 ms |            169,011 |    30.56 |    44.47 |    46.76 |    46.91 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   45.7 ms |            218,941 |    23.42 |    34.55 |    35.06 |    35.08 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   34.2 ms |            292,407 |    16.78 |    26.38 |    26.88 |    26.94 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   42.5 ms |            235,158 |    22.81 |    30.61 |    31.99 |    32.13 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 106.4 ms
  • Peak Throughput Rate       : 234,913 ops/sec
  • Latency Distribution       : p50: 51.14ms | p90: 81.13ms | p99: 85.15ms | p99.9: 86.08ms | Max: 86.17ms
  • Memory (RSS)               : Baseline: 98.8 MB | Peak: 131.7 MB | Cooldown: 104.7 MB

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
|        1000 |    9.5 ms |            104,983 |     4.63 |     6.59 |     8.27 |       8.43 |     8.43 |
|        5000 |   21.9 ms |            227,794 |    10.42 |    13.55 |    14.02 |      14.03 |    14.03 |
|       10000 |   43.3 ms |            231,001 |    20.90 |    32.94 |    34.17 |      34.19 |    34.19 |
|       25000 |  103.4 ms |            241,667 |    48.99 |    75.53 |    79.96 |      80.01 |    80.03 |
|       50000 |  192.3 ms |            260,000 |    96.01 |   148.44 |   157.50 |     157.95 |   157.97 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             83,844 |     6.22 |     9.08 |    10.32 |      10.54 |    10.54 |
|        5000 |   37.5 ms |            133,173 |    18.86 |    29.31 |    30.28 |      30.33 |    30.33 |
|       10000 |   79.4 ms |            125,969 |    35.00 |    60.56 |    63.72 |      63.82 |    63.83 |
|       25000 |  254.4 ms |             98,251 |   127.82 |   221.11 |   234.93 |     235.46 |   235.49 |
|       50000 |  449.9 ms |            111,141 |   253.56 |   385.46 |   413.94 |     415.03 |   415.25 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   31.1 ms |             32,203 |    15.79 |    23.89 |    25.55 |      25.73 |    25.73 |
|        5000 |  106.6 ms |             46,897 |    49.32 |    93.87 |   102.82 |     104.19 |   104.30 |
|       10000 |  199.1 ms |             50,230 |    94.00 |   172.19 |   192.43 |     195.44 |   195.74 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 184.9 MB
  • Settled Cooldown RSS   : 71.8 MB (Clean GC release)

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
| Yatta     |      45,205 |     1.00x |    20% | 2.08ms | 3.64ms | 4.66ms |
| Raw Bun   |      44,642 |     0.99x |    12% | 2.03ms | 4.61ms | 4.79ms |
| Hono      |      49,551 |     1.10x |    13% | 1.93ms | 3.64ms | 4.17ms |
| Elysia    |      52,389 |     1.16x |    19% | 2.21ms | 4.55ms | 4.86ms |
| Express   |      14,879 |     0.33x |    11% | 6.51ms | 10.73ms | 12.09ms |
| Fastify   |      20,259 |     0.45x |     7% | 4.39ms | 7.89ms | 8.81ms |
| Koa       |      15,403 |     0.34x |     4% | 6.44ms | 10.05ms | 11.31ms |

  Yatta dispatch adds about -0.3µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 20%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
