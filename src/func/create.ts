import { db } from "./db";

console.log("Initializing Yatta Database schema...");
const tables = Object.keys((db as any).tables ?? {});
for (const table of tables) {
  console.log(`  ✓ Table [${table}] ready`);
}
console.log("Database initialized successfully at Database/app.db");
