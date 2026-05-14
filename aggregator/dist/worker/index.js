import { p256 } from "@noble/curves/nist.js";
import { computePayloadHash } from "../verify/canonical.js";
import { generateWitness } from "../prover/witness.js";
import { generateProof, verifyProofLocally } from "../prover/honk.js";
import { ChainSubmissionError, } from "../chain/submit.js";
const QUARANTINE_CODES = new Set([
    "DeviceNotActive",
    "InvalidP256Signature",
    "InvalidZKProof",
    "PayloadHashMismatch",
    "InvalidPubkeyLength",
    "InvalidSignatureLength",
    "SessionKeyAlreadyUsed",
]);
const RETRY_CODES = new Set([
    "EpochInFuture",
    "EnforcedPause",
    "InvalidTimestamp",
    "TX_REVERTED",
    "UNKNOWN",
]);
export class SubmissionWorker {
    queue;
    chainClient;
    logger;
    isProcessing = false;
    constructor(queue, chainClient, logger) {
        this.queue = queue;
        this.chainClient = chainClient;
        this.logger = logger;
        queue.on("enqueued", () => {
            this.drain().catch((err) => {
                this.logger?.error({ event: "drain-error", err: String(err) });
            });
        });
    }
    async drain() {
        if (this.isProcessing)
            return;
        this.isProcessing = true;
        try {
            while (true) {
                const job = this.queue.claim();
                if (!job)
                    break;
                await this.processOne(job);
            }
        }
        finally {
            this.isProcessing = false;
        }
    }
    async processOne(job) {
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
        }
        catch (err) {
            this.handleError(job.id, err);
        }
    }
    async process(data) {
        const payloadHash = await computePayloadHash(data.payload);
        const pubkeyWithPrefix = new Uint8Array(65);
        pubkeyWithPrefix[0] = 0x04;
        pubkeyWithPrefix.set(data.pubkey, 1);
        const sigValid = p256.verify(data.signature, payloadHash, pubkeyWithPrefix, { prehash: false });
        if (!sigValid) {
            throw new ChainSubmissionError("InvalidP256Signature", "Pre-check failed: P-256 signature does not verify against payload hash");
        }
        const { witness } = await generateWitness({
            payload: data.payload,
            signature: data.signature,
            pubkey: data.pubkey,
        });
        const proof = await generateProof(witness);
        const ok = await verifyProofLocally(proof);
        if (!ok) {
            throw new ChainSubmissionError("InvalidZKProof", "Local proof verification failed (proof rejected before chain submit)");
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
    handleError(jobId, err) {
        if (err instanceof ChainSubmissionError) {
            if (QUARANTINE_CODES.has(err.code)) {
                this.queue.quarantine(jobId, err.code, err.message);
                this.logger?.warn({
                    event: "job-quarantined",
                    id: jobId,
                    code: err.code,
                });
            }
            else if (RETRY_CODES.has(err.code)) {
                this.queue.fail(jobId, err.code, err.message);
                this.logger?.warn({ event: "job-retry", id: jobId, code: err.code });
            }
            else {
                this.queue.fail(jobId, err.code, err.message);
                this.logger?.error({ event: "job-alert", id: jobId, code: err.code });
            }
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
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
