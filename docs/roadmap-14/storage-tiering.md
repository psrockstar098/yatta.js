# Storage tiering — stale files move to S3, reads never notice

Your local disk fills up with files nobody opens any more, while an S3
disk sits configured and unused. Tiering moves the files nobody has
touched for a while to the S3 disk, and keeps serving them from there.
Callers use one storage handle and never need to know where a file lives.

```ts
import { createStorage } from "yatta.js/storage";
import { createTieredStorageFromManager } from "yatta.js/storage-tiering";

const storage = createStorage({
  default: "local",
  publicReads: true,
  disks: {
    local: { driver: "local", baseDir: "./storage/uploads", publicUrl: "/storage/files" },
    s3: {
      driver: "s3",
      bucket: process.env.S3_BUCKET!,
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  },
});

// Null when tiering cannot activate — see "Both disks, or nothing" below.
const tiered = createTieredStorageFromManager(storage, { staleAfter: "30d" });
```

## ctx.storage — one handle in every handler

Attach storage to the router once, and every handler gets it as
`ctx.storage`. The module import keeps working exactly as before;
this is an addition, not a replacement.

```ts
import { createAPI, API } from "yatta.js/api";

const api = createAPI({ storage: tiered ?? storage });

api.post("/upload", async (ctx) => {
  const form = await ctx.formData();
  const file = form.get("file") as File;
  await ctx.storage!.save("uploads/report.pdf", file);
  return API.json({ ok: true });
});

api.get("/files/:name", async (ctx) => {
  const text = await ctx.storage!.file(`uploads/${ctx.params.name}`).text();
  return API.text(text);
});
```

`ctx.storage.save(key, data)` is a plain upload under one name. The
full file handle works too: `ctx.storage.file(key).put(data)`,
`.text()`, `.serve(req)`, `.delete()`. A router built after its
storage can use `api.withStorage(storage)` instead of the constructor
option, and a mounted child router inherits its parent's storage when
it has none of its own. When no storage is configured, `ctx.storage`
is undefined — handlers must check, not assume.

## Writes land hot, reads fall through

Writes always go to the local disk. Reads try local first, then S3,
so a file serves while it is being moved and after it moved. A save
over a moved file writes the new version locally and drops the stale
S3 copy, so there is never a version split across disks.

```ts
await tiered.save("reports/annual.pdf", pdfBytes);
await tiered.file("reports/annual.pdf").text(); // local, then S3 after a move
await tiered.tierOf("reports/annual.pdf"); // "hot" | "cold" | "moving" | "missing"
```

## The mover — copy, verify, delete, in that order

The mover runs only when the app runs it. It lists the local disk,
moves every file untouched for at least `staleAfter`, and reports
per file. One file's failure is recorded and the run continues.

```ts
import { createCron } from "yatta.js/jobs"; // app's existing cron scheduler
import { scheduleTiering } from "yatta.js/storage-tiering";

const cron = createCron();

// Leader-only, like the app's other cron tasks: only one worker schedules.
scheduleTiering(cron, tiered, "1h");

// Or as a job handler, for apps that run tiering as a job:
import { createTieringJobHandler } from "yatta.js/storage-tiering";
const runTiering = createTieringJobHandler(tiered);
const result = await runTiering();
// { moved: [...], promoted: [...], skipped: [...], failed: [...] }
```

The move itself is copy, then verify, then delete — never
delete-first:

1. Copy the file from local to S3.
2. Verify the copy: same size and same content hash as the source.
3. Only then delete the local file.

A failed verification leaves the local file intact and removes the
unverified S3 copy, so a later read cannot pick it up. An interrupted
move (crash, failed copy) leaves the same state: local intact, and the
next run copies again from scratch. The mover is idempotent for
exactly this reason — a file present on both disks is just copied
over and then deleted locally.

A file being moved still serves: reads do not wait on the mover, they
try local first and fall through to S3. Per-file locks serialize
moves, saves, deletes, and promotes for one key, so a save during a
move cannot be deleted by the move that was already in flight.

## Access tracking — reads and writes count, heads do not

Every read and write through tiered storage records last access for
the file. A file with no access record uses its last-modified time,
so files written before tiering started still age out. A metadata
check (`head`) is not an access: checking that a file exists must not
keep it local forever.

## Promote-back — off by default, on purpose

A cold file stays cold no matter how often it is read, unless the app
opts in. When it opts in, a file that gets hot again is copied back
to local (verified, same as a move) once it crosses the threshold.

```ts
const tiered = createTieredStorageFromManager(storage, {
  staleAfter: "30d",
  promoteBack: true,
  promoteAfterReads: 3, // cold reads inside one window that trigger a promote
  promoteWindowMs: 24 * 60 * 60 * 1000, // window for counting those reads
});
```

Promotion happens on the read that crosses the threshold, so the file
is already local when that read returns. Keep the threshold above 1:
promoting on a single read would bounce a file back and forth on
every mover run.

## Both disks, or nothing

Tiering activates only when a local disk and an S3 disk are both
configured. A single-disk app gets nothing from it: no mover, no
tracking, and `createTieredStorageFromManager` returns null — the
caller keeps using the plain manager. Two local disks do not
activate it either, and a named hot disk that is not local (or a cold
disk that is not S3) is also null rather than a silent
misconfiguration. No S3 call is made to decide this: the check looks
at configured driver kinds only, and constructing an S3 disk makes no
network request (Bun's S3 file references are lazy).

## Gotchas

- **Copy-verify-delete is the whole safety story.** Never delete a
  source file on the strength of a copy call returning. Verify size
  plus content hash first. Etags cannot be compared across disks: an
  S3 etag and a local etag have different formats for the same bytes,
  so tiering never compares them.
- **Credentials come from the disk config, from the environment, set
  before Bun starts.** Bun reads S3 credentials from the environment
  at startup (falling back from `S3_*` names to `AWS_*` names);
  setting them later does not take effect. Tiering never reads, logs,
  or prints a credential, and its error messages name only the key.
- **Keys with `..` segments are rejected, not normalised.** The base
  storage layer normalises `tenant-a/../tenant-b/file` into
  `tenant-b/file`, which crosses a tenant prefix. Tiering rejects any
  key containing a `..` segment outright, so a tiered key can never
  address a sibling prefix. This is stricter than plain storage, on
  purpose, and only applies to tiered paths.
- **Access records live in memory by default.** A restart loses them,
  and files fall back to last-modified time for staleness. An app that
  needs records to survive a restart can pass its own tracker behind
  the `AccessTracker` interface.
- **The mover lists the local disk, up to 10,000 files per run.**
  Beyond that, split by prefix or run more often; the run result
  tells you what moved, what was skipped, and what failed.
- **Tiering is not a backup.** A moved file exists in exactly one
  place after the move completes. If the S3 copy must also survive a
  bucket loss, that is a replication concern, not tiering.
- **Going around the tiered handle bypasses its guarantees.** A file
  written or deleted through a raw disk handle is not access-tracked,
  is not covered by the per-key move lock, and can race a move in
  flight. App code should use the tiered handle (or `ctx.storage`)
  for files tiering owns; the mtime fallback is what still ages
  directly-written files out.
- **Verification reads both copies in full.** That is the price of
  the guarantee, and it is paid once per move, not per read. For very
  large files, prefer a longer `staleAfter` so the cost is rare.
