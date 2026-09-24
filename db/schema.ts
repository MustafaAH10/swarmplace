import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
  revision: integer("revision").notNull().default(0),
  used: integer("used").notNull().default(0),
  budget: integer("budget").notNull(),
  nextWrite: integer("next_write").notNull().default(0),
  expires: integer("expires").notNull(),
  active: integer("active").notNull().default(1),
  lastOp: text("last_op"),
});
export const sessions = sqliteTable("sessions", {
  hash: text("hash").primaryKey(),
  runId: text("run_id").notNull(),
  expires: integer("expires").notNull(),
});
export const pairs = sqliteTable("pairs", {
  hash: text("hash").primaryKey(),
  runId: text("run_id").notNull(),
  expires: integer("expires").notNull(),
  redeemed: integer("redeemed").notNull().default(0),
  receipt: text("receipt"),
});
export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    data: text("data").notNull(),
    at: integer("at").notNull(),
    op: text("op").unique(),
    x: integer("x"),
    y: integer("y"),
    w: integer("w"),
    h: integer("h"),
  },
  (t) => [index("events_at").on(t.at)],
);
export const quotas = sqliteTable("quotas", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expires: integer("expires").notNull(),
});
