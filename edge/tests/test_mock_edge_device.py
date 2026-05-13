"""Tests for MockEdgeDevice and supporting modules.

Coverage:
    - MockEdgeDevice sensor methods (readings, GPS, tamper)
    - P256Signer: key generation, format, signature verification
    - Canonical payload encoding: deterministic, correct size, layout
    - Hash placeholder: matches direct SHA-256, deterministic
    - sign_payload integration: produces signature verifiable against pubkey
"""

import struct

import pytest

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    Prehashed,
    encode_dss_signature,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hal import (
    CanonicalPayload,
    MockEdgeDevice,
    MockEdgeDeviceConfig,
    P256Signer,
    Reading,
)
from hal.canonical import (
    EXPECTED_PAYLOAD_BYTES,
    READINGS_PER_PAYLOAD,
    canonicalize,
    compute_payload_hash,
)


# ============================================================
# Helpers
# ============================================================

def _make_test_payload(readings_count: int = READINGS_PER_PAYLOAD) -> CanonicalPayload:
    readings = tuple(
        Reading(voltage_mv=5500 + i, current_ma=240 + i, timestamp_ms=1000 + i * 100)
        for i in range(readings_count)
    )
    return CanonicalPayload(
        device_id=42,
        session_id=1,
        epoch_start_ts=1_778_000_000,
        lat_e7=484517000,
        lon_e7=255752000,
        light_level=5000,
        tamper_flag=0,
        readings=readings,
    )


# ============================================================
# MockEdgeDevice — readings
# ============================================================

class TestMockEdgeDeviceReadings:
    def test_returns_requested_count(self):
        device = MockEdgeDevice()
        assert len(device.read_readings(100)) == 100

    def test_returns_tuple_of_reading(self):
        device = MockEdgeDevice()
        readings = device.read_readings(5)
        assert isinstance(readings, tuple)
        for r in readings:
            assert isinstance(r, Reading)
            assert isinstance(r.voltage_mv, int)
            assert isinstance(r.current_ma, int)
            assert isinstance(r.timestamp_ms, int)

    def test_zero_at_nighttime(self):
        device = MockEdgeDevice(config=MockEdgeDeviceConfig(nighttime=True))
        readings = device.read_readings(10)
        for r in readings:
            assert r.voltage_mv == 0
            assert r.current_ma == 0

    def test_nonzero_normal_daytime(self):
        device = MockEdgeDevice(config=MockEdgeDeviceConfig(nighttime=False))
        readings = device.read_readings(10)
        for r in readings:
            assert r.voltage_mv > 0
            assert r.current_ma > 0

    def test_rejects_zero_count(self):
        device = MockEdgeDevice()
        with pytest.raises(ValueError):
            device.read_readings(0)

    def test_rejects_negative_count(self):
        device = MockEdgeDevice()
        with pytest.raises(ValueError):
            device.read_readings(-1)

    def test_timestamps_monotonic(self):
        device = MockEdgeDevice()
        readings = device.read_readings(100)
        for i in range(1, len(readings)):
            assert readings[i].timestamp_ms > readings[i - 1].timestamp_ms

    def test_sample_interval_matches_rate(self):
        """At 10 Hz sample interval should be 100 ms between samples."""
        config = MockEdgeDeviceConfig(sample_rate_hz=10)
        device = MockEdgeDevice(config=config)
        readings = device.read_readings(2)
        delta = readings[1].timestamp_ms - readings[0].timestamp_ms
        assert delta == 100


# ============================================================
# MockEdgeDevice — GPS
# ============================================================

class TestMockEdgeDeviceGPS:
    def test_returns_configured_coords(self):
        config = MockEdgeDeviceConfig(
            fixed_lat_e7=400000000,
            fixed_lon_e7=-700000000,
        )
        device = MockEdgeDevice(config=config)
        fix = device.read_gps()
        assert fix.lat_e7 == 400000000
        assert fix.lon_e7 == -700000000

    def test_default_sniatyn_coords(self):
        device = MockEdgeDevice()
        fix = device.read_gps()
        assert fix.lat_e7 == 484517000
        assert fix.lon_e7 == 255752000

    def test_returns_recent_timestamp(self):
        import time
        device = MockEdgeDevice()
        before = int(time.time())
        fix = device.read_gps()
        after = int(time.time())
        assert before <= fix.timestamp_s <= after


# ============================================================
# MockEdgeDevice — tamper
# ============================================================

class TestMockEdgeDeviceTamper:
    def test_default_off(self):
        device = MockEdgeDevice()
        assert device.read_tamper_switch() is False

    def test_active_when_configured(self):
        device = MockEdgeDevice(config=MockEdgeDeviceConfig(tamper_active=True))
        assert device.read_tamper_switch() is True


# ============================================================
# P256Signer
# ============================================================

class TestP256Signer:
    def test_default_key_generation(self):
        signer = P256Signer()
        assert len(signer.public_key) == 64

    def test_provided_key_used(self):
        key = ec.generate_private_key(ec.SECP256R1())
        signer = P256Signer(private_key=key)
        expected_pub = key.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )[1:]
        assert signer.public_key == expected_pub

    def test_rejects_non_p256_key(self):
        secp256k1_key = ec.generate_private_key(ec.SECP256K1())
        with pytest.raises(ValueError):
            P256Signer(private_key=secp256k1_key)

    def test_signature_is_64_bytes(self):
        signer = P256Signer()
        sig = signer.sign(b"\x00" * 32)
        assert len(sig) == 64

    def test_rejects_short_input(self):
        signer = P256Signer()
        with pytest.raises(ValueError):
            signer.sign(b"\x00" * 31)

    def test_rejects_long_input(self):
        signer = P256Signer()
        with pytest.raises(ValueError):
            signer.sign(b"\x00" * 33)

    def test_signature_verifies_against_pubkey(self):
        """End-to-end signature verification — proves signer produces a
        signature that the public key can verify."""
        signer = P256Signer()
        digest = b"\xab" * 32
        sig_raw = signer.sign(digest)

        # Convert raw r||s → DER for cryptography lib verification
        r = int.from_bytes(sig_raw[:32], "big")
        s = int.from_bytes(sig_raw[32:], "big")
        sig_der = encode_dss_signature(r, s)

        # Reconstruct public key
        pub_bytes_uncompressed = b"\x04" + signer.public_key
        public_key = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), pub_bytes_uncompressed
        )

        # Verify (raises InvalidSignature if invalid)
        public_key.verify(sig_der, digest, ec.ECDSA(Prehashed(hashes.SHA256())))


# ============================================================
# Canonical encoding
# ============================================================

class TestCanonicalEncoding:
    def test_correct_size(self):
        payload = _make_test_payload()
        assert len(canonicalize(payload)) == EXPECTED_PAYLOAD_BYTES

    def test_deterministic(self):
        payload = _make_test_payload()
        assert canonicalize(payload) == canonicalize(payload)

    def test_rejects_wrong_reading_count(self):
        payload = _make_test_payload(readings_count=50)
        with pytest.raises(ValueError):
            canonicalize(payload)

    def test_metadata_layout(self):
        """First 56 bytes match expected struct layout (big-endian)."""
        payload = _make_test_payload()
        encoded = canonicalize(payload)

        unpacked = struct.unpack(">QQQqqQQ", encoded[:56])
        assert unpacked == (
            42,             # device_id
            1,              # session_id
            1_778_000_000,  # epoch_start_ts
            484517000,      # lat_e7
            255752000,      # lon_e7
            5000,           # light_level
            0,              # tamper_flag
        )

    def test_negative_coordinates_two_complement(self):
        """Negative lat/lon must encode as signed int64 two's complement."""
        readings = tuple(Reading(0, 0, 0) for _ in range(READINGS_PER_PAYLOAD))
        payload = CanonicalPayload(
            device_id=1, session_id=1, epoch_start_ts=0,
            lat_e7=-100000000,   # southern hemisphere
            lon_e7=-700000000,   # Americas
            light_level=0, tamper_flag=0,
            readings=readings,
        )
        encoded = canonicalize(payload)
        lat_unpacked = struct.unpack(">q", encoded[24:32])[0]
        lon_unpacked = struct.unpack(">q", encoded[32:40])[0]
        assert lat_unpacked == -100000000
        assert lon_unpacked == -700000000

    def test_reading_layout(self):
        """Reading 0 should appear at offset 56 (after metadata) as 3×uint64 BE."""
        payload = _make_test_payload()
        encoded = canonicalize(payload)
        v, c, ts = struct.unpack(">QQQ", encoded[56:80])
        assert v == 5500    # first reading voltage_mv
        assert c == 240     # first reading current_ma
        assert ts == 1000   # first reading timestamp_ms


# ============================================================
# Payload hash
# ============================================================

class TestPayloadHash:
    def test_is_32_bytes(self):
        h = compute_payload_hash(_make_test_payload())
        assert len(h) == 32

    def test_deterministic(self):
        payload = _make_test_payload()
        assert compute_payload_hash(payload) == compute_payload_hash(payload)

    def test_matches_direct_sha256_placeholder(self):
        """Placeholder hash currently == SHA-256(canonical). When migrating
        to Poseidon this test will be updated."""
        import hashlib
        payload = _make_test_payload()
        expected = hashlib.sha256(canonicalize(payload)).digest()
        assert compute_payload_hash(payload) == expected

    def test_different_payloads_different_hashes(self):
        p1 = _make_test_payload()
        readings = tuple(Reading(0, 0, i) for i in range(READINGS_PER_PAYLOAD))
        p2 = CanonicalPayload(
            device_id=999, session_id=1, epoch_start_ts=0,
            lat_e7=0, lon_e7=0, light_level=0, tamper_flag=0,
            readings=readings,
        )
        assert compute_payload_hash(p1) != compute_payload_hash(p2)


# ============================================================
# sign_payload integration
# ============================================================

class TestSignPayload:
    def test_returns_complete_submission(self):
        device = MockEdgeDevice()
        payload = _make_test_payload()

        submission = device.sign_payload(payload)

        assert submission.payload is payload
        assert len(submission.payload_hash) == 32
        assert len(submission.signature) == 64
        assert len(submission.public_key) == 64
        assert submission.public_key == device.get_public_key()

    def test_signature_verifies_against_device_pubkey(self):
        """Signature produced by sign_payload must verify against the
        device's public key. This is the property V3 contract's CHECK 2
        relies on (P256Verifier.verify)."""
        device = MockEdgeDevice()
        payload = _make_test_payload()
        submission = device.sign_payload(payload)

        pub_uncompressed = b"\x04" + submission.public_key
        public_key = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), pub_uncompressed
        )

        r = int.from_bytes(submission.signature[:32], "big")
        s = int.from_bytes(submission.signature[32:], "big")
        sig_der = encode_dss_signature(r, s)

        # Verify — raises InvalidSignature if invalid
        public_key.verify(
            sig_der, submission.payload_hash,
            ec.ECDSA(Prehashed(hashes.SHA256())),
        )

    def test_payload_hash_matches_canonical_hash(self):
        device = MockEdgeDevice()
        payload = _make_test_payload()
        submission = device.sign_payload(payload)
        assert submission.payload_hash == compute_payload_hash(payload)

    def test_two_devices_produce_different_signatures(self):
        """Different signers (different keys) produce different signatures
        for the same payload."""
        d1 = MockEdgeDevice()
        d2 = MockEdgeDevice()
        payload = _make_test_payload()

        s1 = d1.sign_payload(payload)
        s2 = d2.sign_payload(payload)

        assert s1.public_key != s2.public_key
        assert s1.signature != s2.signature
        # But payload hash is same (signing doesn't depend on key)
        assert s1.payload_hash == s2.payload_hash
