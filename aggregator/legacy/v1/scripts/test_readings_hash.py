#!/usr/bin/env python3
"""
Sanity check: byte-packed readings hash.
Goal — get the same keccak256 from Python (here) and Node (ethers).
If hashes match — go to integration. If not — fix encoding before touching the server.
"""

import struct
from eth_utils import keccak


def generate_mock_readings(n=50):
    """Same readings as edge_device.py — but with fixed timestamp for reproducibility."""
    base_ts = 1714900000000  # fixed, not time.time(), so the hash is reproducible
    readings = []
    for i in range(n):
        readings.append({
            "voltage_mv": 5500 + (i % 10) * 50,
            "current_ma": 240 + (i % 8) * 10,
            "timestamp_ms": base_ts + i * 1000
        })
    return readings


def pack_readings(readings):
    """
    Deterministic byte serialization.
    Each reading: 24 bytes (3 × uint64 big-endian).
    50 readings: 1200 bytes total.
    Order of fields is fixed: voltage_mv, current_ma, timestamp_ms.
    """
    buf = b""
    for r in readings:
        buf += struct.pack(">Q", r["voltage_mv"])    # 8 bytes BE uint64
        buf += struct.pack(">Q", r["current_ma"])    # 8 bytes BE uint64
        buf += struct.pack(">Q", r["timestamp_ms"])  # 8 bytes BE uint64
    return buf


def readings_hash_hex(readings):
    packed = pack_readings(readings)
    return "0x" + keccak(packed).hex()


if __name__ == "__main__":
    readings = generate_mock_readings(50)
    packed = pack_readings(readings)
    hash_hex = readings_hash_hex(readings)

    print(f"Total readings: {len(readings)}")
    print(f"Packed bytes length: {len(packed)} (expected 1200)")
    print(f"Packed bytes (hex): 0x{packed.hex()}")
    print(f"Keccak256 hash:     {hash_hex}")
