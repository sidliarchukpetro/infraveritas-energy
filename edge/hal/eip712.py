"""EIP-712 typed signing for InfraVeritas Energy V3 (v0.3+).

V3.sol verifies P-256 signatures over EIP-712 typed digests bound to
(chainId, verifyingContract, struct fields). This module mirrors the
on-chain digest computation EXACTLY so edge-side signatures match what
V3.eip712Digest(pubInputs) returns on-chain.

Specs cross-reference:
  - docs/specs/V3_design.md §3.4 (v0.3) — design rationale
  - contracts/src/EnergyProofRegistryV3.sol — on-chain reference
  - contracts/test/V3_EIP712.t.sol — formula validation tests

Field order MUST stay in sync with:
  - V3.sol ENERGY_PROOF_TYPEHASH constant
  - hal/edge_device.py CanonicalPayload field order
  - hal/canonical.py canonicalize() byte order (for payloadHash)

Critical detail on naming: V3 PublicInputs.totalEnergyMWh is NOT actually
MWh — it's the integer sum of (mV × mA) products across all readings.
The aggregator's computeTotalEnergy() in aggregator/src/prover/witness.ts
uses the same formula. Edge MUST mirror it bit-exactly or the digest
diverges and submitProof reverts with InvalidP256Signature.
"""

from dataclasses import dataclass
from typing import Iterable

from Crypto.Hash import keccak

from .edge_device import Reading


# ---------------------------------------------------------------------------
# Domain constants — must match V3.sol exactly
# ---------------------------------------------------------------------------

DOMAIN_NAME = "InfraVeritas Energy"
"""Domain name. Deliberately omits 'V3' to remain stable across upgrades."""

DOMAIN_VERSION = "1"
"""Domain version. Bump (and redeploy + reinitializeEIP712) if PublicInputs
struct shape changes (would require new ENERGY_PROOF_TYPEHASH too)."""


# ---------------------------------------------------------------------------
# Keccak-256 helper (Ethereum variant — NOT FIPS SHA3-256)
# ---------------------------------------------------------------------------

def keccak256(data: bytes) -> bytes:
    """Ethereum Keccak-256.

    Note: hashlib.sha3_256 is FIPS SHA3-256 with different padding bytes,
    NOT compatible with Ethereum/Solidity keccak256. Always use this helper.
    """
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


# ---------------------------------------------------------------------------
# Pre-computed typehashes (module-level, computed once on import)
# ---------------------------------------------------------------------------

EIP712_DOMAIN_TYPEHASH = keccak256(
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)

ENERGY_PROOF_TYPEHASH = keccak256(
    b"EnergyProof(uint64 deviceId,uint64 sessionId,uint64 epochStartTs,"
    b"int64 lat_e7,int64 lon_e7,uint64 lightLevel,uint64 tamperFlag,"
    b"bytes32 payloadHash,uint64 totalEnergyMWh)"
)

DOMAIN_NAME_HASH = keccak256(DOMAIN_NAME.encode("utf-8"))
DOMAIN_VERSION_HASH = keccak256(DOMAIN_VERSION.encode("utf-8"))


# ---------------------------------------------------------------------------
# PublicInputs bundle — matches V3.sol struct PublicInputs
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PublicInputs:
    """EIP-712 typed input bundle matching V3.sol struct PublicInputs.

    Field order MUST match V3.sol ENERGY_PROOF_TYPEHASH and Noir circuit
    public output order. Do NOT reorder.

    All integer fields are Python ints with conceptual fixed-width:
        deviceId, sessionId, epochStartTs, lightLevel, tamperFlag, totalEnergyMWh: uint64
        lat_e7, lon_e7: int64 (signed)
        payloadHash: bytes32 (exactly 32 bytes)
    """
    deviceId: int          # uint64
    sessionId: int         # uint64
    epochStartTs: int      # uint64
    lat_e7: int            # int64 — signed
    lon_e7: int            # int64 — signed
    lightLevel: int        # uint64
    tamperFlag: int        # uint64
    payloadHash: bytes     # bytes32 — must be exactly 32 bytes
    totalEnergyMWh: int    # uint64


# ---------------------------------------------------------------------------
# Primitive ABI encoding — pure Python, no eth-abi dependency needed
# ---------------------------------------------------------------------------
#
# Solidity's abi.encode pads every value (uint/int/address/bytes32) to a
# 32-byte slot. Big-endian for integers. Signed ints use two's complement
# sign-extension to 256 bits.
#
# We only need encoding for primitive fixed-size types because EIP-712
# struct hashing uses abi.encode(typehash, value1, value2, ...) where all
# values are primitive (dynamic types like string get pre-hashed to bytes32).


def _encode_uint(value: int) -> bytes:
    """Encode unsigned int as 32-byte big-endian slot."""
    if value < 0:
        raise ValueError(f"uint must be non-negative, got {value}")
    return value.to_bytes(32, "big", signed=False)


def _encode_int(value: int) -> bytes:
    """Encode signed int as 32-byte two's-complement big-endian slot."""
    return value.to_bytes(32, "big", signed=True)


def _encode_bytes32(value: bytes) -> bytes:
    """Pass through; bytes32 must already be exactly 32 bytes."""
    if len(value) != 32:
        raise ValueError(f"bytes32 must be 32 bytes, got {len(value)}")
    return value


def _encode_address(addr: str) -> bytes:
    """Encode 20-byte address as 32-byte slot (left-padded with 12 zero bytes)."""
    s = addr.lower()
    if s.startswith("0x"):
        s = s[2:]
    if len(s) != 40:
        raise ValueError(f"address must be 20 bytes (40 hex chars), got {len(s)}")
    return b"\x00" * 12 + bytes.fromhex(s)


# ---------------------------------------------------------------------------
# Total energy formula — must match aggregator computeTotalEnergy()
# ---------------------------------------------------------------------------

def compute_total_energy_mwh(readings: Iterable[Reading]) -> int:
    """Sum of voltage_mv × current_ma over all readings.

    Mirrors aggregator/src/prover/witness.ts:computeTotalEnergy bit-exactly:

        let total = 0n;
        for (const r of payload.readings) {
            total += r.voltage_mv * r.current_ma;
        }
        return total;

    Despite the V3 PublicInputs field name 'totalEnergyMWh', this is NOT
    actually MWh. It's the integer sum of (mV × mA) products. Real Wh/MWh
    conversion happens off-chain; the circuit and contract only verify
    bookkeeping consistency.

    Any divergence from aggregator's formula → digest mismatch →
    InvalidP256Signature on submitProof.
    """
    total = 0
    for r in readings:
        total += r.voltage_mv * r.current_ma
    return total


# ---------------------------------------------------------------------------
# Domain separator, struct hash, EIP-712 digest
# ---------------------------------------------------------------------------

def compute_domain_separator(chain_id: int, verifying_contract: str) -> bytes:
    """Compute EIP-712 domain separator for V3 contract on a given chain.

    Solidity reference:
        keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("InfraVeritas Energy"),
            keccak256("1"),
            block.chainid,
            address(this)
        ))

    Args:
        chain_id: target chain ID (11155111 for Sepolia, 1 for mainnet, etc.)
        verifying_contract: V3 proxy address (0x-prefixed, 40 hex chars).

    Returns:
        32-byte domain separator.
    """
    encoded = (
        _encode_bytes32(EIP712_DOMAIN_TYPEHASH)
        + _encode_bytes32(DOMAIN_NAME_HASH)
        + _encode_bytes32(DOMAIN_VERSION_HASH)
        + _encode_uint(chain_id)
        + _encode_address(verifying_contract)
    )
    return keccak256(encoded)


def compute_struct_hash(public_inputs: PublicInputs) -> bytes:
    """Compute EIP-712 struct hash for EnergyProof.

    Solidity reference (V3.sol _structHash):
        keccak256(abi.encode(
            ENERGY_PROOF_TYPEHASH,
            pi.deviceId, pi.sessionId, pi.epochStartTs,
            pi.lat_e7, pi.lon_e7,
            pi.lightLevel, pi.tamperFlag,
            pi.payloadHash, pi.totalEnergyMWh
        ))

    Args:
        public_inputs: PublicInputs bundle (all 9 fields).

    Returns:
        32-byte struct hash.
    """
    encoded = (
        _encode_bytes32(ENERGY_PROOF_TYPEHASH)
        + _encode_uint(public_inputs.deviceId)
        + _encode_uint(public_inputs.sessionId)
        + _encode_uint(public_inputs.epochStartTs)
        + _encode_int(public_inputs.lat_e7)
        + _encode_int(public_inputs.lon_e7)
        + _encode_uint(public_inputs.lightLevel)
        + _encode_uint(public_inputs.tamperFlag)
        + _encode_bytes32(public_inputs.payloadHash)
        + _encode_uint(public_inputs.totalEnergyMWh)
    )
    return keccak256(encoded)


def compute_eip712_digest(
    public_inputs: PublicInputs,
    chain_id: int,
    verifying_contract: str,
) -> bytes:
    """Compute final EIP-712 digest for P-256 signing.

    Solidity reference (V3.sol _eip712Digest):
        keccak256(abi.encodePacked(
            "\\x19\\x01",
            domainSeparator(),
            _structHash(pi)
        ))

    This 32-byte digest is what edge P-256 key MUST sign. V3 contract
    recomputes the same digest from on-chain inputs and verifies the
    signature against it via P256Verifier.verify(digest, r, s, X, Y).

    Args:
        public_inputs: full PublicInputs bundle.
        chain_id: target chain ID.
        verifying_contract: V3 proxy address.

    Returns:
        32-byte digest ready for P256Signer.sign().
    """
    domain_sep = compute_domain_separator(chain_id, verifying_contract)
    struct_hash = compute_struct_hash(public_inputs)
    return keccak256(b"\x19\x01" + domain_sep + struct_hash)
