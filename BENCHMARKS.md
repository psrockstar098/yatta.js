# Yatta Benchmarks

> Last run: `2026-11-05T03:03:07Z` · commit [`3206c53`](https://github.com/psrockstar098/yatta.js/commit/3206c53442b0fc86926bfd1f3c0c2a12380ad560) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 98.2 ms
  • End-to-End Runtime Task Cost    : 0.0399 ms/op
  • Peak RSS Memory        : 138.3 MB
  • RSS Heap Memory             : 77.18 MB
  • Raw Worker IPC Round-Trip      : 0.0343 ms/op
  • Scheduler + Graph Overhead     : 0.0056 ms/op
  • Settled Cooldown RSS   : 72.3 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      43,808 |     1.00x |    25% | 2.71ms | 4.73ms | 5.56ms |
| Raw Bun   |      42,690 |     0.97x |    12% | 2.44ms | 4.86ms | 6.02ms |
| Hono      |      50,665 |     1.16x |    19% | 1.85ms | 3.27ms | 4.43ms |
| Elysia    |      44,989 |     1.03x |     7% | 1.82ms | 4.33ms | 4.80ms |
| Express   |      16,103 |     0.37x |     8% | 7.04ms | 10.18ms | 11.46ms |
| Fastify   |      20,604 |     0.47x |     9% | 4.08ms | 7.71ms | 8.90ms |
| Koa       |      16,034 |     0.37x |     2% | 6.38ms | 9.35ms | 10.84ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,079 |       0.36 |       0.39 |       0.39 |       0.39 |
|         100 |     0.7 ms |              135,549 |       0.28 |       0.43 |       0.47 |       0.47 |
|         500 |     2.0 ms |              252,475 |       0.93 |       1.46 |       1.55 |       1.59 |
|        1000 |     3.9 ms |              259,382 |       2.03 |       3.07 |       3.22 |       3.26 |
|        5000 |    23.1 ms |              216,465 |      12.41 |      16.20 |      17.02 |      17.08 |
|       10000 |    59.5 ms |              168,179 |      30.40 |      47.92 |      48.16 |      48.29 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   13.3 ms |             74,999 |     5.07 |     9.72 |    11.87 |      12.03 |    12.03 |
|        5000 |   21.3 ms |            235,205 |     9.84 |    13.51 |    14.01 |      14.02 |    14.03 |
|       10000 |   48.5 ms |            205,993 |    22.95 |    37.22 |    39.16 |      39.28 |    39.28 |
|       25000 |   98.5 ms |            253,807 |    48.67 |    71.02 |    74.62 |      75.17 |    75.18 |
|       50000 |  196.9 ms |            253,899 |    98.68 |   152.84 |   161.54 |     161.95 |   161.99 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             78,629 |     6.47 |     9.62 |    11.29 |      11.55 |    11.55 |
|        5000 |   46.5 ms |            107,523 |    23.87 |    35.24 |    36.34 |      36.39 |    36.39 |
|       10000 |   94.3 ms |            106,073 |    45.93 |    78.01 |    80.30 |      80.38 |    80.40 |
|       25000 |  246.0 ms |            101,620 |   130.02 |   215.07 |   225.82 |     226.29 |   226.31 |
|       50000 |  442.3 ms |            113,057 |   241.22 |   377.03 |   404.14 |     405.26 |   405.33 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.3 ms |             38,080 |    14.40 |    23.22 |    24.95 |      25.26 |    25.26 |
|        5000 |  102.0 ms |             49,031 |    47.14 |    88.52 |    98.30 |      99.65 |    99.76 |
|       10000 |  224.8 ms |             44,489 |    99.95 |   192.46 |   211.41 |     220.53 |   220.89 |

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
  • End-to-End Runtime Task Cost    : 0.0399 ms/op
  • Scheduler + Graph Overhead     : 0.0056 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               13,079 |       0.36 |       0.39 |       0.39 |       0.39 |
|         100 |     0.7 ms |              135,549 |       0.28 |       0.43 |       0.47 |       0.47 |
|         500 |     2.0 ms |              252,475 |       0.93 |       1.46 |       1.55 |       1.59 |
|        1000 |     3.9 ms |              259,382 |       2.03 |       3.07 |       3.22 |       3.26 |
|        5000 |    23.1 ms |              216,465 |      12.41 |      16.20 |      17.02 |      17.08 |
|       10000 |    59.5 ms |              168,179 |      30.40 |      47.92 |      48.16 |      48.29 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.14 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 77.18 MB
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
| 1 CPU + 1 IO  |       2 |   47.2 ms |            211,785 |    21.21 |    36.34 |    36.99 |    37.07 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   46.0 ms |            217,156 |    22.33 |    36.00 |    36.22 |    36.24 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   33.3 ms |            300,436 |    15.61 |    25.66 |    26.34 |    26.45 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   38.1 ms |            262,426 |    19.47 |    30.00 |    30.20 |    30.44 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 98.2 ms
  • Peak Throughput Rate       : 254,572 ops/sec
  • Latency Distribution       : p50: 48.71ms | p90: 77.71ms | p99: 78.98ms | p99.9: 79.03ms | Max: 79.03ms
  • Memory (RSS)               : Baseline: 103.4 MB | Peak: 129.7 MB | Cooldown: 102.9 MB

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
|        1000 |   13.3 ms |             74,999 |     5.07 |     9.72 |    11.87 |      12.03 |    12.03 |
|        5000 |   21.3 ms |            235,205 |     9.84 |    13.51 |    14.01 |      14.02 |    14.03 |
|       10000 |   48.5 ms |            205,993 |    22.95 |    37.22 |    39.16 |      39.28 |    39.28 |
|       25000 |   98.5 ms |            253,807 |    48.67 |    71.02 |    74.62 |      75.17 |    75.18 |
|       50000 |  196.9 ms |            253,899 |    98.68 |   152.84 |   161.54 |     161.95 |   161.99 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   12.7 ms |             78,629 |     6.47 |     9.62 |    11.29 |      11.55 |    11.55 |
|        5000 |   46.5 ms |            107,523 |    23.87 |    35.24 |    36.34 |      36.39 |    36.39 |
|       10000 |   94.3 ms |            106,073 |    45.93 |    78.01 |    80.30 |      80.38 |    80.40 |
|       25000 |  246.0 ms |            101,620 |   130.02 |   215.07 |   225.82 |     226.29 |   226.31 |
|       50000 |  442.3 ms |            113,057 |   241.22 |   377.03 |   404.14 |     405.26 |   405.33 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   26.3 ms |             38,080 |    14.40 |    23.22 |    24.95 |      25.26 |    25.26 |
|        5000 |  102.0 ms |             49,031 |    47.14 |    88.52 |    98.30 |      99.65 |    99.76 |
|       10000 |  224.8 ms |             44,489 |    99.95 |   192.46 |   211.41 |     220.53 |   220.89 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 138.3 MB
  • Settled Cooldown RSS   : 72.3 MB (Clean GC release)

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
| Yatta     |      43,808 |     1.00x |    25% | 2.71ms | 4.73ms | 5.56ms |
| Raw Bun   |      42,690 |     0.97x |    12% | 2.44ms | 4.86ms | 6.02ms |
| Hono      |      50,665 |     1.16x |    19% | 1.85ms | 3.27ms | 4.43ms |
| Elysia    |      44,989 |     1.03x |     7% | 1.82ms | 4.33ms | 4.80ms |
| Express   |      16,103 |     0.37x |     8% | 7.04ms | 10.18ms | 11.46ms |
| Fastify   |      20,604 |     0.47x |     9% | 4.08ms | 7.71ms | 8.90ms |
| Koa       |      16,034 |     0.37x |     2% | 6.38ms | 9.35ms | 10.84ms |

  Yatta dispatch adds about -0.6µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Note: Yatta's own spread is 25%, so differences smaller
  than that are not resolved by this benchmark. Read the spread column.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
