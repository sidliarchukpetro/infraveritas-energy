/**
 * Submission worker — drains the queue and runs the full pipeline:
 *   payload + signature → witness → Honk proof → local verify → V3 submitProof.
 *
 * Spec: docs/specs/aggregator_design.md §5 (queue/worker module).
 *
 * Concurrency: single-flight by design (one `drain()` at a time). The
 * `isProcessing` flag is the gate. Multiple incoming `enqueued` events
 * coalesce into one drain pass.
 *
 * Error routing — three categories:
 *   QUARANTINE: bad data on the wire (invalid sig, bad proof, replay,
 *     unauthorized device). Never retry; manual review required.
 *   RETRY:     transient chain conditions (paused, epoch in future,
 *     unknown RPC errors). Re-queue up to max attempts.
 *   ALERT:     misconfiguration/protocol bug (wrong operator key,
 *     reentrancy detected). Fail terminal; ops must intervene.
 *
 * Mock mode: if no chainClient supplied, worker still runs witness +
 * proof + local verify and reports `kind: "mock"`. Useful for dev before
 * Sepolia deployment is ready — flips to live mode when V3_ADDRESS
 * is set in env.
 */

import { computePayloadHash } from "../verify/canonical.js";
import { generateWitness } from "../prover/witness.js";
import { generateProof, verifyProofLocally } from "../prover/honk.js";
import {
  ChainSubmissionError,
  type V3ChainClient,
  type SubmissionResult,
} from "../chain/submit.js";
import type { InMemoryQueue, JobRecord } from "../queue/index.js";
import type { SubmissionJob } from "../api/server.js";

const QUARANTINE_CODES = new Set<string>([
  "DeviceNotActive",
  "InvalidP256Signature",
  "InvalidZKProof",
  "PayloadHashMismatch",
  "InvalidPubkeyLength",
  "InvalidSignatureLength",
  "SessionKeyAlreadyUsed",
]);

const RETRY_CODES = new Set<string>([
  "EpochInFuture",
  "EnforcedPause",
  "InvalidTimestamp",
  "TX_REVERTED",
  "UNKNOWN",
]);

export type WorkerResult =
  | { kind: "submitted"; tx: SubmissionResult }
  | { kind: "mock"; proofBytes: number; verified: true };

export interface WorkerLogger {
  info(msg: object): void;
  warn(msg: object): void;
  error(msg: object): void;
}

export class SubmissionWorker {
  private isProcessing = false;

  constructor(
    private readonly queue: InMemoryQueue<SubmissionJob>,
    private readonly chainClient: V3ChainClient | null,
    private readonly logger?: WorkerLogger,
  ) {
    queue.on("enqueued", () => {
      this.drain().catch((err) => {
        this.logger?.error({ event: "drain-error", err: String(err) });
      });
    });
  }

  async drain(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      while (true) {
        const job = this.queue.claim();
        if (!job) break;
        await this.processOne(job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processOne(job: JobRecord<SubmissionJob>): Promise<void> {
    const t0 = Date.now();
    this.logger?.info({
      event: "job-start",
      id: job.id,
      attempts: job.attempts,
    });
    try {
      const result = await this.process(job.data);
      this.queue.complete(job.id, result);
      this.logger?.info({
        event: "job-complete",
        id: job.id,
        kind: result.kind,
        ms: Date.now() - t0,
      });
    } catch (err) {
      this.handleError(job.id, err);
    }
  }

  private async process(data: SubmissionJob): Promise<WorkerResult> {
    const payloadHash = await computePayloadHash(data.payload);

    // Witness generation runs all 4 circuit checks (Poseidon, metadata,
    // P-256 verify, energy sum). Throws if any check fails.
    const { witness } = await generateWitness({
      payload: data.payload,
      signature: data.signature,
      pubkey: data.pubkey,
    });

    // Proof generation — heavy step (~3s wall time).
    const proof = await generateProof(witness);

    // Defensive local verify before paying gas.
    const ok = await verifyProofLocally(proof);
    if (!ok) {
      throw new ChainSubmissionError(
        "InvalidZKProof",
        "Local proof verification failed (proof rejected before chain submit)",
      );
    }

    if (this.chainClient) {
      const tx = await this.chainClient.submitProof({
        payload: data.payload,
        payloadHash,
        signature: data.signature,
        devicePubkey: data.pubkey,
        proof,
      });
      return { kind: "submitted", tx };
    }
    return { kind: "mock", proofBytes: proof.proof.length, verified: true };
  }

  private handleError(jobId: string, err: unknown): void {
    if (err instanceof ChainSubmissionError) {
      if (QUARANTINE_CODES.has(err.code)) {
        this.queue.quarantine(jobId, err.code, err.message);
        this.logger?.warn({
          event: "job-quarantined",
          id: jobId,
          code: err.code,
        });
      } else if (RETRY_CODES.has(err.code)) {
        this.queue.fail(jobId, err.code, err.message);
        this.logger?.warn({
          event: "job-retry",
          id: jobId,
          code: err.code,
        });
      } else {
        // ALERT codes: AccessControlUnauthorizedAccount, ReentrancyGuardReentrantCall
        this.queue.fail(jobId, err.code, err.message);
        this.logger?.error({
          event: "job-alert",
          id: jobId,
          code: err.code,
        });
      }
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    // Noir circuit constraint failures = bad data (wrong sig, tampered hash, etc.)
    if (/Cannot satisfy constraint|verify_signature|assertion failed/i.test(msg)) {
      this.queue.quarantine(jobId, "CircuitConstraintFailed", msg);
      this.logger?.warn({
        event: "job-quarantined",
        id: jobId,
        code: "CircuitConstraintFailed",
      });
      return;
    }
    this.queue.fail(jobId, "WorkerError", msg);
    this.logger?.error({ event: "job-error", id: jobId, msg });
  }
}
