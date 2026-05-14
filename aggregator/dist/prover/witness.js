import { Noir } from "@noir-lang/noir_js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { canonicalize, bytesToFieldElements, computePayloadHash, } from "../verify/canonical.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = resolve(__dirname, "../../circuits/v08.json");
const BN254_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
let cachedCircuit = null;
let cachedNoir = null;
function loadCircuit() {
    if (!cachedCircuit) {
        const raw = readFileSync(CIRCUIT_PATH, "utf-8");
        cachedCircuit = JSON.parse(raw);
    }
    return cachedCircuit;
}
export function getCompiledCircuit() {
    return loadCircuit();
}
function getNoir() {
    if (!cachedNoir) {
        cachedNoir = new Noir(loadCircuit());
    }
    return cachedNoir;
}
export function computeTotalEnergy(payload) {
    let total = 0n;
    for (const r of payload.readings) {
        total += r.voltage_mv * r.current_ma;
    }
    return total;
}
function toFieldHex(v) {
    let n = v;
    if (n < 0n) {
        n = ((n % BN254_FIELD_SIZE) + BN254_FIELD_SIZE) % BN254_FIELD_SIZE;
    }
    return "0x" + n.toString(16);
}
function bytesToBigIntBE(bytes) {
    let v = 0n;
    for (const b of bytes) {
        v = (v << 8n) | BigInt(b);
    }
    return v;
}
export async function prepareWitnessInputs(inputs) {
    const { payload, signature, pubkey } = inputs;
    if (signature.length !== 64) {
        throw new Error(`signature must be 64 bytes (r || s), got ${signature.length}`);
    }
    if (pubkey.length !== 64) {
        throw new Error(`pubkey must be 64 bytes uncompressed (X || Y), got ${pubkey.length}`);
    }
    if (payload.readings.length !== 100) {
        throw new Error(`payload must have exactly 100 readings, got ${payload.readings.length}`);
    }
    const payloadHashBytes = await computePayloadHash(payload);
    const payloadHash = bytesToBigIntBE(payloadHashBytes);
    const totalEnergy = computeTotalEnergy(payload);
    const canonicalBytes = canonicalize(payload);
    const canonicalFields = bytesToFieldElements(canonicalBytes);
    return {
        device_id: toFieldHex(payload.device_id),
        session_id: toFieldHex(payload.session_id),
        epoch_start_ts: toFieldHex(payload.epoch_start_ts),
        lat_e7: toFieldHex(payload.lat_e7),
        lon_e7: toFieldHex(payload.lon_e7),
        light_level: toFieldHex(payload.light_level),
        tamper_flag: toFieldHex(payload.tamper_flag),
        payload_hash: toFieldHex(payloadHash),
        total_energy_mwh: toFieldHex(totalEnergy),
        canonical_payload: canonicalFields.map(toFieldHex),
        signature: Array.from(signature),
        pubkey_x: Array.from(pubkey.slice(0, 32)),
        pubkey_y: Array.from(pubkey.slice(32, 64)),
    };
}
export async function generateWitness(inputs) {
    const witnessInputs = await prepareWitnessInputs(inputs);
    const noir = getNoir();
    const { witness, returnValue } = await noir.execute(witnessInputs);
    return { witness, returnValue };
}
