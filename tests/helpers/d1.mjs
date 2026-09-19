import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** Ejecuta el SQL real en SQLite; batch tiene la misma atomicidad que D1. */
export function d1Adapter(sqlite) {
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql,values); }
    runSync() {
      const statement = sqlite.prepare(this.sql);
      if (statement.columns().length > 0) return {success:true,meta:{},results:statement.all(...this.values)};
      const result = statement.run(...this.values);
      return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)},results:[]};
    }
    async run() { return this.runSync(); }
    async all() { return {success:true,results:sqlite.prepare(this.sql).all(...this.values),meta:{}}; }
    async first(column) {
      const row = sqlite.prepare(this.sql).get(...this.values);
      return row ? column ? row[column] : row : null;
    }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.runSync()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

export const migrationFiles = () => readdirSync(new URL('../../migrations/',import.meta.url))
  .filter((name) => name.endsWith('.sql')).sort();
export const readMigration = (file) => readFileSync(new URL(`../../migrations/${file}`,import.meta.url),'utf8');

/** Base en memoria con todas las migraciones reales aplicadas en orden. */
export function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of migrationFiles()) sqlite.exec(readMigration(file));
  return sqlite;
}
