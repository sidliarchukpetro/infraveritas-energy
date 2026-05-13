"""EdgeDevice Protocol — interface for all edge devices.

Production implementation (RaspberryPiEdgeDevice, Етап 4b) reads from real
PZEM-017 over Modbus, GPS NEO-6M over UART, tamper switches over GPIO, and
signs via ATECC608B HSM.

Mock implementation (MockEdgeDevice) provides configurable scenarios for
software-first testing per InfraVeritas MVP Plan v1.4 §B.
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Reading:
    """Single energy measurement sample (typically at 10 Hz sample rate).

    Units chosen for integer encoding — edge devices avoid floats:
        voltage_mv: millivolts (typical solar after MPPT: 0-7000 mV)
        current_ma: milliamperes (typical residential: 0-15000 mA)
        timestamp_ms: milliseconds since UNIX epoch (GPS-synchronized)
    """
    voltage_mv: int
    current_ma: int
    timestamp_ms: int


@dataclass(frozen=True)
class GPSFix:
    """GPS fix from NEO-6M or equivalent receiver.

    Coordinates in E7 representation: degrees × 10^7.
    Allows int32 storage with ~1.1 cm precision at equator.
    """
    lat_e7: int
    lon_e7: int
    timestamp_s: int


@dataclass(frozen=True)
class CanonicalPayload:
    """Full canonical payload — signed by edge, verified on chain.

    Field order MUST match Noir circuit v08+ public input order and
    V3 contract PublicInputs struct (see V3_design.md §11). Changing
    order breaks signature verification across the stack.
    """
    device_id: int
    session_id: int
    epoch_start_ts: int
    lat_e7: int
    lon_e7: int
    light_level: int
    tamper_flag: int  # 0 = OK, 1 = tamper detected
    readings: tuple[Reading, ...]  # frozen for hashability; expect exactly 100


@dataclass(frozen=True)
class SignedSubmission:
    """Result of signing a CanonicalPayload — what gets sent to aggregator."""
    payload: CanonicalPayload
    payload_hash: bytes  # 32 bytes — Poseidon (BN254) or SHA-256 placeholder
    signature: bytes     # 64 bytes — P-256 ECDSA (r || s, raw not DER)
    public_key: bytes    # 64 bytes — P-256 uncompressed (X || Y)


class EdgeDevice(Protocol):
    """Protocol for all edge devices (mock and real hardware).

    Methods correspond to physical sensors / operations:
        - read_readings: PZEM-017 DC voltage/current sampling
        - read_gps: NEO-6M coordinate + time fix
        - read_tamper_switch: magnetic reed switch state
        - get_public_key: registered public key for this device
        - sign_payload: ATECC608B HSM signing operation
    """

    def read_readings(self, n: int) -> tuple[Reading, ...]:
        """Read n energy samples (typically 100 at 10 Hz over 10 seconds)."""
        ...

    def read_gps(self) -> GPSFix:
        """Read current GPS fix (coords + time)."""
        ...

    def read_tamper_switch(self) -> bool:
        """Read tamper switch state. True = tamper detected (case opened)."""
        ...

    def get_public_key(self) -> bytes:
        """Return uncompressed P-256 public key (64 bytes: X || Y)."""
        ...

    def sign_payload(self, payload: CanonicalPayload) -> SignedSubmission:
        """Compute payload hash and sign with device key. Returns full submission."""
        ...
