import { ethers } from 'ethers';

const DEVICE_REGISTRY: Record<number, string> = {
  42: process.env.DEVICE_42_ADDRESS || ''
};

export type Reading = {
  voltage_mv: number;
  current_ma: number;
  timestamp_ms: number;
};

export interface SignablePayload {
  deviceId: number;
  sessionId: number;
  epochStartTs: number;
  lat: number;
  lon: number;
  lightLevel: number;
  tamperFlag: number;
  readings: Reading[];
  signature: string;
}

export function packReadings(readings: Reading[]): Uint8Array {
  const buf = new Uint8Array(readings.length * 24);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < readings.length; i++) {
    const offset = i * 24;
    view.setBigUint64(offset,      BigInt(readings[i].voltage_mv),   false);
    view.setBigUint64(offset + 8,  BigInt(readings[i].current_ma),   false);
    view.setBigUint64(offset + 16, BigInt(readings[i].timestamp_ms), false);
  }
  return buf;
}

export function readingsHash(readings: Reading[]): string {
  return ethers.keccak256(packReadings(readings));
}

export function buildSignMessage(p: SignablePayload, readingsHashHex: string): string {
  return `infraveritas:${p.deviceId}:${p.sessionId}:${p.epochStartTs}:${p.lat}:${p.lon}:${p.lightLevel}:${p.tamperFlag}:${readingsHashHex}`;
}

export function verifyDeviceSignature(p: SignablePayload): { valid: boolean; error?: string } {
  const expectedAddress = DEVICE_REGISTRY[p.deviceId];
  if (!expectedAddress) {
    return { valid: false, error: `Unknown device: ${p.deviceId}` };
  }

  if (!Array.isArray(p.readings) || p.readings.length === 0) {
    return { valid: false, error: 'Readings missing or empty' };
  }

  if (p.tamperFlag !== 0) {
    return { valid: false, error: 'Tamper flag is set; device requires re-certification' };
  }

  try {
    const hashHex = readingsHash(p.readings);
    const message = buildSignMessage(p, hashHex);
    const recovered = ethers.verifyMessage(message, p.signature);
    if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
      return { valid: false, error: 'Signature address mismatch' };
    }
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: `Invalid signature format: ${e.message}` };
  }
}
