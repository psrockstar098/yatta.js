# Yatta Benchmarks

> Last run: `2026-11-10T18:13:36Z` · commit [`37f4469`](https://github.com/psrockstar098/yatta.js/commit/37f4469678133fc5e32a9ef97d772c85f0cba6e8) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 131.0 ms
  • End-to-End Runtime Task Cost    : 0.0420 ms/op
  • Peak RSS Memory        : 210.8 MB
  • RSS Heap Memory             : 72.66 MB
  • Raw Worker IPC Round-Trip      : 0.0312 ms/op
  • Scheduler + Graph Overhead     : 0.0108 ms/op
  • Settled Cooldown RSS   : 71.7 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.18 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      37,154 |     1.00x |    31% | 3.94ms | 5.23ms | 6.05ms |
| Raw Bun   |      47,259 |     1.27x |    10% | 2.49ms | 3.03ms | 3.91ms |
| Hono      |      45,841 |     1.23x |    17% | 2.16ms | 4.76ms | 5.88ms |
| Elysia    |      46,888 |     1.26x |    21% | 1.77ms | 3.06ms | 3.97ms |
| Express   |      13,717 |     0.37x |    11% | 7.79ms | 10.88ms | 11.76ms |
| Fastify   |      19,708 |     0.53x |     4% | 4.99ms | 8.35ms | 10.22ms |
| Koa       |      13,935 |     0.38x |    12% | 7.94ms | 10.87ms | 11.74ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,824 |       0.46 |       0.48 |       0.48 |       0.48 |
|         100 |     0.7 ms |              141,667 |       0.30 |       0.52 |       0.55 |       0.55 |
|         500 |     2.4 ms |              207,819 |       1.08 |       1.96 |       2.02 |       2.06 |
|        1000 |     4.2 ms |              240,321 |       2.11 |       3.02 |       3.05 |       3.06 |
|        5000 |    33.0 ms |              151,414 |      19.04 |      24.81 |      24.85 |      24.87 |
|       10000 |    64.4 ms |              155,206 |      34.22 |      49.55 |      51.50 |      53.21 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.5 ms |            105,688 |     4.32 |     6.21 |     7.37 |       7.78 |     7.78 |
|        5000 |   30.0 ms |            166,930 |    12.95 |    20.06 |    20.69 |      20.69 |    20.69 |
|       10000 |   60.2 ms |            166,078 |    30.89 |    47.49 |    48.95 |      49.03 |    49.03 |
|       25000 |  118.7 ms |            210,658 |    60.32 |    90.87 |    95.12 |      95.22 |    95.23 |
|       50000 |  231.9 ms |            215,600 |   109.06 |   187.89 |   200.69 |     200.86 |   200.87 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.1 ms |             76,154 |     6.58 |     9.29 |    10.40 |      10.81 |    10.81 |
|        5000 |   57.6 ms |             86,764 |    27.60 |    44.22 |    45.40 |      45.50 |    45.51 |
|       10000 |   92.7 ms |            107,882 |    46.81 |    76.23 |    78.59 |      78.75 |    78.77 |
|       25000 |  264.9 ms |             94,380 |   133.59 |   230.50 |   243.65 |     244.33 |   244.36 |
|       50000 |  489.7 ms |            102,094 |   273.07 |   414.39 |   443.13 |     443.99 |   444.07 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   27.1 ms |             36,952 |    15.16 |    23.94 |    25.80 |      26.04 |    26.04 |
|        5000 |  110.6 ms |             45,202 |    57.06 |    93.34 |   104.79 |     106.56 |   106.71 |
|       10000 |  221.1 ms |             45,234 |   107.89 |   190.10 |   211.92 |     215.58 |   215.92 |

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
  • Raw Worker IPC Round-Trip      : 0.0312 ms/op
  • End-to-End Runtime Task Cost    : 0.0420 ms/op
  • Scheduler + Graph Overhead     : 0.0108 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.9 ms |               10,824 |       0.46 |       0.48 |       0.48 |       0.48 |
|         100 |     0.7 ms |              141,667 |       0.30 |       0.52 |       0.55 |       0.55 |
|         500 |     2.4 ms |              207,819 |       1.08 |       1.96 |       2.02 |       2.06 |
|        1000 |     4.2 ms |              240,321 |       2.11 |       3.02 |       3.05 |       3.06 |
|        5000 |    33.0 ms |              151,414 |      19.04 |      24.81 |      24.85 |      24.87 |
|       10000 |    64.4 ms |              155,206 |      34.22 |      49.55 |      51.50 |      53.21 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.18 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 72.66 MB
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
| 1 CPU + 1 IO  |       2 |   54.7 ms |            182,887 |    25.60 |    42.55 |    42.95 |    43.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   52.6 ms |            190,225 |    25.15 |    41.69 |    41.95 |    42.00 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   50.5 ms |            198,181 |    27.30 |    41.32 |    42.58 |    43.12 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   54.2 ms |            184,450 |    28.43 |    43.64 |    43.73 |    43.75 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 131.0 ms
  • Peak Throughput Rate       : 190,852 ops/sec
  • Latency Distribution       : p50: 70.56ms | p90: 106.57ms | p99: 107.57ms | p99.9: 107.81ms | Max: 107.81ms
  • Memory (RSS)               : Baseline: 96.9 MB | Peak: 126.4 MB | Cooldown: 99.5 MB

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
|        1000 |    9.5 ms |            105,688 |     4.32 |     6.21 |     7.37 |       7.78 |     7.78 |
|        5000 |   30.0 ms |            166,930 |    12.95 |    20.06 |    20.69 |      20.69 |    20.69 |
|       10000 |   60.2 ms |            166,078 |    30.89 |    47.49 |    48.95 |      49.03 |    49.03 |
|       25000 |  118.7 ms |            210,658 |    60.32 |    90.87 |    95.12 |      95.22 |    95.23 |
|       50000 |  231.9 ms |            215,600 |   109.06 |   187.89 |   200.69 |     200.86 |   200.87 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.1 ms |             76,154 |     6.58 |     9.29 |    10.40 |      10.81 |    10.81 |
|        5000 |   57.6 ms |             86,764 |    27.60 |    44.22 |    45.40 |      45.50 |    45.51 |
|       10000 |   92.7 ms |            107,882 |    46.81 |    76.23 |    78.59 |      78.75 |    78.77 |
|       25000 |  264.9 ms |             94,380 |   133.59 |   230.50 |   243.65 |     244.33 |   244.36 |
|       50000 |  489.7 ms |            102,094 |   273.07 |   414.39 |   443.13 |     443.99 |   444.07 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   27.1 ms |             36,952 |    15.16 |    23.94 |    25.80 |      26.04 |    26.04 |
|        5000 |  110.6 ms |             45,202 |    57.06 |    93.34 |   104.79 |     106.56 |   106.71 |
|       10000 |  221.1 ms |             45,234 |   107.89 |   190.10 |   211.92 |     215.58 |   215.92 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 210.8 MB
  • Settled Cooldown RSS   : 71.7 MB (Clean GC release)

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
| Yatta     |      37,154 |     1.00x |    31% | 3.94ms | 5.23ms | 6.05ms |
| Raw Bun   |      47,259 |     1.27x |    10% | 2.49ms | 3.03ms | 3.91ms |
| Hono      |      45,841 |     1.23x |    17% | 2.16ms | 4.76ms | 5.88ms |
| Elysia    |      46,888 |     1.26x |    21% | 1.77ms | 3.06ms | 3.97ms |
| Express   |      13,717 |     0.37x |    11% | 7.79ms | 10.88ms | 11.76ms |
| Fastify   |      19,708 |     0.53x |     4% | 4.99ms | 8.35ms | 10.22ms |
| Koa       |      13,935 |     0.38x |    12% | 7.94ms | 10.87ms | 11.74ms |

  Yatta dispatch adds about 5.8µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 31%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
