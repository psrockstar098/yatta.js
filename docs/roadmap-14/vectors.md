# Vector search

Store embeddings and search by similarity, ranked by cosine similarity.
No new service, no new dependency, no cost until you use it: the vectors
module loads on first `db.vectors` access, and nothing is created or
loaded before the first vector call.

```ts
import { createDatabase } from "yatta.js/db";

const db = createDatabase({ path: "Database/app.db", schema });

db.vectors.upsert("docs", {
  id: "getting-started",
  embedding: [0.12, -0.44, /* ... */],
  metadata: { title: "Getting started" },
});

const hits = db.vectors.search("docs", [0.1, -0.4 /* ... */]);
// hits[0].id — the most similar vector's id
// hits[0].score — cosine similarity, 1 is identical, -1 is opposite
// hits[0].metadata — whatever you stored with it
```

## How it works

A collection is a named set of vectors that all share one width. The
first write to an unknown collection creates it at that width; a later
vector of a different width throws instead of silently corrupting the
ranking. Each collection is recorded in `_yatta_vector_collections`, so
collections survive reopening the file.

```ts
// Create explicitly, or let the first upsert create it
db.vectors.ensureCollection("docs", 384);

// Paging, threshold, and stored vectors on request
db.vectors.search("docs", query, { limit: 10 });
db.vectors.search("docs", query, { threshold: 0.7 });
db.vectors.search("docs", query, { includeEmbedding: true });

// Reads and deletes
db.vectors.get("docs", "getting-started");
db.vectors.count("docs");
db.vectors.remove("docs", "getting-started");
db.vectors.listCollections();
db.vectors.dropCollection("docs");
```

Vector writes inside `db.transaction()` commit or roll back with the
surrounding work, like any other Yatta write.

## Two backends, one API

Which engine stores a collection is decided lazily, on the first call
that needs it, and recorded per collection:

- `sqlite-vec`: when a `vec0` extension binary is installed where
  SQLite can find it, vectors live in a vec0 virtual table and search
  uses its nearest-neighbour index. This is the fast path at scale.
- `sqlite`: plain SQLite tables, and search is a brute-force cosine
  query built on `json_each` — every search scans the whole collection.
  Correct, no native binary needed, slower at scale. This is what runs
  when no `vec0` binary is loadable.

`YATTA_VECTORS_BACKEND` picks the mode: `auto` (default — try vec0,
fall back to plain SQLite), `sqlite-vec` (refuse to run without vec0
rather than silently running slower), or `sqlite` (never attempt the
extension). The value is a mode name, never a path: Yatta loads the
extension only under the fixed name `vec0`, so no caller or environment
value can steer it at an arbitrary file. Yatta ships no `vec0` binary
and never downloads one — installing it is the operator's step, and
`db.vectors.backend` reports what actually resolved (`"undecided"`
before anything needed a decision).

Scores agree across backends for the same data, up to float32 rounding
in the vec0 table: the vec0 path stores a normalized copy for distance
ranking and converts distance back to cosine. A collection created
under one backend keeps that backend — a vec-backed collection opened
where vec0 is missing throws plainly instead of returning wrong
results, while a plain-SQLite collection stays readable and writable
anywhere.

## Text embeddings

`search()` takes vectors you already have. For text, bring an embedder
— any object with an `embed(texts)` function returning one vector per
text — or use the optional local-model loader:

```ts
// Your own embedder, per call or as the store default
await db.vectors.upsertText("docs", { id: "gs", text: "Getting started" }, { embedder });
await db.vectors.searchText("docs", "how do I start", { embedder });
db.vectors.setEmbedder(embedder);
await db.vectors.searchText("docs", "how do I start");

// Or a locally run model, via the optional runtime (see below)
import { createLocalEmbedder } from "yatta.js/vectors/embed";
db.vectors.setEmbedder(await createLocalEmbedder());
```

With no embedder and no model configured, text calls refuse plainly
instead of inventing vectors. The local loader reads two environment
variables and nothing else:

- `YATTA_EMBEDDING_MODEL` — a plain model id such as
  `"vendor/small-embedding-model"`. Path-like values (`..`, leading
  slash, backslash) are refused. The model is downloaded once and
  cached by the runtime; nothing downloads at startup or on any plain
  vector call.
- `YATTA_EMBEDDING_CACHE_DIR` — where the runtime caches the model.
  Optional; the runtime default applies when unset.

The runtime package (`@xenova/transformers`) is optional and is not a
Yatta dependency: without it, `createLocalEmbedder()` fails with
install instructions instead of a bare import error. No model is
bundled with Yatta, so pick a small one for your width — the width is
whatever the model returns, and the collection is created at that width
on first write.

## Gotchas

- Zero vectors have no cosine similarity and are refused at write and
  at query time. A query of all zeros is an error, not an empty result.
- Search ranks by cosine similarity, not by insertion order. Equal
  scores tie-break by id, so ranking is deterministic.
- The plain-SQLite backend scans the whole collection per search. It
  is fine for thousands of vectors and the honest choice without vec0;
  for much larger collections, install vec0 and let `auto` pick it.
- `threshold` on the vec0 backend fetches the whole collection before
  filtering, because vec0 returns only its k nearest — a thresholded
  search over `k = limit` could drop qualifying rows past the cutoff.
  Without a threshold, `k = limit` is exactly what runs.
- The `vec0` binary is native code the operator installs and trusts,
  like any SQLite extension. Yatta verifies the loaded library answers
  `vec_version()` before trusting it as sqlite-vec.
- Image embeddings are deferred, deliberately: a vision model is a
  bigger download and a different pipeline, and this round ships text
  vectors done properly rather than both half done. `search()` already
  accepts any precomputed vector, so image vectors from your own
  pipeline work today — only the built-in image embedder is missing.
- The table name `vectors` is reserved on the database object (like
  other YattaDB methods), so a schema table cannot also be called
  `vectors`. Use `db.table("vectors")` explicitly if you truly need
  that name for a table.
