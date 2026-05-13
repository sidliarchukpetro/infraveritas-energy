"""MockEdgeDevice — software simulator implementing EdgeDevice Protocol.

Configurable behaviors for testing scenarios:
    - Normal solar generation (default)
    - Nighttime (all-zero readings)
    - Tamper triggered (tamper_active=True)
    - GPS spoofing (fixed_lat_e7/fixed_lon_e7 differ from registered coords)
    - Programmable voltage/current baselines
"""

import time
from dataclasses import dataclass
from typing import Optional

from .canonical import compute_payload_hash
from .edge_device import (
    CanonicalPayload,
    GPSFix,
    Reading,
    SignedSubmission,
)
from .signing import P256Signer


@dataclass
class MockEdgeDeviceConfig:
    """Configurable scenarios for MockEdgeDevice.

    Defaults represent a typical sunny-day solar generation for a small
    residential installation in Sniatyn (Ivano-Frankivsk, Ukraine).
    """
    # Energy generation baseline (mid-day clear sky)
    base_voltage_mv: int = 5500
    base_current_ma: int = 240

    # GPS — Sniatyn coordinates by default
    fixed_lat_e7: int = 484517000   # 48.4517°N
    fixed_lon_e7: int = 255752000   # 25.5752°E

    # Tamper switch state
    tamper_active: bool = False

    # Light level (lux) — used in V3 PublicInputs.lightLevel
    light_level: int = 5000   # daytime baseline

    # Scenario override — if True, all readings are zero (no generation)
    nighttime: bool = False

    # Sample rate (Hz). Typical 10 Hz → 100 readings per 10-second epoch.
    sample_rate_hz: int = 10


class MockEdgeDevice:
    """Mock edge device implementing EdgeDevice Protocol.

    Combines software P-256 signer with configurable sensor behaviors.
    Sensor methods are deterministic given the config (no real hardware
    randomness), making tests reproducible.
    """

    def __init__(
        self,
        signer: Optional[P256Signer] = None,
        config: Optional[MockEdgeDeviceConfig] = None,
    ):
        self.signer = signer if signer is not None else P256Signer()
        self.config = config if config is not None else MockEdgeDeviceConfig()

    def read_readings(self, n: int) -> tuple[Reading, ...]:
        """Generate n simulated readings."""
        if n < 1:
            raise ValueError(f"n must be >= 1, got {n}")

        sample_interval_ms = 1000 // self.config.sample_rate_hz
        base_ts_ms = int(time.time() * 1000)

        readings = []
        for i in range(n):
            if self.config.nighttime:
                voltage_mv = 0
                current_ma = 0
            else:
                # Slight deterministic variation to mimic sensor noise
                voltage_mv = self.config.base_voltage_mv + (i % 10) * 50
                current_ma = self.config.base_current_ma + (i % 8) * 10

            readings.append(Reading(
                voltage_mv=voltage_mv,
                current_ma=current_ma,
                timestamp_ms=base_ts_ms + i * sample_interval_ms,
            ))

        return tuple(readings)

    def read_gps(self) -> GPSFix:
        return GPSFix(
            lat_e7=self.config.fixed_lat_e7,
            lon_e7=self.config.fixed_lon_e7,
            timestamp_s=int(time.time()),
        )

    def read_tamper_switch(self) -> bool:
        return self.config.tamper_active

    def get_public_key(self) -> bytes:
        return self.signer.public_key

    def sign_payload(self, payload: CanonicalPayload) -> SignedSubmission:
        payload_hash = compute_payload_hash(payload)
        signature = self.signer.sign(payload_hash)
        return SignedSubmission(
            payload=payload,
            payload_hash=payload_hash,
            signature=signature,
            public_key=self.signer.public_key,
        )
