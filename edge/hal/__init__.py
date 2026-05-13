"""InfraVeritas edge device Hardware Abstraction Layer.

Provides:
    - EdgeDevice Protocol: interface for all edge devices (mock and real)
    - MockEdgeDevice: software simulator with configurable scenarios
    - P256Signer: software ECDSA P-256 signer (production uses ATECC608B HSM)
    - Canonical payload encoding and hashing
"""

from .edge_device import (
    CanonicalPayload,
    EdgeDevice,
    GPSFix,
    Reading,
    SignedSubmission,
)
from .mock_edge_device import MockEdgeDevice, MockEdgeDeviceConfig
from .signing import P256Signer

__all__ = [
    "CanonicalPayload",
    "EdgeDevice",
    "GPSFix",
    "MockEdgeDevice",
    "MockEdgeDeviceConfig",
    "P256Signer",
    "Reading",
    "SignedSubmission",
]
