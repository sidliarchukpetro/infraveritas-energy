/**
 * Submission worker — drains the queue and runs the full pipeline:
 *   payload + signature → [P-256 pre-check] → witness → Honk proof
 *                       → local verify → V3 submitProof → [Phase 4 validation].
 *
 * Spec: docs/specs/aggregator_design.md §5 (queue/worker module).
 *
 * Pre-check rationale: P-256 verify is ~1ms; witness+proof is ~3s. By
 * verifying the signature locally first, we save ~3000× CPU per bad
 * submission. The Noir circuit's verify_signature performs the SAME
 * check internally, so a payload that passes pre-check will pass the
 * circuit's check; conversely, a payload that fails pre-check would
 * also fail the circuit constraint — we just fail faster.
 *
 * Concurrency: single-flight by design. One `drain()` at a time.
 * Multiple incoming `enqueued` events coalesce into one drain pass.
 *
 * Error routing — three categories:
 *   QUARANTINE: bad data on the wire (invalid sig, bad proof, replay,
 *     unauthorized device). Never retry; manual review required.
 *   RETRY:     transient chain conditions (paused, epoch in future,
 *     unknown RPC errors). Re-queue up to max attempts.
 *   ALERT:     misconfiguration/protocol bug (wrong operator key,
 *     reentrancy detected). Fail terminal; ops must intervene.
 *
 * Mock mode: if no chainClient supplied, worker still runs pre-check
 * + witness + proof + local verify, but does not submit on-chain.
 *
 * Phase 4 validation (optional): if validationPipeline supplied,
 * cross-validation + statistics + anomaly + persistence run AFTER
 * chain submit як **best-effort**. Validation failure does NOT block
 * submission — chain remains source of truth, hypertable є observability
 * layer. If validationPipeline === undefined, behavior identical to pre-Phase-4.
 */

import { p256 } from "@noble/curves/nist.js";
import { hexToBytes } from "viem";
import { computePayloadHash } from "../verify/canonical.js";
import { computeTotalEnergy, generateWitness } from "../prover/witness.js";
import { generateProof, verifyProofLocally } from "../prover/honk.js";
import {
  ChainSubmissionError,
  type V3ChainClient,
  type SubmissionResult,
} from "../chain/submit.js";
import type { InMemoryQueue, JobRecord } from "../queue/index.js";
import type { SubmissionJob } from "../api/server.js";
import type {
  ValidationPipeline,
  ValidationOutcome,
} from "../validation/pipeline.js";

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
  | { kind: "submitted"; tx: SubmissionResult; validation?: ValidationOutcome }
  | {
      kind: "mock";
      proofBytes: number;
      verified: true;
      validation?: ValidationOutcome;
    };

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
    private readonly validationPipeline?: ValidationPipeline,
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
        validation: result.validation
          ? {
              ensembleStatus: result.validation.ensemble.status,
              flags: result.validation.anomaly.flags,
              reviewRequired: result.validation.anomaly.reviewRequired,
            }
          : "disabled",
        ms: Date.now() - t0,
      });
    } catch (err) {
      this.handleError(job.id, err);
    }
  }

  private async process(data: SubmissionJob): Promise<WorkerResult> {
    const payloadHash = await computePayloadHash(data.payload);

    // Pre-check: P-256 verify locally (~1ms) before expensive witness/proof (~3s).
    // This runs the same check the Noir circuit will perform — failing fast
    // saves 3000× CPU per bogus submission. Uses prehash:false to match the
    // edge signer (Prehashed(SHA256()) in signing.py) and the Noir verifier.
    const pubkeyWithPrefix = new Uint8Array(65);
    pubkeyWithPrefix[0] = 0x04;
    pubkeyWithPrefix.set(data.pubkey, 1);
    const sigValid = p256.verify(
      data.signature,
      payloadHash,
      pubkeyWithPrefix,
      { prehash: false },
    );
    if (!sigValid) {
      throw new ChainSubmissionError(
        "InvalidP256Signature",
        "Pre-check failed: P-256 signature does not verify against payload hash",
      );
    }

    // Witness generation runs all 4 circuit checks (Poseidon, metadata,
    // P-256 verify, energy sum). With pre-check passing, signature check
    // here is redundant but defensive — circuit is the authoritative validator.
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

    // Chain submit (or mock if no chain client). Errors here propagate to
    // processOne→handleError so submission counts as failed.
    const baseResult: WorkerResult = this.chainClient
      ? {
          kind: "submitted",
          tx: await this.chainClient.submitProof({
            payload: data.payload,
            payloadHash,
            signature: data.signature,
            devicePubkey: data.pubkey,
            proof,
          }),
        }
      : {
          kind: "mock",
          proofBytes: proof.proof.length,
          verified: true,
        };

    // Phase 4: best-effort validation. Failure does NOT block chain submission
    // — chain is source of truth, hypertable is observability layer. Persist
    // the outcome so admin can correlate post-hoc.
    let validation: ValidationOutcome | undefined;
    if (this.validationPipeline) {
      try {
        const totalEnergyMwh = computeTotalEnergy(data.payload);
        const txHash =
          baseResult.kind === "submitted"
            ? hexToBytes(baseResult.tx.txHash)
            : undefined;
        validation = await this.validationPipeline.process(
          data.payload,
          totalEnergyMwh,
          { txHash },
        );
      } catch (err) {
        this.logger?.warn({
          event: "validation-failed",
          err: err instanceof Error ? err.message : String(err),
        });
        // validation залишається undefined; submission успішна.
      }
    }

    // Merge validation into result. Discriminated union — narrow then build.
    if (baseResult.kind === "submitted") {
      return { kind: "submitted", tx: baseResult.tx, validation };
    }
    return {
      kind: "mock",
      proofBytes: baseResult.proofBytes,
      verified: true,
      validation,
    };
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
        this.logger?.warn({ event: "job-retry", id: jobId, code: err.code });
      } else {
        // ALERT codes: AccessControlUnauthorizedAccount, ReentrancyGuardReentrantCall
        this.queue.fail(jobId, err.code, err.message);
        this.logger?.error({ event: "job-alert", id: jobId, code: err.code });
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
