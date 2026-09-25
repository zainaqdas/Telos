import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Memory Engine V1 (Parts 29–32): JSONL files under .project-agent/memory/,
 * no vector database, no embeddings. The store is append-only with in-memory
 * dedup on a natural key per record type. Retrieval is capped and scored —
 * never the whole archive (Part 32).
 *
 * Trust hierarchy (Part 32) is encoded as record priority:
 *   user_rule > verified fact > verified lesson > decision > observation > hypothesis
 */

export type MemoryKind = "fact" | "lesson" | "decision" | "failure" | "rejected_approach" | "user_rule";

export interface MemoryRecord {
  type: MemoryKind;
  /** Natural key for dedup within a type (e.g. command+category for lessons). */
  key: string;
  /** Primary human-readable content. */
  statement: string;
  /** Optional structure: cause/correction/verification for lessons. */
  cause?: string;
  correction?: string;
  verification?: string;
  reason?: string;
  /** For rejected approaches. */
  revisitIf?: string;
  /** provenance */
  source: string;
  /** trust level at write time (lessons are written verified-only). */
  verified: boolean;
  /** epoch ms */
  t: number;
  /** times a matching record was retrieved (reinforcement). */
  hits: number;
}

/** Priority: lower number = higher trust = surfaces first in retrieval. */
const TRUST: Record<MemoryKind, number> = {
  user_rule: 0,
  fact: 1,
  lesson: 2,
  decision: 3,
  failure: 4,
  rejected_approach: 5,
};

const FILES: Record<MemoryKind, string> = {
  fact: "facts.jsonl",
  lesson: "lessons.jsonl",
  decision: "decisions.jsonl",
  failure: "failures.jsonl",
  rejected_approach: "rejected.jsonl",
  user_rule: "user-rules.jsonl",
};

export class MemoryStore {
  private readonly dir: string;
  private readonly cache = new Map<MemoryKind, MemoryRecord[]>();

  constructor(projectRoot: string, dirName = "memory") {
    this.dir = join(projectRoot, ".project-agent", dirName);
    mkdirSync(this.dir, { recursive: true });
    for (const kind of Object.keys(FILES) as MemoryKind[]) {
      this.cache.set(kind, this.readKind(kind));
    }
  }

  private file(kind: MemoryKind): string {
    return join(this.dir, FILES[kind]);
  }

  private readKind(kind: MemoryKind): MemoryRecord[] {
    const path = this.file(kind);
    if (!existsSync(path)) return [];
    const out: MemoryRecord[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as MemoryRecord);
      } catch {
        /* torn tail line — skip */
      }
    }
    return out;
  }

  /** Append a record; dedup on (type, key). Returns false if already known. */
  add(rec: Omit<MemoryRecord, "t" | "hits">, now = Date.now()): boolean {
    const list = this.cache.get(rec.type) ?? [];
    const existing = list.find((r) => r.key === rec.key);
    if (existing) {
      // A repeat of the same failure/approach reinforces it.
      existing.hits += 1;
      this.rewriteKind(rec.type, list);
      return false;
    }
    const full: MemoryRecord = { ...rec, t: now, hits: 1 };
    list.push(full);
    this.cache.set(rec.type, list);
    appendFileSync(this.file(rec.type), JSON.stringify(full) + "\n", "utf8");
    return true;
  }

  /** Rewrite a kind's file (used for dedup hit-marking; rare, small files). */
  private rewriteKind(kind: MemoryKind, list: MemoryRecord[]): void {
    const tmp = this.file(kind) + ".tmp";
    appendFileSync(tmp, list.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    renameSync(tmp, this.file(kind));
  }

  /**
   * Query records relevant to a topic string. Scoring: kind trust, then
   * reinforcement, then recency. Always capped (Part 32: do not inject the
   * whole archive).
   */
  query(topics: string, kinds: MemoryKind[] = ["user_rule", "lesson", "rejected_approach", "fact", "decision"], limit = 6): MemoryRecord[] {
    const words = topics.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    const scored: Array<{ rec: MemoryRecord; score: number }> = [];
    for (const kind of kinds) {
      const trust = TRUST[kind];
      for (const rec of this.cache.get(kind) ?? []) {
        const hay = `${rec.key} ${rec.statement} ${rec.cause ?? ""} ${rec.correction ?? ""} ${rec.reason ?? ""} ${rec.revisitIf ?? ""} ${rec.verification ?? ""}`.toLowerCase();
        let overlap = words.filter((w) => hay.includes(w)).length;
        // Strong boost when the topic explicitly names the approach/lesson key.
        if (rec.key && topics.toLowerCase().includes(rec.key.toLowerCase())) overlap += 3;
        if (overlap === 0) continue;
        scored.push({ rec, score: trust * 10 - overlap * 2 - Math.min(rec.hits, 5) - rec.t / 1e12 });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map((s) => s.rec);
  }

  all(kind: MemoryKind): MemoryRecord[] {
    return [...(this.cache.get(kind) ?? [])];
  }

  counts(): Record<MemoryKind, number> {
    const out = {} as Record<MemoryKind, number>;
    for (const kind of Object.keys(FILES) as MemoryKind[]) out[kind] = (this.cache.get(kind) ?? []).length;
    return out;
  }
}
