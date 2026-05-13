"""Canonical payload serialization and hash computation.

Hash function is currently SHA-256 placeholder. Real implementation will use
Poseidon (BN254) once Olexandr freezes parameters during v08 circuit design
(Etap 3 тиждень 8 per V3 design v0.3 §3.1).

The hash MUST match what the Noir circuit computes — any divergence causes
silent verification failure (signature mismatch on chain).
"""

import hashlib
import struct

from .edge_device import CanonicalPayload, Reading


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
    """Compute 32-byte payload hash.

    PLACEHOLDER: SHA-256. Target: Poseidon (BN254). Spec frozen v0.9 at
    docs/specs/poseidon_params.md. Phase 1 (Noir test vectors) DEFERRED, see
    zk/circuits/v08_poseidon_vectors/README.md. This function unblocked when
    Phase 1 lands docs/specs/poseidon_test_vectors.json.

    Critical: edge / aggregator / circuit hashes MUST match. Silent
    mismatch = silent on-chain verification failure.

    Returns 32 bytes signed by edge HSM, used as ZK public input.
    """
    canonical_bytes = canonicalize(payload)
    return hashlib.sha256(canonical_bytes).digest()
