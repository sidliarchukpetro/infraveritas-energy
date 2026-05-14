"""HTTPS client for submitting signed payloads to InfraVeritas aggregator.

Wire format matches aggregator's zod schema (aggregator/src/api/server.ts).
This module is the single source of truth on the edge side for HTTP transport;
the HAL layer (edge/hal/) only knows how to measure and sign — it has no idea
where bytes go.

Critical wire-format rules (must match server.ts exactly):
  - All uint64/int64 fields encoded as decimal strings (JSON numbers unsafe
    past 2^53; uint64 max is 2^64-1).
  - signature, public_key as lowercase hex, exactly 128 chars (no 0x prefix).
  - Exactly 100 readings per submission.

TLS posture:
  - HTTPS by default (verify_ssl=True; uses system CA bundle via certifi).
  - Custom CA bundle supported (ca_bundle param) for private CA deployments.
  - verify_ssl=False only for self-signed dev environments; never production.

Example:
    from edge.hal.signing import P256Signer
    from edge.network.client import AggregatorClient

    signer = P256Signer()  # production: HSM-backed
    with AggregatorClient("https://aggregator.example.com", signer) as client:
        response = client.submit(payload)
        status = client.get_status(response.session_key)
"""

from dataclasses import dataclass
from typing import Optional, Union
from urllib.parse import urljoin

import httpx

from hal.canonical import compute_payload_hash
from hal.edge_device import CanonicalPayload
from hal.signing import P256Signer


# ---------- Errors ----------


class SubmissionRejected(Exception):
    """Aggregator rejected the submission with a structured error response.

    Distinguished from network/transport errors (which raise httpx.HTTPError).
    `code` is one of the server's error codes — caller can route on it.
    """

    def __init__(self, code: str, message: str, http_status: int):
        super().__init__(f"{code} (HTTP {http_status}): {message}")
        self.code = code
        self.message = message
        self.http_status = http_status


# ---------- Response types ----------


@dataclass(frozen=True)
class SubmissionResponse:
    """Successful submission response (HTTP 202 Accepted)."""

    session_key: str  # 0x-prefixed 64-hex (keccak256 of device_id || session_id)
    status: str  # "pending"
    poll_url: Optional[str] = None


@dataclass(frozen=True)
class SubmissionStatus:
    """Status of a previously submitted payload (GET /submissions/:id)."""

    id: str
    status: str  # "pending" | "processing" | "complete" | "failed" | "quarantined"
    attempts: int
    enqueued_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[dict] = None


# ---------- Client ----------


class AggregatorClient:
    """HTTPS client for the InfraVeritas aggregator.

    Thread-safety: one client instance per thread. The underlying httpx.Client
    pools connections — reuse the same instance for many submissions.
    """

    def __init__(
        self,
        base_url: str,
        signer: P256Signer,
        *,
        timeout_s: float = 30.0,
        verify_ssl: bool = True,
        ca_bundle: Optional[str] = None,
    ):
        """
        Args:
            base_url: aggregator HTTPS endpoint (e.g. "https://api.infraveritas.pro")
            signer: P-256 signer instance (production: HSM-backed)
            timeout_s: per-request HTTP timeout (default 30s)
            verify_ssl: verify server TLS cert (default True; disable only for
                        self-signed dev — NEVER in production)
            ca_bundle: optional path to a custom CA bundle (e.g. private CA)
        """
        self.base_url = base_url.rstrip("/")
        self.signer = signer

        verify: Union[bool, str] = ca_bundle if ca_bundle else verify_ssl
        self._client = httpx.Client(
            timeout=timeout_s,
            verify=verify,
            headers={
                "User-Agent": f"infraveritas-edge/{_version()}",
                "Content-Type": "application/json",
            },
        )

    # ---------- Public API ----------

    def submit(self, payload: CanonicalPayload) -> SubmissionResponse:
        """Sign payload (Poseidon hash → P-256 sig) and submit to aggregator.

        Returns:
            SubmissionResponse on 202 Accepted (queued for processing).

        Raises:
            SubmissionRejected: aggregator rejected (400 validation, 409 duplicate).
            httpx.HTTPError: network/transport failure (timeout, DNS, TLS error).
        """
        payload_hash = compute_payload_hash(payload)
        signature = self.signer.sign(payload_hash)

        body = self._encode_request(payload, signature, self.signer.public_key)
        url = urljoin(self.base_url + "/", "submissions")

        response = self._client.post(url, json=body)

        if response.status_code == 202:
            data = response.json()
            return SubmissionResponse(
                session_key=data["sessionKey"],
                status=data["status"],
                poll_url=data.get("poll"),
            )

        if response.status_code in (400, 409):
            data = response.json()
            raise SubmissionRejected(
                code=data.get("error", "Unknown"),
                message=str(data.get("issues") or data.get("sessionKey") or data),
                http_status=response.status_code,
            )

        response.raise_for_status()
        raise RuntimeError(
            f"Unexpected response: {response.status_code} {response.text}"
        )

    def get_status(self, session_key: str) -> SubmissionStatus:
        """Poll the status of a previously submitted payload.

        Returns:
            SubmissionStatus with current pipeline state.

        Raises:
            SubmissionRejected: 404 if session_key is unknown.
            httpx.HTTPError: network/transport failure.
        """
        url = urljoin(self.base_url + "/", f"submissions/{session_key}")
        response = self._client.get(url)

        if response.status_code == 404:
            raise SubmissionRejected("NotFound", session_key, 404)

        response.raise_for_status()
        data = response.json()
        return SubmissionStatus(
            id=data["id"],
            status=data["status"],
            attempts=data["attempts"],
            enqueued_at=data["enqueuedAt"],
            started_at=data.get("startedAt"),
            finished_at=data.get("finishedAt"),
            error=data.get("error"),
        )

    def health(self) -> dict:
        """Check aggregator liveness and queue stats."""
        url = urljoin(self.base_url + "/", "health")
        response = self._client.get(url)
        response.raise_for_status()
        return response.json()

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._client.close()

    def __enter__(self) -> "AggregatorClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ---------- Wire format ----------

    @staticmethod
    def _encode_request(
        payload: CanonicalPayload,
        signature: bytes,
        public_key: bytes,
    ) -> dict:
        """Encode payload+sig+pubkey into wire JSON.

        Wire format per aggregator/src/api/server.ts zod schema:
          - All numeric fields as decimal strings (int → str preserves uint64)
          - signature, public_key as lowercase hex (no 0x prefix, 128 chars each)
          - readings: exactly 100 items

        Raises:
            ValueError: if signature or public_key are not 64 bytes.
        """
        if len(signature) != 64:
            raise ValueError(f"Expected 64-byte signature, got {len(signature)}")
        if len(public_key) != 64:
            raise ValueError(f"Expected 64-byte public_key, got {len(public_key)}")

        return {
            "payload": {
                "device_id": str(payload.device_id),
                "session_id": str(payload.session_id),
                "epoch_start_ts": str(payload.epoch_start_ts),
                "lat_e7": str(payload.lat_e7),
                "lon_e7": str(payload.lon_e7),
                "light_level": str(payload.light_level),
                "tamper_flag": str(payload.tamper_flag),
                "readings": [
                    {
                        "voltage_mv": str(r.voltage_mv),
                        "current_ma": str(r.current_ma),
                        "timestamp_ms": str(r.timestamp_ms),
                    }
                    for r in payload.readings
                ],
            },
            "signature": signature.hex(),
            "public_key": public_key.hex(),
        }


def _version() -> str:
    """Best-effort package version (for User-Agent header)."""
    try:
        from importlib.metadata import version

        return version("infraveritas-edge")
    except Exception:
        return "0.1.0"
