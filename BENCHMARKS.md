# Yatta Benchmarks

> Last run: `2026-11-01T13:50:08Z` · commit [`2ac7476`](https://github.com/psrockstar098/yatta.js/commit/2ac7476529efd7c0438aefd29fb402ea60ebe6a0) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 112.0 ms
  • End-to-End Runtime Task Cost    : 0.0485 ms/op
  • Peak RSS Memory        : 130.0 MB
  • RSS Heap Memory             : 77.52 MB
  • Raw Worker IPC Round-Trip      : 0.0356 ms/op
  • Scheduler + Graph Overhead     : 0.0129 ms/op
  • Settled Cooldown RSS   : 70.5 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
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
| Yatta     |      39,549 |     1.00x |     2% | 2.16ms | 4.31ms | 4.73ms |
| Raw Bun   |      46,324 |     1.17x |    18% | 2.10ms | 3.46ms | 4.00ms |
| Hono      |      41,611 |     1.05x |    37% | 2.08ms | 3.99ms | 4.86ms |
| Elysia    |      44,542 |     1.13x |    20% | 2.04ms | 4.39ms | 4.95ms |
| Express   |      13,839 |     0.35x |     8% | 6.54ms | 11.45ms | 13.22ms |
| Fastify   |      19,696 |     0.50x |    12% | 4.49ms | 8.85ms | 9.92ms |
| Koa       |      15,482 |     0.39x |     7% | 6.83ms | 10.17ms | 11.37ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,847 |       0.35 |       0.36 |       0.36 |       0.36 |
|         100 |     0.8 ms |              126,949 |       0.32 |       0.50 |       0.52 |       0.52 |
|         500 |     2.3 ms |              221,013 |       1.07 |       1.54 |       1.63 |       1.68 |
|        1000 |     4.0 ms |              247,449 |       1.96 |       3.25 |       3.40 |       3.44 |
|        5000 |    24.6 ms |              203,432 |      12.68 |      17.60 |      17.85 |      17.91 |
|       10000 |    49.1 ms |              203,600 |      27.27 |      41.23 |      41.80 |      41.81 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |    9.7 ms |            102,943 |     3.99 |     5.82 |     7.79 |       7.98 |     7.98 |
|        5000 |   25.0 ms |            199,919 |    11.85 |    16.27 |    16.79 |      16.79 |    16.80 |
|       10000 |   53.5 ms |            187,065 |    26.70 |    40.20 |    43.02 |      43.14 |    43.16 |
|       25000 |  119.3 ms |            209,555 |    58.49 |    88.21 |    93.22 |      93.35 |    93.36 |
|       50000 |  211.3 ms |            236,603 |   107.18 |   160.34 |   176.56 |     177.08 |   177.10 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.5 ms |             73,931 |     6.66 |    10.32 |    11.99 |      12.19 |    12.19 |
|        5000 |   53.9 ms |             92,830 |    26.45 |    40.73 |    42.01 |      42.06 |    42.07 |
|       10000 |  110.7 ms |             90,372 |    58.07 |    93.95 |    97.60 |      97.69 |    97.70 |
|       25000 |  253.9 ms |             98,451 |   133.52 |   221.46 |   233.46 |     233.67 |   233.72 |
|       50000 |  502.1 ms |             99,591 |   262.63 |   419.41 |   453.93 |     455.51 |   455.59 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.5 ms |             32,787 |    17.18 |    27.17 |    29.41 |      29.68 |    29.68 |
|        5000 |  125.1 ms |             39,957 |    59.32 |   109.77 |   119.65 |     120.57 |   120.70 |
|       10000 |  223.5 ms |             44,738 |   115.17 |   192.58 |   213.99 |     217.09 |   217.34 |

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
  • Raw Worker IPC Round-Trip      : 0.0356 ms/op
  • End-to-End Runtime Task Cost    : 0.0485 ms/op
  • Scheduler + Graph Overhead     : 0.0129 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               12,847 |       0.35 |       0.36 |       0.36 |       0.36 |
|         100 |     0.8 ms |              126,949 |       0.32 |       0.50 |       0.52 |       0.52 |
|         500 |     2.3 ms |              221,013 |       1.07 |       1.54 |       1.63 |       1.68 |
|        1000 |     4.0 ms |              247,449 |       1.96 |       3.25 |       3.40 |       3.44 |
|        5000 |    24.6 ms |              203,432 |      12.68 |      17.60 |      17.85 |      17.91 |
|       10000 |    49.1 ms |              203,600 |      27.27 |      41.23 |      41.80 |      41.81 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.13 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.52 MB
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
| 1 CPU + 1 IO  |       2 |   57.1 ms |            175,267 |    26.56 |    43.19 |    43.78 |    44.17 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   56.7 ms |            176,282 |    31.49 |    45.91 |    48.26 |    48.55 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   42.7 ms |            234,033 |    17.69 |    34.33 |    35.00 |    35.14 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   41.7 ms |            239,589 |    21.73 |    32.88 |    33.07 |    33.09 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 112.0 ms
  • Peak Throughput Rate       : 223,178 ops/sec
  • Latency Distribution       : p50: 53.30ms | p90: 91.44ms | p99: 92.04ms | p99.9: 92.13ms | Max: 92.15ms
  • Memory (RSS)               : Baseline: 104.8 MB | Peak: 121.8 MB | Cooldown: 78.3 MB

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
|        1000 |    9.7 ms |            102,943 |     3.99 |     5.82 |     7.79 |       7.98 |     7.98 |
|        5000 |   25.0 ms |            199,919 |    11.85 |    16.27 |    16.79 |      16.79 |    16.80 |
|       10000 |   53.5 ms |            187,065 |    26.70 |    40.20 |    43.02 |      43.14 |    43.16 |
|       25000 |  119.3 ms |            209,555 |    58.49 |    88.21 |    93.22 |      93.35 |    93.36 |
|       50000 |  211.3 ms |            236,603 |   107.18 |   160.34 |   176.56 |     177.08 |   177.10 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.5 ms |             73,931 |     6.66 |    10.32 |    11.99 |      12.19 |    12.19 |
|        5000 |   53.9 ms |             92,830 |    26.45 |    40.73 |    42.01 |      42.06 |    42.07 |
|       10000 |  110.7 ms |             90,372 |    58.07 |    93.95 |    97.60 |      97.69 |    97.70 |
|       25000 |  253.9 ms |             98,451 |   133.52 |   221.46 |   233.46 |     233.67 |   233.72 |
|       50000 |  502.1 ms |             99,591 |   262.63 |   419.41 |   453.93 |     455.51 |   455.59 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.5 ms |             32,787 |    17.18 |    27.17 |    29.41 |      29.68 |    29.68 |
|        5000 |  125.1 ms |             39,957 |    59.32 |   109.77 |   119.65 |     120.57 |   120.70 |
|       10000 |  223.5 ms |             44,738 |   115.17 |   192.58 |   213.99 |     217.09 |   217.34 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 130.0 MB
  • Settled Cooldown RSS   : 70.5 MB (Clean GC release)

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
| Yatta     |      39,549 |     1.00x |     2% | 2.16ms | 4.31ms | 4.73ms |
| Raw Bun   |      46,324 |     1.17x |    18% | 2.10ms | 3.46ms | 4.00ms |
| Hono      |      41,611 |     1.05x |    37% | 2.08ms | 3.99ms | 4.86ms |
| Elysia    |      44,542 |     1.13x |    20% | 2.04ms | 4.39ms | 4.95ms |
| Express   |      13,839 |     0.35x |     8% | 6.54ms | 11.45ms | 13.22ms |
| Fastify   |      19,696 |     0.50x |    12% | 4.49ms | 8.85ms | 9.92ms |
| Koa       |      15,482 |     0.39x |     7% | 6.83ms | 10.17ms | 11.37ms |

  Yatta dispatch adds about 3.7µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
