import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../drizzle/0000_absurd_piledriver.sql", import.meta.url),
      "utf8",
    ),
  );
  const prepare = (sql) => {
    let values = [];
    const obj = {
      bind(...v) {
        values = v;
        return obj;
      },
      async first() {
        return sqlite.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...values) };
      },
      async run() {
        return { meta: sqlite.prepare(sql).run(...values) };
      },
      exec() {
        const q = sqlite.prepare(sql);
        return q.columns().length
          ? { results: q.all(...values) }
          : { results: [], meta: q.run(...values) };
      },
    };
    return obj;
  };
  return {
    sqlite,
    prepare,
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const result = stmts.map((s) => s.exec());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
    close() {
      sqlite.close();
    },
  };
}
