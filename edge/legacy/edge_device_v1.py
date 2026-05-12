#!/usr/bin/env python3
"""
InfraVeritas Edge Device Simulator (v2.0 message format)
Simulates IoT device: generates 100 readings at 10 Hz, signs with v2.0 message format
including GPS coordinates, light level, and tamper flag.
Replace generate_mock_readings() with real PZEM/INA226 readings when hardware arrives.
"""

import json
import struct
import time
import requests
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak

# Device configuration
DEVICE_ID = 42
DEVICE_PRIVATE_KEY = "0x6bbaa833c4dc9845739d0057ce8d743477798b46a605f816951b08685f858463"
AGGREGATOR_URL = "http://localhost:3000/submit"

# v2.0 sample protocol
SAMPLE_RATE_HZ = 10
EPOCH_DURATION_SEC = 10
READINGS_PER_EPOCH = 100  # 10 Hz × 10 sec
SAMPLE_INTERVAL_MS = 100  # 1000 / 10

# Geolocation: Sniatyn, Ivano-Frankivsk, UA — int32 microdegrees
DEFAULT_LAT_MICRODEG = 48451700  # 48.4517°N
DEFAULT_LON_MICRODEG = 25575200  # 25.5752°E

# v2.0 simulated values for Phase A (until hardware arrives)
SIMULATED_LIGHT_LEVEL_LUX = 5000  # daytime baseline
SIMULATED_TAMPER_FLAG = 0  # 0 = OK, 1 = tamper detected


def generate_mock_readings(n=READINGS_PER_EPOCH):
    """
    Mock readings simulating solar panel output at 10 Hz.
    Replace with: return read_pzem016(n) when hardware arrives.
    """
    readings = []
    base_ts = int(time.time() * 1000)
    for i in range(n):
        readings.append({
            "voltage_mv": 5500 + (i % 10) * 50,
            "current_ma": 240 + (i % 8) * 10,
            "timestamp_ms": base_ts + i * SAMPLE_INTERVAL_MS
        })
    return readings


def pack_readings(readings):
    """
    Deterministic byte serialization.
    24 bytes per reading: 3 × uint64 big-endian (voltage_mv, current_ma, timestamp_ms).
    Must match packReadings() in src/verify.ts byte-for-byte.
    """
    buf = b""
    for r in readings:
        buf += struct.pack(">Q", r["voltage_mv"])
        buf += struct.pack(">Q", r["current_ma"])
        buf += struct.pack(">Q", r["timestamp_ms"])
    return buf


def readings_hash_hex(readings):
    return "0x" + keccak(pack_readings(readings)).hex()


def sign_payload(device_id, session_id, epoch_start_ts, lat, lon,
                 light_level, tamper_flag, readings_hash):
    """Sign payload with device private key. Message format matches src/verify.ts."""
    message = (f"infraveritas:{device_id}:{session_id}:{epoch_start_ts}"
               f":{lat}:{lon}:{light_level}:{tamper_flag}:{readings_hash}")
    account = Account.from_key(DEVICE_PRIVATE_KEY)
    msg = encode_defunct(text=message)
    signed = account.sign_message(msg)
    return signed.signature.hex()


def submit_epoch(session_id):
    """Submit one epoch of readings to aggregator (v2.0 message format)"""
    epoch_start_ts = int(time.time())
    readings = generate_mock_readings()

    h = readings_hash_hex(readings)
    sig = sign_payload(
        DEVICE_ID, session_id, epoch_start_ts,
        DEFAULT_LAT_MICRODEG, DEFAULT_LON_MICRODEG,
        SIMULATED_LIGHT_LEVEL_LUX, SIMULATED_TAMPER_FLAG, h
    )
    signature_hex = "0x" + sig if not sig.startswith("0x") else sig

    payload = {
        "deviceId": DEVICE_ID,
        "sessionId": session_id,
        "epochStartTs": epoch_start_ts,
        "lat": DEFAULT_LAT_MICRODEG,
        "lon": DEFAULT_LON_MICRODEG,
        "lightLevel": SIMULATED_LIGHT_LEVEL_LUX,
        "tamperFlag": SIMULATED_TAMPER_FLAG,
        "minTotalEnergy": 100,
        "signature": signature_hex,
        "readings": readings
    }

    print(f"\n[{time.strftime('%H:%M:%S')}] Submitting epoch session={session_id}")
    print(f"  epochStartTs:  {epoch_start_ts}")
    print(f"  GPS:           {DEFAULT_LAT_MICRODEG/1e6:.6f}, {DEFAULT_LON_MICRODEG/1e6:.6f}")
    print(f"  light level:   {SIMULATED_LIGHT_LEVEL_LUX} lux")
    print(f"  tamper flag:   {SIMULATED_TAMPER_FLAG}")
    print(f"  readings:      {len(readings)} samples")
    print(f"  readingsHash:  {h}")

    try:
        response = requests.post(AGGREGATOR_URL, json=payload, timeout=120)
        result = response.json()

        if response.status_code == 200:
            print(f"  ✓ Status: {result.get('status')}")
            print(f"  ✓ Proof: {result.get('proofGenerationTimeMs')}ms")
            print(f"  ✓ TxHash: {result.get('txHash', 'pending')}")
            print(f"  ✓ Chain: {result.get('chainStatus', 'pending')}")
        else:
            print(f"  ✗ Error {response.status_code}: {result.get('error')}")

    except requests.exceptions.Timeout:
        print("  ✗ Timeout — proof generation took too long")
    except Exception as e:
        print(f"  ✗ Exception: {e}")


if __name__ == "__main__":
    print("InfraVeritas Edge Device Simulator (v2.0 message format)")
    print(f"Device ID:    {DEVICE_ID}")
    print(f"Aggregator:   {AGGREGATOR_URL}")
    print(f"Sample rate:  {SAMPLE_RATE_HZ} Hz × {EPOCH_DURATION_SEC}s = {READINGS_PER_EPOCH} readings")
    print(f"GPS:          {DEFAULT_LAT_MICRODEG/1e6:.6f}°N, {DEFAULT_LON_MICRODEG/1e6:.6f}°E")
    print("Press Ctrl+C to stop\n")

    session_id = int(time.time())
    submit_epoch(session_id)
