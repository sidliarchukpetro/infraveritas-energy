"""Canonical payload serialization and Poseidon hash computation.

Hash: Poseidon BN254 sponge (t=5 rate=4) matching Noir circuit.
Spec: docs/specs/poseidon_params.md v1.1.
Tested: edge/tests/test_poseidon_sponge.py.

Encoding: 2456 canonical bytes -> 307 field elements (8 BE bytes per uint64
-> 1 BN254 field element) -> sponge -> 32-byte digest.
"""

import struct

from .edge_device import CanonicalPayload, Reading
from .poseidon import poseidon_sponge


# Expected number of readings per epoch (10 Hz × 10 seconds)
READINGS_PER_PAYLOAD = 100

# Byte size per reading: 3 × uint64 big-endian = 24 bytes
READING_BYTES = 24

# Byte size of payload metadata before readings:
# device_id (8) + session_id (8) + epoch_start_ts (8) + lat_e7 (8) + lon_e7 (8)
# + light_level (8) + tamper_flag (8) = 56 bytes
METADATA_BYTES = 56

# Total payload size: 56 + 100 × 24 = 2456 bytes
EXPECTED_PAYLOAD_BYTES = METADATA_BYTES + READINGS_PER_PAYLOAD * READING_BYTES


def canonicalize(payload: CanonicalPayload) -> bytes:
    """Serialize payload deterministically.

    Field order MUST match V3.PublicInputs struct order and Noir circuit
    public input order. Any change here breaks signature verification.

    Encoding rules:
        - All integers big-endian (network byte order)
        - lat_e7, lon_e7 signed 64-bit (two's complement)
        - All other metadata fields unsigned 64-bit
        - Readings appended in order, no length prefix (count fixed at 100)

    Returns:
        Concatenated bytes of length EXPECTED_PAYLOAD_BYTES (2456).
    """
    if len(payload.readings) != READINGS_PER_PAYLOAD:
        raise ValueError(
            f"Expected {READINGS_PER_PAYLOAD} readings, got {len(payload.readings)}"
        )

    out = b""
    out += struct.pack(">Q", payload.device_id)
    out += struct.pack(">Q", payload.session_id)
    out += struct.pack(">Q", payload.epoch_start_ts)
    out += struct.pack(">q", payload.lat_e7)  # signed
    out += struct.pack(">q", payload.lon_e7)  # signed
    out += struct.pack(">Q", payload.light_level)
    out += struct.pack(">Q", payload.tamper_flag)

    for r in payload.readings:
        out += struct.pack(">Q", r.voltage_mv)
        out += struct.pack(">Q", r.current_ma)
        out += struct.pack(">Q", r.timestamp_ms)

    assert len(out) == EXPECTED_PAYLOAD_BYTES, (
        f"Canonical encoding wrong size: {len(out)} != {EXPECTED_PAYLOAD_BYTES}"
    )
    return out


def compute_payload_hash(payload: CanonicalPayload) -> bytes:
    """Compute 32-byte Poseidon hash. Matches Noir circuit bit-exact."""
    canonical_bytes = canonicalize(payload)
    field_elements = [int.from_bytes(canonical_bytes[i:i+8], "big") for i in range(0, len(canonical_bytes), 8)]
    return poseidon_sponge(field_elements).to_bytes(32, "big")
