import { Mastra } from "@mastra/core/mastra";

type MastraStorage = NonNullable<NonNullable<ConstructorParameters<typeof Mastra>[0]>["storage"]>;

/**
 * Process-wide Mastra instances for agents.
 *
 * An `Agent` built without a `mastra` creates a private one on its first call. Every Mastra starts
 * cache-cleanup intervals in its constructor (and scheduler workers on demand), and those timers keep
 * it and everything it references alive for the life of the process. DataFoundry builds several
 * helper agents per run (classifier, extractors, title, trace summary), so each run left about six
 * Mastra instances behind: +4 MB of heap per run in a 2026-11-09 heap-snapshot diff, and an out-of-
 * memory crash after ~49 hours of benchmark runs (2 GB heap). Sharing one instance bounds it.
 */
let helperMastra: Mastra | undefined;
const byStorage = new WeakMap<object, Mastra>();

/** The Mastra every tool-free helper agent registers with. */
export const sharedHelperMastra = (): Mastra => (helperMastra ??= new Mastra({ logger: false }));

/** One Mastra per durable storage, for agents that use task state (replaces a new Mastra per run). */
export const sharedMastraFor = (storage: MastraStorage): Mastra => {
  let mastra = byStorage.get(storage);
  if (!mastra) {
    mastra = new Mastra({ storage });
    byStorage.set(storage, mastra);
  }
  return mastra;
};
