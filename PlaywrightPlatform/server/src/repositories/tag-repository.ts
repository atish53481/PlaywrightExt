import type { Db } from '../db';

export class TagRepository {
  constructor(private readonly db: Db) {}

  /**
   * Makes `names` the script's tags. Unknown names become new tag rows; a name that
   * already exists in another capitalisation keeps the stored spelling.
   */
  async setForScript(scriptId: number, names: string[]): Promise<void> {
    await this.db('script_tags').where({ script_id: scriptId }).del();
    if (names.length === 0) return;

    // Sorted, so that two transactions creating the same tags take the index locks in the
    // same order and cannot deadlock.
    const sorted = [...names].sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    await this.db.raw(
      `insert into tags (name) values ${sorted.map(() => '(?)').join(', ')} on conflict (lower(name)) do nothing`,
      sorted,
    );
    await this.db.raw(
      `insert into script_tags (script_id, tag_id)
       select ?, t.id from tags t where lower(t.name) in (select lower(n) from unnest(?::text[]) as n)`,
      [scriptId, sorted],
    );
  }
}
