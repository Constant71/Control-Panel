import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Last save/load problem across all stores, shown as a banner so lost settings are never silent. */
export const storageHealth: { error: string | null; at: string | null } = { error: null, at: null };

const report = (msg: string) => {
  console.error(msg);
  storageHealth.error = msg;
  storageHealth.at = new Date().toISOString();
};

let tmpCounter = 0;
const allStores = new Set<JsonStore<unknown>>();

/** Waits for every queued save (used on shutdown). */
export async function flushStores(): Promise<void> {
  await Promise.all([...allStores].map((s) => s.flush()));
}

/**
 * Tiny JSON file store with atomic writes.
 *
 * Saves are serialized per store: two saves at once used to write the same .tmp file together,
 * which interleaved their bytes and left a corrupt file; load then fell back to empty defaults and
 * the next save made the loss permanent (roles and stations "forgotten" after a restart). Now only
 * one write runs at a time, the newest value always wins, and the previous good file is kept as
 * <name>.bak so a damaged file can be recovered at load.
 */
export class JsonStore<T> {
  private chain: Promise<void> = Promise.resolve();
  private pending: string | null = null;

  constructor(
    private readonly dir: string | undefined,
    private readonly name: string,
    private readonly fallback: () => T,
  ) {
    allStores.add(this as JsonStore<unknown>);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private get file(): string {
    return path.join(this.dir!, this.name);
  }

  async load(): Promise<T> {
    if (!this.dir) return this.fallback();
    const read = async (file: string): Promise<T | null> => {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        return null; // no file yet
      }
      try {
        return { ...this.fallback(), ...JSON.parse(raw) };
      } catch {
        const keep = `${file}.corrupt-${Date.now()}`;
        await copyFile(file, keep).catch(() => {});
        report(`${path.basename(file)} was damaged and could not be read (kept as ${path.basename(keep)})`);
        return null;
      }
    };
    const main = await read(this.file);
    if (main) return main;
    const bak = await read(this.file + ".bak");
    if (bak) {
      console.error(`${this.name}: restored from ${this.name}.bak`);
      return bak;
    }
    return this.fallback();
  }

  /** Resolves once this value (or a newer one) is on disk. */
  save(value: T): Promise<void> {
    if (!this.dir) return Promise.resolve();
    // Serialize now: callers keep mutating their objects after calling save.
    this.pending = JSON.stringify(value);
    this.chain = this.chain.then(() => this.writeLatest());
    return this.chain;
  }

  /** Writes the newest pending value; later queued steps find nothing pending and return. */
  private async writeLatest(): Promise<void> {
    const text = this.pending;
    if (text === null) return;
    this.pending = null;
    try {
      await mkdir(this.dir!, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${++tmpCounter}.tmp`;
      await writeFile(tmp, text);
      await copyFile(this.file, this.file + ".bak").catch(() => {}); // keep the last good copy
      await rename(tmp, this.file);
      if (storageHealth.error?.includes(this.name)) storageHealth.error = null;
    } catch (err) {
      report(`Could not save ${this.name} in ${this.dir}: ${(err as Error).message}`);
    }
  }
}
