import { poseidonSponge } from "./poseidon.js";
export const READINGS_PER_PAYLOAD = 100;
export const READING_BYTES = 24;
export const METADATA_BYTES = 56;
export const EXPECTED_PAYLOAD_BYTES = METADATA_BYTES + READINGS_PER_PAYLOAD * READING_BYTES;
export const EXPECTED_FIELD_ELEMENTS = EXPECTED_PAYLOAD_BYTES / 8;
export function canonicalize(payload) {
    if (payload.readings.length !== READINGS_PER_PAYLOAD) {
        throw new Error(`Expected ${READINGS_PER_PAYLOAD} readings, got ${payload.readings.length}`);
    }
    const buf = new Uint8Array(EXPECTED_PAYLOAD_BYTES);
    const view = new DataView(buf.buffer);
    let offset = 0;
    view.setBigUint64(offset, payload.device_id, false);
    offset += 8;
    view.setBigUint64(offset, payload.session_id, false);
    offset += 8;
    view.setBigUint64(offset, payload.epoch_start_ts, false);
    offset += 8;
    view.setBigInt64(offset, payload.lat_e7, false);
    offset += 8;
    view.setBigInt64(offset, payload.lon_e7, false);
    offset += 8;
    view.setBigUint64(offset, payload.light_level, false);
    offset += 8;
    view.setBigUint64(offset, payload.tamper_flag, false);
    offset += 8;
    for (const r of payload.readings) {
        view.setBigUint64(offset, r.voltage_mv, false);
        offset += 8;
        view.setBigUint64(offset, r.current_ma, false);
        offset += 8;
        view.setBigUint64(offset, r.timestamp_ms, false);
        offset += 8;
    }
    if (offset !== EXPECTED_PAYLOAD_BYTES) {
        throw new Error(`Canonical encoding wrong size: ${offset} != ${EXPECTED_PAYLOAD_BYTES}`);
    }
    return buf;
}
export function bytesToFieldElements(bytes) {
    if (bytes.length % 8 !== 0) {
        throw new Error(`Bytes length must be multiple of 8, got ${bytes.length}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const elements = new Array(bytes.length / 8);
    for (let i = 0; i < bytes.length; i += 8) {
        elements[i / 8] = view.getBigUint64(i, false);
    }
    return elements;
}
export async function computePayloadHash(payload) {
    const canonicalBytes = canonicalize(payload);
    const fieldElements = bytesToFieldElements(canonicalBytes);
    if (fieldElements.length !== EXPECTED_FIELD_ELEMENTS) {
        throw new Error(`Expected ${EXPECTED_FIELD_ELEMENTS} field elements, got ${fieldElements.length}`);
    }
    const hash = await poseidonSponge(fieldElements);
    return bigintToBytesBE(hash, 32);
}
function bigintToBytesBE(value, byteLength) {
    if (value < 0n) {
        throw new Error("bigintToBytesBE: negative values not supported");
    }
    const out = new Uint8Array(byteLength);
    let v = value;
    for (let i = byteLength - 1; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    if (v !== 0n) {
        throw new Error(`bigintToBytesBE: value 0x${value.toString(16)} overflows ${byteLength} bytes`);
    }
    return out;
}
