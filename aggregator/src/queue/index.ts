/**
 * In-memory submission queue for MVP single-instance aggregator.
 *
 * Spec: docs/specs/aggregator_design.md §5 (queue module).
 *
 * Behaviour:
 *   - Append-only job map; FIFO pending list
 *   - One worker drains via claim(); state transitions are explicit
 *   - Lost on process restart (acceptable for MVP — edge will retry on timeout)
 *
 * Production migration to Redis (BullMQ or similar) is contemplated but
 * out of scope. Interface here is the abstraction boundary; swap impl,
 * keep callers unchanged.
 */

import { EventEmitter } from "node:events";

export type JobStatus =
  | "pending"
  | "processing"
  | "complete"
  | "failed"
  | "quarantined";

export interface JobRecord<T> {
  id: string;
  data: T;
  status: JobStatus;
  attempts: number;
  enqueuedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * Events emitted:
 *   - "enqueued"   (id) — caller may start a worker pull
 *   - "completed"  (id, result)
 *   - "failed"     (id, error)
 *   - "quarantined" (id, error) — manual review required, no retry
 */
export class InMemoryQueue<T> extends EventEmitter {
  private readonly records = new Map<string, JobRecord<T>>();
  private readonly pending: string[] = [];

  /** Add a new job. Throws if id already exists (caller must dedupe). */
  enqueue(id: string, data: T): JobRecord<T> {
    if (this.records.has(id)) {
      throw new Error(`Job ${id} already exists`);
    }
    const record: JobRecord<T> = {
      id,
      data,
      status: "pending",
      attempts: 0,
      enqueuedAt: new Date(),
    };
    this.records.set(id, record);
    this.pending.push(id);
    this.emit("enqueued", id);
    return record;
  }

  /**
   * Take the next pending job and mark it processing.
   * Returns null if queue is empty. Atomic from the perspective of a single
   * Node.js event-loop tick — safe with one worker.
   */
  claim(): JobRecord<T> | null {
    const id = this.pending.shift();
    if (!id) return null;
    const record = this.records.get(id);
    if (!record) return null;
    record.status = "processing";
    record.attempts += 1;
    record.startedAt = new Date();
    return record;
  }

  complete(id: string, result?: unknown): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = "complete";
    record.result = result;
    record.finishedAt = new Date();
    this.emit("completed", id, result);
  }

  /** Retry-able failure (back to pending if retries < max). */
  fail(id: string, code: string, message: string, maxAttempts = 3): void {
    const record = this.records.get(id);
    if (!record) return;
    record.error = { code, message };
    if (record.attempts < maxAttempts) {
      record.status = "pending";
      this.pending.push(id);
    } else {
      record.status = "failed";
      record.finishedAt = new Date();
      this.emit("failed", id, record.error);
    }
  }

  /** Terminal failure — never retry (e.g. quarantined data). */
  quarantine(id: string, code: string, message: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = "quarantined";
    record.error = { code, message };
    record.finishedAt = new Date();
    this.emit("quarantined", id, record.error);
  }

  get(id: string): JobRecord<T> | undefined {
    return this.records.get(id);
  }

  size(): { total: number; pending: number; processing: number } {
    let processing = 0;
    for (const r of this.records.values()) {
      if (r.status === "processing") processing += 1;
    }
    return {
      total: this.records.size,
      pending: this.pending.length,
      processing,
    };
  }
}
