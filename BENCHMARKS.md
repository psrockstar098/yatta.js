# Yatta Benchmarks

> Last run: `2026-11-05T14:53:40Z` · commit [`83b5ae5`](https://github.com/psrockstar098/yatta.js/commit/83b5ae5a7b338228797c6188507cce9dca681f78) · `ubuntu-latest`, Bun 1.4.2
>
> Benchmarks run on every push to `main` and weekly via GitHub Actions.
> Numbers come from shared CI runners, so treat them as relative — the trend matters more than any single value.

## Headline metrics

```
  • 25,000 Tasks Completed in  : 142.1 ms
  • End-to-End Runtime Task Cost    : 0.0401 ms/op
  • Peak RSS Memory        : 203.3 MB
  • RSS Heap Memory             : 80.75 MB
  • Raw Worker IPC Round-Trip      : 0.0359 ms/op
  • Scheduler + Graph Overhead     : 0.0042 ms/op
  • Settled Cooldown RSS   : 71.9 MB (Clean GC release)
  • V8/JSC Heap Used             : 0.78 MB
  • Worker Fleet Event Loop Lag : 10.98 ms (Zero event-loop freezing ⚡)
```

## Framework comparison

Head-to-head HTTP throughput: one `GET /json` route per framework,
20,000 requests at 100 concurrent connections (keep-alive).
Each framework is measured in its own process, three times, and the median is
reported. `Spread` is how far apart a framework's own runs were — if two
frameworks are within each other's spread, the data does not separate them.

| Framework | Requests/sec | vs Yatta | Spread | p50 | p95 | p99 |
|-----------|-------------:|---------:|-------:|----:|----:|----:|
| Yatta     |      41,167 |     1.00x |     8% | 2.20ms | 4.70ms | 5.34ms |
| Raw Bun   |      44,703 |     1.09x |    21% | 2.13ms | 4.61ms | 4.81ms |
| Hono      |      45,644 |     1.11x |    11% | 1.94ms | 3.84ms | 4.35ms |
| Elysia    |      47,722 |     1.16x |    24% | 2.07ms | 3.71ms | 4.82ms |
| Express   |      14,257 |     0.35x |     5% | 6.18ms | 11.13ms | 12.26ms |
| Fastify   |      20,016 |     0.49x |     1% | 4.87ms | 8.45ms | 9.32ms |
| Koa       |      15,786 |     0.38x |    10% | 6.07ms | 9.81ms | 11.49ms |

## Throughput ladder (worker runtime)

Fast-ping tasks through the worker fleet, 10 → 10,000 concurrent:

| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               11,965 |       0.41 |       0.45 |       0.45 |       0.45 |
|         100 |     1.4 ms |               71,137 |       0.41 |       0.95 |       0.96 |       0.96 |
|         500 |     2.1 ms |              240,118 |       1.05 |       1.58 |       1.61 |       1.63 |
|        1000 |     4.2 ms |              238,133 |       2.15 |       3.13 |       3.14 |       3.15 |
|        5000 |    29.3 ms |              170,746 |      16.04 |      20.30 |      20.86 |      20.88 |
|       10000 |    53.9 ms |              185,535 |      26.74 |      42.45 |      42.72 |      42.74 |

## Real-world workloads

JSON payload transformation and micro-compute tasks:

| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   10.2 ms |             97,869 |     4.36 |     6.39 |     7.87 |       8.25 |     8.25 |
|        5000 |   26.0 ms |            192,595 |    11.74 |    16.44 |    17.00 |      17.03 |    17.03 |
|       10000 |   61.9 ms |            161,651 |    29.35 |    45.86 |    48.11 |      48.14 |    48.15 |
|       25000 |  126.5 ms |            197,659 |    63.22 |    85.83 |    90.96 |      91.34 |    91.35 |
|       50000 |  212.4 ms |            235,393 |   110.48 |   156.46 |   168.14 |     168.72 |   168.82 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   23.9 ms |             41,781 |    15.27 |    20.74 |    22.21 |      22.40 |    22.40 |
|        5000 |   60.1 ms |             83,200 |    28.27 |    47.39 |    48.43 |      48.47 |    48.48 |
|       10000 |  119.7 ms |             83,535 |    60.27 |    99.33 |   105.42 |     105.82 |   105.84 |
|       25000 |  299.1 ms |             83,581 |   152.33 |   262.91 |   273.81 |     274.10 |   274.50 |
|       50000 |  516.7 ms |             96,772 |   263.05 |   442.83 |   480.11 |     481.29 |   481.48 |
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.8 ms |             32,449 |    18.03 |    26.34 |    29.20 |      29.58 |    29.58 |
|        5000 |  104.9 ms |             47,672 |    50.98 |    93.80 |   101.42 |     102.16 |   102.23 |
|       10000 |  212.3 ms |             47,112 |   108.60 |   184.23 |   204.74 |     208.33 |   208.62 |

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
  • Raw Worker IPC Round-Trip      : 0.0359 ms/op
  • End-to-End Runtime Task Cost    : 0.0401 ms/op
  • Scheduler + Graph Overhead     : 0.0042 ms/op

[2] Concurrency Ladder Stress Test (Zero-delay fastPing throughput):
| Concurrency | Total Time |  Throughput (ops/s)  |  p50 (ms)  |  p95 (ms)  |  p99 (ms)  |  Max (ms)  |
|------------:|-----------:|---------------------:|-----------:|-----------:|-----------:|-----------:|
|          10 |     0.8 ms |               11,965 |       0.41 |       0.45 |       0.45 |       0.45 |
|         100 |     1.4 ms |               71,137 |       0.41 |       0.95 |       0.96 |       0.96 |
|         500 |     2.1 ms |              240,118 |       1.05 |       1.58 |       1.61 |       1.63 |
|        1000 |     4.2 ms |              238,133 |       2.15 |       3.13 |       3.14 |       3.15 |
|        5000 |    29.3 ms |              170,746 |      16.04 |      20.30 |      20.86 |      20.88 |
|       10000 |    53.9 ms |              185,535 |      26.74 |      42.45 |      42.72 |      42.74 |

[3] Event Loop Latency Under Heavy Compute Load...
  • Worker Fleet Event Loop Lag : 10.98 ms (Zero event-loop freezing ⚡)

[4] Memory Footprint Post 10,000-Request Burst:
  • RSS Heap Memory             : 80.75 MB
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
| 1 CPU + 1 IO  |       2 |   72.0 ms |            138,984 |    36.70 |    57.14 |    58.95 |    59.00 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 1
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 1 CPU + 2 IO  |       3 |   65.1 ms |            153,548 |    34.06 |    52.26 |    52.71 |    52.95 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 1 (smol: false)
  • Total OS Threads  : 3
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 1 IO  |       3 |   55.9 ms |            178,937 |    27.39 |    44.85 |    45.59 |    45.92 |
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
| 2 CPU + 2 IO  |       4 |   54.9 ms |            182,089 |    26.58 |    44.46 |    45.04 |    45.12 |

[2] High-Stress Deep Tail Test (25,000 Tasks):
[Yatta Runtime] Fleet active on 4 CPU cores:
  • CPU-Bound Workers : 2
  • I/O-Bound Workers : 2 (smol: false)
  • Total OS Threads  : 4
[ModuleGraph] Bun.ModuleGraph is unavailable: subsystem graphs share one module cache and per-tenant globals/env are NOT applied. Not isolated.
  • 25,000 Tasks Completed in  : 142.1 ms
  • Peak Throughput Rate       : 175,888 ops/sec
  • Latency Distribution       : p50: 70.13ms | p90: 108.33ms | p99: 109.47ms | p99.9: 111.99ms | Max: 112.03ms
  • Memory (RSS)               : Baseline: 102.8 MB | Peak: 129.4 MB | Cooldown: 101.9 MB

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
|        1000 |   10.2 ms |             97,869 |     4.36 |     6.39 |     7.87 |       8.25 |     8.25 |
|        5000 |   26.0 ms |            192,595 |    11.74 |    16.44 |    17.00 |      17.03 |    17.03 |
|       10000 |   61.9 ms |            161,651 |    29.35 |    45.86 |    48.11 |      48.14 |    48.15 |
|       25000 |  126.5 ms |            197,659 |    63.22 |    85.83 |    90.96 |      91.34 |    91.35 |
|       50000 |  212.4 ms |            235,393 |   110.48 |   156.46 |   168.14 |     168.72 |   168.82 |

📦 [WORKLOAD 2] Real-World 2KB JSON Payload Transformation:
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   23.9 ms |             41,781 |    15.27 |    20.74 |    22.21 |      22.40 |    22.40 |
|        5000 |   60.1 ms |             83,200 |    28.27 |    47.39 |    48.43 |      48.47 |    48.48 |
|       10000 |  119.7 ms |             83,535 |    60.27 |    99.33 |   105.42 |     105.82 |   105.84 |
|       25000 |  299.1 ms |             83,581 |   152.33 |   262.91 |   273.81 |     274.10 |   274.50 |
|       50000 |  516.7 ms |             96,772 |   263.05 |   442.83 |   480.11 |     481.29 |   481.48 |

⚡ [WORKLOAD 3] Micro-Compute Tasks (CPU Pool Scheduling):
| Concurrency | Duration  | Throughput (ops/s) | p50 (ms) | p90 (ms) | p99 (ms) | p99.9 (ms) | Max (ms) |
|------------:|----------:|-------------------:|---------:|---------:|---------:|-----------:|---------:|
|        1000 |   30.8 ms |             32,449 |    18.03 |    26.34 |    29.20 |      29.58 |    29.58 |
|        5000 |  104.9 ms |             47,672 |    50.98 |    93.80 |   101.42 |     102.16 |   102.23 |
|       10000 |  212.3 ms |             47,112 |   108.60 |   184.23 |   204.74 |     208.33 |   208.62 |

📈 Memory Footprint (Post 50,000-Task Burst):
  • Peak RSS Memory        : 203.3 MB
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
| Yatta     |      41,167 |     1.00x |     8% | 2.20ms | 4.70ms | 5.34ms |
| Raw Bun   |      44,703 |     1.09x |    21% | 2.13ms | 4.61ms | 4.81ms |
| Hono      |      45,644 |     1.11x |    11% | 1.94ms | 3.84ms | 4.35ms |
| Elysia    |      47,722 |     1.16x |    24% | 2.07ms | 3.71ms | 4.82ms |
| Express   |      14,257 |     0.35x |     5% | 6.18ms | 11.13ms | 12.26ms |
| Fastify   |      20,016 |     0.49x |     1% | 4.87ms | 8.45ms | 9.32ms |
| Koa       |      15,786 |     0.38x |    10% | 6.07ms | 9.81ms | 11.49ms |

  Yatta dispatch adds about 1.9µs per request over a
  handler that returns a static Response. That is the whole cost of routing.

  Wrote /tmp/bench/comparison.json

=======================================================

```
</details>

---
_Generated by [`benchmark.yml`](.github/workflows/benchmark.yml)._
