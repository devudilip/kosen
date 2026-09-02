import Database from "better-sqlite3";
import type { FeatureVector } from "./features.js";
import type { ScoreResult } from "./score.js";

// Persists every score with its full feature vector, the exact prompt sent,
// and the model's raw + clamped output. This is what "replayable" means in
// practice: a judge (or the score-detail UI) can pull one row and see
// precisely what the model saw and said, with nothing reconstructed after
// the fact.
export interface StoredScore {
  id: number;
  address: string;
  timestamp: number; // unix seconds, when the score was produced
  model: string;
  featureVector: FeatureVector;
  prompt: string;
  rawOutput: ScoreResult["raw"];
  clampedOutput: ScoreResult["clamped"];
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class ScoreStore {
  private db: Database.Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        model TEXT NOT NULL,
        feature_vector TEXT NOT NULL,
        prompt TEXT NOT NULL,
        raw_output TEXT NOT NULL,
        clamped_output TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scores_address ON scores(address);
    `);
  }

  save(address: string, timestamp: number, features: FeatureVector, result: ScoreResult): number {
    const stmt = this.db.prepare(`
      INSERT INTO scores (address, timestamp, model, feature_vector, prompt, raw_output, clamped_output)
      VALUES (@address, @timestamp, @model, @featureVector, @prompt, @rawOutput, @clampedOutput)
    `);
    const info = stmt.run({
      address,
      timestamp,
      model: result.model,
      featureVector: serialize(features),
      prompt: result.prompt,
      rawOutput: serialize(result.raw),
      clampedOutput: serialize(result.clamped),
    });
    return Number(info.lastInsertRowid);
  }

  get(id: number): StoredScore | undefined {
    const row = this.db.prepare("SELECT * FROM scores WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return this.rowToStoredScore(row);
  }

  listForAddress(address: string): StoredScore[] {
    const rows = this.db
      .prepare("SELECT * FROM scores WHERE address = ? ORDER BY timestamp DESC")
      .all(address) as Record<string, unknown>[];
    return rows.map((row) => this.rowToStoredScore(row));
  }

  private rowToStoredScore(row: Record<string, unknown>): StoredScore {
    return {
      id: row.id as number,
      address: row.address as string,
      timestamp: row.timestamp as number,
      model: row.model as string,
      featureVector: JSON.parse(row.feature_vector as string),
      prompt: row.prompt as string,
      rawOutput: JSON.parse(row.raw_output as string),
      clampedOutput: JSON.parse(row.clamped_output as string),
    };
  }

  close(): void {
    this.db.close();
  }
}
