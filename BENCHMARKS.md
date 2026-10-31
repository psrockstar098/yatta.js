# Yatta Benchmarks

> Last run: `2026-10-31T19:10:21Z` · commit [`672a5ba`](https://github.com/psrockstar098/yatta.js/commit/672a5baa6af585108260100f1ba41dc395ab44a5) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 135.8 ms
  • End-to-End Runtime Task Cost    : 0.0425 ms/op
  • Peak RSS Memory        : 120.6 MB
  • RSS Heap Memory             : 77.05 MB
  • Raw Worker IPC Round-Trip      : 0.0322 ms/op
  • Scheduler + Graph Overhead     : 0.0103 ms/op
  • Settled Cooldown RSS   : 82.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      41,585 |     1.00x |     9% | 2.21ms | 4.45ms | 5.24ms |
| Raw Bun   |      52,211 |     1.26x |    19% | 2.09ms | 4.33ms | 4.62ms |
| Hono      |      49,999 |     1.20x |     7% | 1.97ms | 3.15ms | 3.73ms |
| Elysia    |      48,715 |     1.17x |     5% | 2.15ms | 3.44ms | 4.39ms |
| Express   |      15,222 |     0.37x |     8% | 5.83ms | 10.73ms | 11.75ms |
| Fastify   |      20,852 |     0.50x |     1% | 4.52ms | 7.95ms | 8.98ms |
| Koa       |      16,019 |     0.39x |     6% | 6.74ms | 9.37ms | 10.25ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,610 |       0.34 |       0.38 |       0.38 |       0.38 |
|         100 |     1.3 ms |               77,822 |       0.41 |       0.85 |       0.87 |       0.87 |
|         500 |     1.8 ms |              282,893 |       0.91 |       1.34 |       1.39 |       1.44 |
|        1000 |     3.9 ms |              259,657 |       1.96 |       2.87 |       2.92 |       2.94 |
|        5000 |    25.8 ms |              193,433 |      13.12 |      18.75 |      18.80 |      18.82 |
|       10000 |    43.1 ms |              232,000 |      23.09 |      34.10 |      34.68 |      34.83 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   11.9 ms |             84,360 |     4.88 |     7.71 |     9.45 |       9.75 |     9.75 |
|        5000 |   28.1 ms |            178,081 |    12.39 |    14.98 |    15.53 |      16.15 |    16.29 |
|       10000 |   67.4 ms |            148,417 |    30.55 |    49.51 |    51.97 |      52.03 |    52.04 |
|       25000 |  120.5 ms |            207,464 |    58.07 |    82.38 |    87.48 |      87.52 |    87.53 |
|       50000 |  194.0 ms |            257,737 |    95.01 |   154.27 |   163.93 |     164.45 |   164.49 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.3 ms |             75,256 |     6.37 |     9.08 |    10.40 |      10.57 |    10.57 |
|        5000 |   54.4 ms |             91,843 |    27.02 |    42.83 |    43.94 |      44.00 |    44.00 |
|       10000 |  105.6 ms |             94,654 |    53.56 |    86.61 |    90.60 |      90.67 |    90.67 |
|       25000 |  284.4 ms |             87,891 |   145.08 |   242.12 |   251.65 |     252.03 |   252.05 |
|       50000 |  454.1 ms |            110,104 |   220.17 |   379.54 |   416.03 |     417.09 |   417.36 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.6 ms |             27,342 |    14.05 |    32.90 |    35.28 |      35.58 |    35.58 |
|        5000 |  108.9 ms |             45,912 |    55.99 |    90.97 |    98.86 |     103.96 |   104.10 |
|       10000 |  206.6 ms |             48,409 |   103.14 |   177.45 |   195.60 |     198.93 |   199.22 |

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
  • Raw Worker IPC Round-Trip      : 0.0322 ms/op
  • End-to-End Runtime Task Cost    : 0.0425 ms/op
  • Scheduler + Graph Overhead     : 0.0103 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.7 ms |               13,610 |       0.34 |       0.38 |       0.38 |       0.38 |
|         100 |     1.3 ms |               77,822 |       0.41 |       0.85 |       0.87 |       0.87 |
|         500 |     1.8 ms |              282,893 |       0.91 |       1.34 |       1.39 |       1.44 |
|        1000 |     3.9 ms |              259,657 |       1.96 |       2.87 |       2.92 |       2.94 |
|        5000 |    25.8 ms |              193,433 |      13.12 |      18.75 |      18.80 |      18.82 |
|       10000 |    43.1 ms |              232,000 |      23.09 |      34.10 |      34.68 |      34.83 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.15 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.05 MB
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
| 1 CPU + 1 IO  |       2 |   61.5 ms |            162,635 |    28.81 |    45.93 |    47.88 |    47.96 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   56.2 ms |            178,072 |    29.80 |    41.32 |    41.37 |    41.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   45.7 ms |            219,023 |    21.62 |    34.64 |    35.74 |    36.38 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   44.0 ms |            227,417 |    23.85 |    35.58 |    35.61 |    35.62 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 135.8 ms
  • Peak Throughput Rate       : 184,052 ops/sec
  • Latency Distribution       : p50: 69.94ms | p90: 107.43ms | p99: 110.40ms | p99.9: 112.19ms | Max: 112.22ms
  • Memory (RSS)               : Baseline: 104.7 MB | Peak: 134.4 MB | Cooldown: 105.2 MB

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
|        1000 |   11.9 ms |             84,360 |     4.88 |     7.71 |     9.45 |       9.75 |     9.75 |
|        5000 |   28.1 ms |            178,081 |    12.39 |    14.98 |    15.53 |      16.15 |    16.29 |
|       10000 |   67.4 ms |            148,417 |    30.55 |    49.51 |    51.97 |      52.03 |    52.04 |
|       25000 |  120.5 ms |            207,464 |    58.07 |    82.38 |    87.48 |      87.52 |    87.53 |
|       50000 |  194.0 ms |            257,737 |    95.01 |   154.27 |   163.93 |     164.45 |   164.49 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.3 ms |             75,256 |     6.37 |     9.08 |    10.40 |      10.57 |    10.57 |
|        5000 |   54.4 ms |             91,843 |    27.02 |    42.83 |    43.94 |      44.00 |    44.00 |
|       10000 |  105.6 ms |             94,654 |    53.56 |    86.61 |    90.60 |      90.67 |    90.67 |
|       25000 |  284.4 ms |             87,891 |   145.08 |   242.12 |   251.65 |     252.03 |   252.05 |
|       50000 |  454.1 ms |            110,104 |   220.17 |   379.54 |   416.03 |     417.09 |   417.36 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   36.6 ms |             27,342 |    14.05 |    32.90 |    35.28 |      35.58 |    35.58 |
|        5000 |  108.9 ms |             45,912 |    55.99 |    90.97 |    98.86 |     103.96 |   104.10 |
|       10000 |  206.6 ms |             48,409 |   103.14 |   177.45 |   195.60 |     198.93 |   199.22 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 120.6 MB
  • Settled Cooldown RSS   : 82.3 MB (Clean GC release)

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
| Yatta     |      41,585 |     1.00x |     9% | 2.21ms | 4.45ms | 5.24ms |
| Raw Bun   |      52,211 |     1.26x |    19% | 2.09ms | 4.33ms | 4.62ms |
| Hono      |      49,999 |     1.20x |     7% | 1.97ms | 3.15ms | 3.73ms |
| Elysia    |      48,715 |     1.17x |     5% | 2.15ms | 3.44ms | 4.39ms |
| Express   |      15,222 |     0.37x |     8% | 5.83ms | 10.73ms | 11.75ms |
| Fastify   |      20,852 |     0.50x |     1% | 4.52ms | 7.95ms | 8.98ms |
| Koa       |      16,019 |     0.39x |     6% | 6.74ms | 9.37ms | 10.25ms |

  Yatta dispatch adds about 4.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
