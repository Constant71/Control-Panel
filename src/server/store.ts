import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Last save failure across all stores, shown as a banner so a read-only data folder is never silent. */
export const storageHealth: { error: string | null; at: string | null } = { error: null, at: null };

/** Tiny JSON file store with atomic writes. */
export class JsonStore<T> {
  constructor(
    private readonly dir: string | undefined,
    private readonly name: string,
    private readonly fallback: () => T,
  ) {}

  async load(): Promise<T> {
    if (!this.dir) return this.fallback();
    try {
      return { ...this.fallback(), ...JSON.parse(await readFile(path.join(this.dir, this.name), "utf8")) };
    } catch {
      return this.fallback();
    }
  }

  async save(value: T): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, this.name);
      await writeFile(file + ".tmp", JSON.stringify(value));
      await rename(file + ".tmp", file);
      if (storageHealth.error?.includes(this.name)) storageHealth.error = null;
    } catch (err) {
      console.error(`Could not save ${this.name}:`, err);
      storageHealth.error = `Could not save ${this.name} in ${this.dir}: ${(err as Error).message}`;
      storageHealth.at = new Date().toISOString();
    }
  }
}
