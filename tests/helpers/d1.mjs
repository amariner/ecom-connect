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

/**
 * D1 con puntos de intercalado: antes (o después) de la primera operación cuyo
 * SQL cumple `when`, ejecuta `run` una sola vez. Reproduce carreras y cortes.
 */
export function hookedD1(sqlite) {
  const base = d1Adapter(sqlite);
  const hooks = [];
  async function fire(sqls, phase) {
    for (const hook of hooks) {
      if (hook.done || hook.phase !== phase || !sqls.some((sql) => hook.when.test(sql))) continue;
      hook.done = true;
      await hook.run();
    }
  }
  function wrap(statement) {
    const call = (method) => async (...values) => {
      await fire([statement.sql],'before');
      const result = await statement[method](...values);
      await fire([statement.sql],'after');
      return result;
    };
    return { sql: statement.sql, inner: statement, bind: (...values) => wrap(statement.bind(...values)),
      run: call('run'), all: call('all'), first: call('first') };
  }
  return {
    raw: base,
    db: {
      prepare: (sql) => wrap(base.prepare(sql)),
      async batch(statements) {
        const sqls = statements.map((statement) => statement.sql);
        await fire(sqls,'before');
        const result = await base.batch(statements.map((statement) => statement.inner));
        await fire(sqls,'after');
        return result;
      },
    },
    on(when, run, phase = 'before') { hooks.push({ when, run, phase, done: false }); },
  };
}
