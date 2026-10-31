# Yatta Benchmarks

> Last run: `2026-10-31T19:51:44Z` · commit [`4f8ddf0`](https://github.com/psrockstar098/yatta.js/commit/4f8ddf037798f454caa93dfff382bf92ec15cead) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 88.6 ms
  • End-to-End Runtime Task Cost    : 0.0338 ms/op
  • Peak RSS Memory        : 166.5 MB
  • RSS Heap Memory             : 96.66 MB
  • Raw Worker IPC Round-Trip      : 0.0212 ms/op
  • Scheduler + Graph Overhead     : 0.0126 ms/op
  • Settled Cooldown RSS   : 71.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 13.95 MB
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
| Yatta     |      59,718 |     1.00x |    38% | 2.60ms | 3.51ms | 4.41ms |
| Raw Bun   |      66,835 |     1.12x |    11% | 1.51ms | 2.46ms | 3.19ms |
| Hono      |      58,888 |     0.99x |    29% | 1.55ms | 2.83ms | 3.01ms |
| Elysia    |      68,873 |     1.15x |    22% | 1.32ms | 2.28ms | 2.64ms |
| Express   |      21,298 |     0.36x |     9% | 4.21ms | 8.00ms | 9.11ms |
| Fastify   |      29,406 |     0.49x |     6% | 3.11ms | 6.11ms | 6.86ms |
| Koa       |      22,344 |     0.37x |    11% | 4.31ms | 7.23ms | 8.58ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,665 |       0.31 |       0.32 |       0.32 |       0.32 |
|         100 |     0.6 ms |              177,173 |       0.25 |       0.37 |       0.39 |       0.39 |
|         500 |     2.3 ms |              220,548 |       0.86 |       1.31 |       1.39 |       1.39 |
|        1000 |     3.6 ms |              275,735 |       1.90 |       2.67 |       2.69 |       2.71 |
|        5000 |    20.5 ms |              244,184 |      10.92 |      14.26 |      14.47 |      14.52 |
|       10000 |    40.2 ms |              249,038 |      21.80 |      32.19 |      32.26 |      32.32 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    7.2 ms |            139,203 |     3.05 |     4.56 |     5.56 |       6.00 |     6.00 |
|        5000 |   19.7 ms |            253,271 |     9.70 |    13.25 |    13.77 |      13.78 |    13.78 |
|       10000 |   46.1 ms |            217,128 |    18.28 |    34.81 |    35.75 |      35.77 |    35.77 |
|       25000 |   85.6 ms |            292,200 |    42.50 |    61.86 |    65.64 |      65.91 |    65.92 |
|       50000 |  159.4 ms |            313,722 |    84.85 |   119.65 |   123.51 |     125.62 |   125.71 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             83,788 |     6.00 |     9.12 |    10.61 |      10.71 |    10.71 |
|        5000 |   36.5 ms |            136,824 |    18.68 |    28.37 |    29.44 |      29.45 |    29.46 |
|       10000 |   96.3 ms |            103,851 |    53.02 |    81.67 |    84.34 |      84.36 |    84.36 |
|       25000 |  259.4 ms |             96,388 |   141.41 |   225.55 |   236.79 |     236.96 |   236.99 |
|       50000 |  464.5 ms |            107,632 |   242.27 |   398.58 |   424.61 |     426.73 |   427.38 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   29.0 ms |             34,511 |    17.39 |    23.77 |    27.03 |      27.34 |    27.34 |
|        5000 |   83.9 ms |             59,560 |    40.45 |    65.95 |    74.10 |      80.92 |    81.04 |
|       10000 |  168.6 ms |             59,306 |    78.89 |   138.14 |   160.70 |     163.78 |   164.07 |

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
  • Raw Worker IPC Round-Trip      : 0.0212 ms/op
  • End-to-End Runtime Task Cost    : 0.0338 ms/op
  • Scheduler + Graph Overhead     : 0.0126 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.6 ms |               16,665 |       0.31 |       0.32 |       0.32 |       0.32 |
|         100 |     0.6 ms |              177,173 |       0.25 |       0.37 |       0.39 |       0.39 |
|         500 |     2.3 ms |              220,548 |       0.86 |       1.31 |       1.39 |       1.39 |
|        1000 |     3.6 ms |              275,735 |       1.90 |       2.67 |       2.69 |       2.71 |
|        5000 |    20.5 ms |              244,184 |      10.92 |      14.26 |      14.47 |      14.52 |
|       10000 |    40.2 ms |              249,038 |      21.80 |      32.19 |      32.26 |      32.32 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.11 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 96.66 MB
  • V8/JSC Heap Used             : 13.95 MB

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
| 1 CPU + 1 IO  |       2 |   48.6 ms |            205,867 |    23.83 |    36.41 |    38.77 |    38.90 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   37.8 ms |            264,219 |    19.12 |    26.47 |    27.05 |    27.08 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   39.4 ms |            253,509 |    19.45 |    31.67 |    32.62 |    33.03 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   34.1 ms |            292,954 |    17.84 |    25.44 |    26.00 |    26.23 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 88.6 ms
  • Peak Throughput Rate       : 282,028 ops/sec
  • Latency Distribution       : p50: 43.97ms | p90: 68.25ms | p99: 70.08ms | p99.9: 70.11ms | Max: 70.11ms
  • Memory (RSS)               : Baseline: 104.9 MB | Peak: 130.9 MB | Cooldown: 102.3 MB

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
|        1000 |    7.2 ms |            139,203 |     3.05 |     4.56 |     5.56 |       6.00 |     6.00 |
|        5000 |   19.7 ms |            253,271 |     9.70 |    13.25 |    13.77 |      13.78 |    13.78 |
|       10000 |   46.1 ms |            217,128 |    18.28 |    34.81 |    35.75 |      35.77 |    35.77 |
|       25000 |   85.6 ms |            292,200 |    42.50 |    61.86 |    65.64 |      65.91 |    65.92 |
|       50000 |  159.4 ms |            313,722 |    84.85 |   119.65 |   123.51 |     125.62 |   125.71 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             83,788 |     6.00 |     9.12 |    10.61 |      10.71 |    10.71 |
|        5000 |   36.5 ms |            136,824 |    18.68 |    28.37 |    29.44 |      29.45 |    29.46 |
|       10000 |   96.3 ms |            103,851 |    53.02 |    81.67 |    84.34 |      84.36 |    84.36 |
|       25000 |  259.4 ms |             96,388 |   141.41 |   225.55 |   236.79 |     236.96 |   236.99 |
|       50000 |  464.5 ms |            107,632 |   242.27 |   398.58 |   424.61 |     426.73 |   427.38 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   29.0 ms |             34,511 |    17.39 |    23.77 |    27.03 |      27.34 |    27.34 |
|        5000 |   83.9 ms |             59,560 |    40.45 |    65.95 |    74.10 |      80.92 |    81.04 |
|       10000 |  168.6 ms |             59,306 |    78.89 |   138.14 |   160.70 |     163.78 |   164.07 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 166.5 MB
  • Settled Cooldown RSS   : 71.9 MB (Clean GC release)

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
| Yatta     |      59,718 |     1.00x |    38% | 2.60ms | 3.51ms | 4.41ms |
| Raw Bun   |      66,835 |     1.12x |    11% | 1.51ms | 2.46ms | 3.19ms |
| Hono      |      58,888 |     0.99x |    29% | 1.55ms | 2.83ms | 3.01ms |
| Elysia    |      68,873 |     1.15x |    22% | 1.32ms | 2.28ms | 2.64ms |
| Express   |      21,298 |     0.36x |     9% | 4.21ms | 8.00ms | 9.11ms |
| Fastify   |      29,406 |     0.49x |     6% | 3.11ms | 6.11ms | 6.86ms |
| Koa       |      22,344 |     0.37x |    11% | 4.31ms | 7.23ms | 8.58ms |

  Yatta dispatch adds about 1.8µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 38%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
