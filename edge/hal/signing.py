"""Software P-256 (secp256r1) ECDSA signing for edge device simulation.

Production edge devices use ATECC608B HSM where the private key never leaves
the chip. This module provides a software-only equivalent for testing and
development.

Cryptography backend: PyCA `cryptography` (industry standard, audited).
"""

from typing import Optional

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    Prehashed,
    decode_dss_signature,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


P256_PRIVATE_KEY_BYTES = 32
P256_PUBLIC_KEY_BYTES = 64   # uncompressed X || Y
P256_SIGNATURE_BYTES = 64    # raw r || s

# P-256 (secp256r1) curve order n.
# Used for low-s normalization: s > n/2 is normalized to n - s.
# Required because Noir circuit verify_signature rejects high-s.
P256_CURVE_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


class P256Signer:
    """Software P-256 ECDSA signer.

    Holds a P-256 private key in memory (UNSAFE for production — use HSM).

    Public key format: uncompressed point bytes (X || Y, 64 bytes) — matches
    what V3 contract expects in submitProof.devicePubkey parameter.

    Signature format: raw r || s bytes (64 bytes) — matches V3 contract
    expectation of `bytes signature` parameter, NOT DER-encoded.
    """

    def __init__(self, private_key: Optional[ec.EllipticCurvePrivateKey] = None):
        """Create signer with given private key, or generate a new one.

        Args:
            private_key: Existing P-256 private key. If None, a new key is
                         generated using the OS CSPRNG.
        """
        if private_key is None:
            private_key = ec.generate_private_key(ec.SECP256R1())
        elif not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError(
                f"Expected P-256 (SECP256R1) key, got {private_key.curve.name}"
            )
        self._private_key = private_key

        # Cache uncompressed public key bytes (X || Y)
        pub_bytes = private_key.public_key().public_bytes(
            Encoding.X962, PublicFormat.UncompressedPoint
        )
        # X962 uncompressed format: 0x04 prefix + X(32) + Y(32) = 65 bytes
        assert pub_bytes[0] == 0x04 and len(pub_bytes) == 65, "unexpected pubkey encoding"
        self.public_key: bytes = pub_bytes[1:]  # strip 0x04 prefix → 64 bytes

    def sign(self, message_hash: bytes) -> bytes:
        """Sign a 32-byte digest. Returns 64-byte (r || s) signature.

        Args:
            message_hash: 32-byte digest produced by compute_payload_hash.

        Returns:
            64 bytes — r (32) || s (32), big-endian.
        """
        if len(message_hash) != 32:
            raise ValueError(f"Expected 32-byte hash, got {len(message_hash)}")

        # Prehashed tells cryptography lib not to hash internally — we already
        # have a digest. The SHA256() identifier is a placeholder for "32-byte
        # digest"; actual content could be Poseidon when we migrate. Library
        # treats the input as raw bytes either way.
        signature_der = self._private_key.sign(
            message_hash, ec.ECDSA(Prehashed(hashes.SHA256()))
        )

        # Convert DER → raw (r, s) for on-chain submission
        r, s = decode_dss_signature(signature_der)
        # Low-s normalization: Noir circuit verify_signature rejects high-s
        # for non-malleability. PyCA may return either; normalize to low-s.
        if s > P256_CURVE_ORDER // 2:
            s = P256_CURVE_ORDER - s
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")
