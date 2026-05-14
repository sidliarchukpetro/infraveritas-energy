import { createWalletClient, createPublicClient, http, } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { V3_ABI } from "./abi.js";
import { computeTotalEnergy } from "../prover/witness.js";
const KNOWN_ERROR_NAMES = new Set([
    "DeviceNotActive",
    "InvalidP256Signature",
    "PayloadHashMismatch",
    "InvalidZKProof",
    "SessionKeyAlreadyUsed",
    "EpochInFuture",
    "InvalidTimestamp",
    "InvalidPubkeyLength",
    "InvalidSignatureLength",
    "AccessControlUnauthorizedAccount",
    "EnforcedPause",
    "ReentrancyGuardReentrantCall",
]);
export class ChainSubmissionError extends Error {
    code;
    txHash;
    constructor(code, message, txHash) {
        super(message);
        this.code = code;
        this.txHash = txHash;
        this.name = "ChainSubmissionError";
    }
}
export class V3ChainClient {
    publicClient;
    walletClient;
    account;
    v3Address;
    constructor(config) {
        this.account = privateKeyToAccount(config.operatorPrivateKey);
        this.v3Address = config.v3Address;
        this.publicClient = createPublicClient({
            chain: sepolia,
            transport: http(config.rpcUrl),
        });
        this.walletClient = createWalletClient({
            chain: sepolia,
            transport: http(config.rpcUrl),
            account: this.account,
        });
    }
    get operatorAddress() {
        return this.account.address;
    }
    async submitProof(inputs) {
        const payloadHashHex = bytesToHex(inputs.payloadHash);
        const signatureHex = bytesToHex(inputs.signature);
        const devicePubkeyHex = bytesToHex(inputs.devicePubkey);
        const proofHex = bytesToHex(inputs.proof.proof);
        const pubInputs = {
            deviceId: inputs.payload.device_id,
            sessionId: inputs.payload.session_id,
            epochStartTs: inputs.payload.epoch_start_ts,
            lat_e7: inputs.payload.lat_e7,
            lon_e7: inputs.payload.lon_e7,
            lightLevel: inputs.payload.light_level,
            tamperFlag: inputs.payload.tamper_flag,
            payloadHash: payloadHashHex,
            totalEnergyMWh: computeTotalEnergy(inputs.payload),
        };
        const args = [
            pubInputs,
            payloadHashHex,
            signatureHex,
            devicePubkeyHex,
            proofHex,
        ];
        try {
            await this.publicClient.simulateContract({
                address: this.v3Address,
                abi: V3_ABI,
                functionName: "submitProof",
                args,
                account: this.account,
            });
        }
        catch (err) {
            throw mapChainError(err);
        }
        let txHash;
        try {
            txHash = await this.walletClient.writeContract({
                address: this.v3Address,
                abi: V3_ABI,
                functionName: "submitProof",
                args,
                chain: sepolia,
                account: this.account,
            });
        }
        catch (err) {
            throw mapChainError(err);
        }
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash,
        });
        if (receipt.status !== "success") {
            throw new ChainSubmissionError("TX_REVERTED", `Transaction ${txHash} reverted after inclusion (chain reorg or condition changed between simulate and write)`, txHash);
        }
        return {
            txHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
        };
    }
}
function bytesToHex(bytes) {
    let h = "0x";
    for (const b of bytes)
        h += b.toString(16).padStart(2, "0");
    return h;
}
function mapChainError(err) {
    const anyErr = err;
    const errorName = anyErr?.cause?.data?.errorName ??
        anyErr?.data?.errorName ??
        anyErr?.errorName;
    if (errorName && KNOWN_ERROR_NAMES.has(errorName)) {
        return new ChainSubmissionError(errorName, `V3 revert: ${errorName}`);
    }
    const msg = anyErr?.shortMessage ?? anyErr?.message ?? String(err);
    return new ChainSubmissionError("UNKNOWN", msg);
}
