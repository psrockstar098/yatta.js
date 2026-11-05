# Yatta Benchmarks

> Last run: `2026-11-05T03:42:08Z` · commit [`9bfbe5f`](https://github.com/psrockstar098/yatta.js/commit/9bfbe5f36dd64ccf94b51aa6fc171d4f0b2f5cd8) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 90.8 ms
  • End-to-End Runtime Task Cost    : 0.0265 ms/op
  • Peak RSS Memory        : 193.7 MB
  • RSS Heap Memory             : 93.30 MB
  • Raw Worker IPC Round-Trip      : 0.0200 ms/op
  • Scheduler + Graph Overhead     : 0.0065 ms/op
  • Settled Cooldown RSS   : 148.4 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.84 MB
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
| Yatta     |      58,736 |     1.00x |    23% | 2.38ms | 2.79ms | 3.53ms |
| Raw Bun   |      47,322 |     0.81x |    13% | 1.97ms | 4.11ms | 4.36ms |
| Hono      |      62,466 |     1.06x |    19% | 1.65ms | 2.47ms | 3.35ms |
| Elysia    |      53,135 |     0.90x |    24% | 1.79ms | 3.82ms | 3.95ms |
| Express   |      23,558 |     0.40x |     1% | 4.22ms | 6.94ms | 8.06ms |
| Fastify   |      34,152 |     0.58x |     2% | 2.63ms | 5.09ms | 6.00ms |
| Koa       |      24,875 |     0.42x |    14% | 4.30ms | 6.43ms | 7.63ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,056 |       0.26 |       0.28 |       0.28 |       0.28 |
|         100 |     0.9 ms |              117,051 |       0.28 |       0.57 |       0.57 |       0.57 |
|         500 |     1.7 ms |              297,372 |       0.80 |       1.33 |       1.42 |       1.45 |
|        1000 |     3.4 ms |              295,733 |       1.71 |       2.78 |       2.89 |       2.93 |
|        5000 |    20.7 ms |              241,468 |      12.09 |      15.56 |      15.64 |      15.67 |
|       10000 |    37.1 ms |              269,608 |      19.22 |      30.04 |      30.37 |      30.61 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.1 ms |            141,484 |     3.39 |     4.75 |     5.57 |       5.87 |     5.87 |
|        5000 |   20.5 ms |            244,231 |    10.06 |    14.45 |    14.91 |      14.92 |    14.92 |
|       10000 |   42.6 ms |            235,009 |    21.99 |    33.62 |    34.06 |      34.13 |    34.13 |
|       25000 |   87.7 ms |            285,090 |    43.68 |    66.38 |    69.63 |      69.64 |    69.66 |
|       50000 |  171.2 ms |            292,110 |    86.02 |   133.15 |   138.72 |     139.21 |   139.28 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,142 |     4.91 |     7.25 |     8.41 |       8.50 |     8.50 |
|        5000 |   37.9 ms |            132,002 |    17.99 |    29.22 |    30.11 |      30.15 |    30.16 |
|       10000 |   88.4 ms |            113,065 |    44.23 |    67.95 |    71.28 |      71.45 |    71.47 |
|       25000 |  196.9 ms |            126,979 |    88.41 |   168.49 |   179.45 |     180.02 |   180.03 |
|       50000 |  404.9 ms |            123,501 |   207.34 |   345.40 |   375.03 |     376.02 |   376.08 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.1 ms |             62,236 |     8.56 |    13.56 |    15.13 |      15.37 |    15.37 |
|        5000 |   75.4 ms |             66,309 |    42.21 |    66.44 |    72.69 |      73.41 |    73.51 |
|       10000 |  149.2 ms |             67,042 |    72.98 |   123.29 |   142.98 |     145.50 |   145.79 |

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
  • Raw Worker IPC Round-Trip      : 0.0200 ms/op
  • End-to-End Runtime Task Cost    : 0.0265 ms/op
  • Scheduler + Graph Overhead     : 0.0065 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,056 |       0.26 |       0.28 |       0.28 |       0.28 |
|         100 |     0.9 ms |              117,051 |       0.28 |       0.57 |       0.57 |       0.57 |
|         500 |     1.7 ms |              297,372 |       0.80 |       1.33 |       1.42 |       1.45 |
|        1000 |     3.4 ms |              295,733 |       1.71 |       2.78 |       2.89 |       2.93 |
|        5000 |    20.7 ms |              241,468 |      12.09 |      15.56 |      15.64 |      15.67 |
|       10000 |    37.1 ms |              269,608 |      19.22 |      30.04 |      30.37 |      30.61 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 93.30 MB
  • V8/JSC Heap Used             : 13.84 MB

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
| 1 CPU + 1 IO  |       2 |   39.1 ms |            255,486 |    20.72 |    30.20 |    30.54 |    30.66 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   41.5 ms |            241,044 |    19.92 |    33.50 |    33.63 |    33.73 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   28.7 ms |            348,921 |    14.89 |    23.79 |    24.12 |    24.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   38.1 ms |            262,473 |    17.94 |    30.82 |    31.34 |    31.41 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 90.8 ms
  • Peak Throughput Rate       : 275,231 ops/sec
  • Latency Distribution       : p50: 48.62ms | p90: 75.10ms | p99: 76.27ms | p99.9: 76.50ms | Max: 76.53ms
  • Memory (RSS)               : Baseline: 95.1 MB | Peak: 129.6 MB | Cooldown: 99.9 MB

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
|        1000 |    7.1 ms |            141,484 |     3.39 |     4.75 |     5.57 |       5.87 |     5.87 |
|        5000 |   20.5 ms |            244,231 |    10.06 |    14.45 |    14.91 |      14.92 |    14.92 |
|       10000 |   42.6 ms |            235,009 |    21.99 |    33.62 |    34.06 |      34.13 |    34.13 |
|       25000 |   87.7 ms |            285,090 |    43.68 |    66.38 |    69.63 |      69.64 |    69.66 |
|       50000 |  171.2 ms |            292,110 |    86.02 |   133.15 |   138.72 |     139.21 |   139.28 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,142 |     4.91 |     7.25 |     8.41 |       8.50 |     8.50 |
|        5000 |   37.9 ms |            132,002 |    17.99 |    29.22 |    30.11 |      30.15 |    30.16 |
|       10000 |   88.4 ms |            113,065 |    44.23 |    67.95 |    71.28 |      71.45 |    71.47 |
|       25000 |  196.9 ms |            126,979 |    88.41 |   168.49 |   179.45 |     180.02 |   180.03 |
|       50000 |  404.9 ms |            123,501 |   207.34 |   345.40 |   375.03 |     376.02 |   376.08 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   16.1 ms |             62,236 |     8.56 |    13.56 |    15.13 |      15.37 |    15.37 |
|        5000 |   75.4 ms |             66,309 |    42.21 |    66.44 |    72.69 |      73.41 |    73.51 |
|       10000 |  149.2 ms |             67,042 |    72.98 |   123.29 |   142.98 |     145.50 |   145.79 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 193.7 MB
  • Settled Cooldown RSS   : 148.4 MB (Clean GC release)

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
| Yatta     |      58,736 |     1.00x |    23% | 2.38ms | 2.79ms | 3.53ms |
| Raw Bun   |      47,322 |     0.81x |    13% | 1.97ms | 4.11ms | 4.36ms |
| Hono      |      62,466 |     1.06x |    19% | 1.65ms | 2.47ms | 3.35ms |
| Elysia    |      53,135 |     0.90x |    24% | 1.79ms | 3.82ms | 3.95ms |
| Express   |      23,558 |     0.40x |     1% | 4.22ms | 6.94ms | 8.06ms |
| Fastify   |      34,152 |     0.58x |     2% | 2.63ms | 5.09ms | 6.00ms |
| Koa       |      24,875 |     0.42x |    14% | 4.30ms | 6.43ms | 7.63ms |

  Yatta dispatch adds about -4.1µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 23%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
