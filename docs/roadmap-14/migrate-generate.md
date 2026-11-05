# `migrate:generate` — migrations from model changes

`migrate:make` writes a blank template; the developer hand-writes `up` and
`down`. `migrate:generate` closes that gap: it reads the live SQLite schema,
compares it against the TypeScript models, and writes a real migration file
in the same format (`name`, `up`, `down`) into `./migrations/`.

```bash
# Compare the live database against the models in db.ts
yatta migrate:generate --schema db.ts

# Name the migration, preview without writing, allow destructive changes
yatta migrate:generate --schema db.ts --name add_bio --dry-run
yatta migrate:generate --schema db.ts --allow-destructive
```

## How it finds the models

The schema file must export a `schema` object of `col.*` builders — the same
object passed to `createDatabase`. Without `--schema`, the command tries
`db.ts`, `yatta/db.ts`, `src/db.ts`, `database.ts`, and `yatta/database.ts`
in that order.

```ts
// db.ts — models only, no server boot
import { col } from "yatta.js/db";

export const schema = {
  users: {
    id: col.id(),
    email: col.text().unique(),
    bio: col.text().nullable(),
  },
};
```

## What it generates

New tables become `CREATE TABLE`, new columns become `ALTER TABLE ...
ADD COLUMN`, new indexes become `CREATE INDEX` (unique columns get
`CREATE UNIQUE INDEX`). Down migrations reverse each step: new tables are
dropped, added columns are dropped, added indexes are dropped.

```ts
// 20261105030000_add_bio.ts (generated)
export default {
  name: "20261105030000_add_bio",

  up(db: any) {
    db.run(`ALTER TABLE "users" ADD COLUMN "bio" TEXT;`);
  },

  down(db: any) {
    db.run(`ALTER TABLE "users" DROP COLUMN "bio";`);
  },
};
```

Changed column definitions cannot be altered in place in SQLite, so they go
through a table rebuild: a new table is built from the models, the shared
columns are copied over, and the old table is swapped out. Rebuild
migrations are `async` on purpose — the runner wraps a synchronous `up` in
a transaction, and SQLite ignores `PRAGMA foreign_keys = OFF` inside one.
An async `up` runs outside that transaction, so it can switch foreign keys
off, run its own transaction, and switch them back on. A failure rolls
back and leaves no applied marker, so re-running is safe.

## Destructive changes

Column drops, table drops, and type or primary-key changes are destructive
and are never written silently. The command lists them, refuses with exit
code 1, and only writes the file with `--allow-destructive` (or an
interactive `yes` on a terminal). A drop beside a same-type new column is
flagged as a possible rename — the generator never renames automatically,
because a guessed rename destroys a column.

Dropped data cannot be restored by `down`: a down migration recreates the
dropped table or column empty. The generated file header says so.

## Gotchas

- **No diff, no file.** When the live database already matches the models,
  the command says so and exits cleanly without writing anything. The same
  applies when no live database exists yet — start the server or run
  `yatta migrate` once to create it, then generate.
- **A schema file that boots the server hides the diff.** If the imported
  file calls `createDatabase`, boot sync applies the additive changes
  before the diff runs. Point `--schema` at a models-only module when you
  want a diff against the live database.
- **A new NOT NULL column without a default cannot be generated** for a
  table that already has rows — there is no value the generator could
  honestly invent. Give the column `.default(...)` or `.nullable()` first.
- **Indexes in the database but not in the models are left alone.** Dropping
  a hand-made index the models never mentioned would be a silent
  performance regression, not a schema fix.
- **NOT NULL tightening fails on apply if rows hold NULL.** The rebuild
  copies rows verbatim, so clean those rows first; the generated file calls
  this out in its header.
- **Down for a dropped NOT NULL column without a default** cannot use
  `ADD COLUMN` (SQLite refuses it). The generated `down` carries a note
  instead of a statement — rebuild the table from its previous definition
  to roll that one back.
