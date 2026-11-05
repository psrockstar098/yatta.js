# Full-text search

Ranked search over your tables, backed by SQLite FTS5. Mark the columns
you want searchable in the schema — nothing else to set up.

```ts
import { col, createDatabase } from "yatta.js/db";

const schema = {
  products: {
    id: col.id(),
    title: col.text().searchable(),
    description: col.text().searchable(),
    internalNote: col.text(), // not searchable: never matched
    price: col.integer(),
  },
};

const db = createDatabase({ path: "Database/app.db", schema });

const hits = db.products.search("laptop");
// hits[0].row — the matched row, most relevant first
// hits[0].rank — the raw FTS5 bm25() value (negative, smaller is better)
```

## How it works

Declaring `.searchable()` on a text column creates a standalone FTS5 table
(`_fts_products`) holding those columns plus the row's primary key, stored
unindexed so the key itself is never searchable. Ranking is FTS5's `bm25()`
— Yatta does not invent a score.

The index stays in sync through the normal write paths: `insert`,
`insertMany`, `update`, `updateById`, `delete`, and `upsert`. A transaction
rollback rolls index writes back with the rows, so the index cannot outlive
its row.

## Options

```ts
// Paging through ranked results
db.products.search("laptop", { limit: 10, offset: 20 });

// Search only one column — naming a non-searchable column throws
db.products.search("laptop", { columns: ["description"] });

// Combine ranking with an ordinary filter
db.products.search("laptop", { where: { price: { lt: 100 } } });
```

## Typos

FTS5 on its own has no typo tolerance: searching "laptp" against an index
holding "laptop" matches nothing. Yatta adds a correction layer on top, so
this works by default:

```ts
db.products.search("laptp"); // finds the laptop row
db.products.search("laptp", { typo: false }); // [] — FTS5's honest answer
```

What the layer actually does: each query word that is not already in the
indexed vocabulary is corrected against that vocabulary — terms from the
fts5vocab table, or from scanning the searchable columns when that table
is unavailable. A candidate must share enough trigrams with the query word
and be within a small edit distance (1 for short words, 2 for longer ones).
The best candidate wins; a word with no close neighbour keeps its spelling
and matches nothing.

Where it falls short, plainly:

- It corrects one word at a time, against single indexed terms. It cannot
  fix a typo split across words, or a word that is itself two words run
  together.
- A genuinely unknown word can be "corrected" to a near neighbour when one
  happens to sit within the distance gates. The gates keep this rare, but
  they cannot rule it out — a typo search is a best guess, not an exact
  lookup.
- Correction reads the vocabulary on every typo-enabled search. On very
  large tables that read is the main cost of a search; pass `typo: false`
  when you need exact matching only.

## Synonyms

A synonym map expands the query, at query time — changing it needs no
reindex. Set it for the whole database, or for one query:

```ts
const db = createDatabase({
  path: "Database/app.db",
  schema,
  searchSynonyms: { laptop: ["notebook"] },
});

db.products.search("laptop"); // also matches "notebook" rows

// One query only; the database map is untouched
db.products.search("laptop", { synonyms: { laptop: "notebook" } });
```

The map is one-directional: `laptop: ["notebook"]` expands "laptop" to
"notebook", not the other way round. Add the reverse entry if you want
both directions.

## Gotchas

- Only plain text columns can be `.searchable()`. Marking a number,
  boolean, JSON column, or UUID key throws at schema definition time.
- Search input is tokenized before it reaches FTS5, so quotes, wildcards,
  and FTS5 operators typed into a query never act as syntax. There is no
  OR search in v1: the words `and`/`or`/`not` are dropped and every
  remaining term is ANDed.
- `rank` is only meaningful for ordering within one query. Do not rescale
  it into a 0–1 score or compare ranks across different queries.
- Writes that bypass the Table methods — raw SQL, `exec`, a database file
  copied in from elsewhere — do not sync the index. Rebuild it:

```ts
db.products.rebuildSearchIndex(); // one table
db.rebuildSearchIndex(); // every searchable table
```

  A search also repairs a missing index, or one whose row count disagrees
  with the table, on first use. Changed text on an existing row written
  outside the Table paths is only fixed by a rebuild, not by that repair.
- Search returns full rows, including non-searchable columns — the same as
  `findMany`. Non-searchable means "never matched on", not "hidden".
- Search is opt-in and lazy: a table with no `.searchable()` column gets no
  FTS table and no extra work on any write — its write path runs exactly
  the statements it ran before. Only tables that declare searchable columns
  pay for index maintenance, and only from the moment they declare it.
