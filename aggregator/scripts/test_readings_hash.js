/**
 * Sanity check: same byte-packing and keccak256 in Node/ethers as in Python.
 * If hash matches Python — endianness/encoding/library behave identically.
 */
const { ethers } = require('ethers');

function generateMockReadings(n = 50) {
  const baseTs = 1714900000000;  // fixed, must match Python
  const readings = [];
  for (let i = 0; i < n; i++) {
    readings.push({
      voltage_mv: 5500 + (i % 10) * 50,
      current_ma: 240 + (i % 8) * 10,
      timestamp_ms: baseTs + i * 1000
    });
  }
  return readings;
}

function packReadings(readings) {
  // 24 bytes per reading: 3 × uint64 big-endian (voltage_mv, current_ma, timestamp_ms)
  const buf = new Uint8Array(readings.length * 24);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < readings.length; i++) {
    const offset = i * 24;
    view.setBigUint64(offset,      BigInt(readings[i].voltage_mv),    false);
    view.setBigUint64(offset + 8,  BigInt(readings[i].current_ma),    false);
    view.setBigUint64(offset + 16, BigInt(readings[i].timestamp_ms),  false);
  }
  return buf;
}

const readings = generateMockReadings(50);
const packed = packReadings(readings);
const packedHex = '0x' + Buffer.from(packed).toString('hex');
const hash = ethers.keccak256(packed);

console.log(`Total readings: ${readings.length}`);
console.log(`Packed bytes length: ${packed.length} (expected 1200)`);
console.log(`Packed bytes (hex): ${packedHex}`);
console.log(`Keccak256 hash:     ${hash}`);
