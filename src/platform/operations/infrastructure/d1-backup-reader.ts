import type { Row } from '../../../lib/backup';
import type { BackupSnapshotReader } from '../application/export-backup';

/** Adaptador D1 del puerto de lectura usado por la exportación administrativa. */
export function createD1BackupReader(db: D1Database): BackupSnapshotReader {
  return Object.freeze({
    async readTables(tables: readonly string[]): Promise<Record<string, Row[]>> {
      const results = await db.batch(tables.map((table) => db.prepare(`SELECT * FROM ${table}`)));
      return Object.fromEntries(tables.map((table, index) => [
        table,
        (results[index]?.results ?? []) as Row[],
      ]));
    },
  });
}
