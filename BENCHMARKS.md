# Yatta Benchmarks

> Last run: `2026-11-05T15:21:01Z` · commit [`e5bf497`](https://github.com/psrockstar098/yatta.js/commit/e5bf49777bf983efffdf667b3ab6acc548be4c67) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 95.2 ms
  • End-to-End Runtime Task Cost    : 0.0231 ms/op
  • Peak RSS Memory        : 159.5 MB
  • RSS Heap Memory             : 96.07 MB
  • Raw Worker IPC Round-Trip      : 0.0201 ms/op
  • Scheduler + Graph Overhead     : 0.0030 ms/op
  • Settled Cooldown RSS   : 86.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.36 MB
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
| Yatta     |      57,568 |     1.00x |    18% | 1.53ms | 3.02ms | 3.70ms |
| Raw Bun   |      49,115 |     0.85x |     6% | 1.81ms | 3.76ms | 3.86ms |
| Hono      |      52,523 |     0.91x |    27% | 1.76ms | 3.78ms | 4.35ms |
| Elysia    |      50,677 |     0.88x |    21% | 1.81ms | 3.82ms | 3.95ms |
| Express   |      27,230 |     0.47x |    11% | 3.69ms | 6.19ms | 7.61ms |
| Fastify   |      38,327 |     0.67x |     3% | 2.38ms | 4.42ms | 5.14ms |
| Koa       |      29,886 |     0.52x |     7% | 3.12ms | 5.63ms | 6.41ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,804 |       0.28 |       0.31 |       0.31 |       0.31 |
|         100 |     0.8 ms |              127,073 |       0.23 |       0.56 |       0.57 |       0.57 |
|         500 |     2.1 ms |              236,648 |       1.05 |       1.69 |       1.75 |       1.76 |
|        1000 |     4.3 ms |              233,675 |       1.76 |       2.52 |       2.53 |       2.54 |
|        5000 |    20.0 ms |              249,382 |      11.26 |      12.95 |      13.75 |      13.83 |
|       10000 |    43.3 ms |              230,938 |      24.14 |      34.86 |      34.93 |      34.95 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    6.0 ms |            166,334 |     2.55 |     3.73 |     4.83 |       4.96 |     4.96 |
|        5000 |   17.9 ms |            279,618 |     8.63 |    12.49 |    12.69 |      12.75 |    12.75 |
|       10000 |   34.6 ms |            289,163 |    16.19 |    25.06 |    26.27 |      26.29 |    26.30 |
|       25000 |   78.5 ms |            318,667 |    38.11 |    55.91 |    58.69 |      58.71 |    58.72 |
|       50000 |  167.2 ms |            298,972 |    84.65 |   134.17 |   141.60 |     142.01 |   142.04 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.2 ms |            108,750 |     4.37 |     6.97 |     8.12 |       8.36 |     8.36 |
|        5000 |   35.0 ms |            142,664 |    16.33 |    26.95 |    27.72 |      27.77 |    27.78 |
|       10000 |   72.9 ms |            137,262 |    38.32 |    59.70 |    61.38 |      61.44 |    61.44 |
|       25000 |  184.8 ms |            135,305 |    95.40 |   162.37 |   170.55 |     170.94 |   170.97 |
|       50000 |  384.1 ms |            130,172 |   200.87 |   323.02 |   348.93 |     349.51 |   349.57 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.0 ms |             58,704 |     9.09 |    15.11 |    16.23 |      16.41 |    16.41 |
|        5000 |   71.6 ms |             69,815 |    36.39 |    62.88 |    68.27 |      69.17 |    69.26 |
|       10000 |  161.6 ms |             61,893 |    71.55 |   136.86 |   155.43 |     156.86 |   157.09 |

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
  • Raw Worker IPC Round-Trip      : 0.0201 ms/op
  • End-to-End Runtime Task Cost    : 0.0231 ms/op
  • Scheduler + Graph Overhead     : 0.0030 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               17,804 |       0.28 |       0.31 |       0.31 |       0.31 |
|         100 |     0.8 ms |              127,073 |       0.23 |       0.56 |       0.57 |       0.57 |
|         500 |     2.1 ms |              236,648 |       1.05 |       1.69 |       1.75 |       1.76 |
|        1000 |     4.3 ms |              233,675 |       1.76 |       2.52 |       2.53 |       2.54 |
|        5000 |    20.0 ms |              249,382 |      11.26 |      12.95 |      13.75 |      13.83 |
|       10000 |    43.3 ms |              230,938 |      24.14 |      34.86 |      34.93 |      34.95 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.10 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.07 MB
  • V8/JSC Heap Used             : 13.36 MB

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
| 1 CPU + 1 IO  |       2 |   48.8 ms |            204,857 |    24.32 |    39.66 |    40.11 |    40.20 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   42.8 ms |            233,762 |    21.45 |    30.71 |    30.77 |    30.78 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   33.0 ms |            302,818 |    16.10 |    23.96 |    24.34 |    24.96 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   38.6 ms |            258,999 |    19.81 |    29.47 |    29.69 |    29.88 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 95.2 ms
  • Peak Throughput Rate       : 262,667 ops/sec
  • Latency Distribution       : p50: 44.35ms | p90: 72.93ms | p99: 75.19ms | p99.9: 75.35ms | Max: 75.36ms
  • Memory (RSS)               : Baseline: 100.1 MB | Peak: 129.7 MB | Cooldown: 103.1 MB

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
|        1000 |    6.0 ms |            166,334 |     2.55 |     3.73 |     4.83 |       4.96 |     4.96 |
|        5000 |   17.9 ms |            279,618 |     8.63 |    12.49 |    12.69 |      12.75 |    12.75 |
|       10000 |   34.6 ms |            289,163 |    16.19 |    25.06 |    26.27 |      26.29 |    26.30 |
|       25000 |   78.5 ms |            318,667 |    38.11 |    55.91 |    58.69 |      58.71 |    58.72 |
|       50000 |  167.2 ms |            298,972 |    84.65 |   134.17 |   141.60 |     142.01 |   142.04 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.2 ms |            108,750 |     4.37 |     6.97 |     8.12 |       8.36 |     8.36 |
|        5000 |   35.0 ms |            142,664 |    16.33 |    26.95 |    27.72 |      27.77 |    27.78 |
|       10000 |   72.9 ms |            137,262 |    38.32 |    59.70 |    61.38 |      61.44 |    61.44 |
|       25000 |  184.8 ms |            135,305 |    95.40 |   162.37 |   170.55 |     170.94 |   170.97 |
|       50000 |  384.1 ms |            130,172 |   200.87 |   323.02 |   348.93 |     349.51 |   349.57 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   17.0 ms |             58,704 |     9.09 |    15.11 |    16.23 |      16.41 |    16.41 |
|        5000 |   71.6 ms |             69,815 |    36.39 |    62.88 |    68.27 |      69.17 |    69.26 |
|       10000 |  161.6 ms |             61,893 |    71.55 |   136.86 |   155.43 |     156.86 |   157.09 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 159.5 MB
  • Settled Cooldown RSS   : 86.3 MB (Clean GC release)

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
| Yatta     |      57,568 |     1.00x |    18% | 1.53ms | 3.02ms | 3.70ms |
| Raw Bun   |      49,115 |     0.85x |     6% | 1.81ms | 3.76ms | 3.86ms |
| Hono      |      52,523 |     0.91x |    27% | 1.76ms | 3.78ms | 4.35ms |
| Elysia    |      50,677 |     0.88x |    21% | 1.81ms | 3.82ms | 3.95ms |
| Express   |      27,230 |     0.47x |    11% | 3.69ms | 6.19ms | 7.61ms |
| Fastify   |      38,327 |     0.67x |     3% | 2.38ms | 4.42ms | 5.14ms |
| Koa       |      29,886 |     0.52x |     7% | 3.12ms | 5.63ms | 6.41ms |

  Yatta dispatch adds about -3.0µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 18%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
