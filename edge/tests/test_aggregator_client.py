"""Tests for the HTTPS aggregator client.

Critical test: `test_wire_format_matches_server_schema` — verifies that the
JSON body produced by the edge client EXACTLY matches the aggregator's zod
schema. Any drift between edge encoding and server parsing breaks production.

v0.3 (2026-05-17): AggregatorClient now requires v3_address + chain_id
keyword args for EIP-712 typed signing domain. All test constructors
updated to pass placeholder values — tests are mock-based, so the actual
chain/address values don't affect business logic, only that they're present.
"""

import json
import pytest
import respx
from httpx import Response

from hal.edge_device import CanonicalPayload, Reading
from hal.signing import P256Signer
from network.client import (
    AggregatorClient,
    SubmissionRejected,
    SubmissionResponse,
)

AGGREGATOR_URL = "https://aggregator.example.com"

# Test constants for EIP-712 typed signing (v0.3+).
# These are placeholder values — tests are HTTP-mock based, so the actual
# chain/address values don't reach a real chain. They only need to be present
# for AggregatorClient constructor and for digest computation determinism.
TEST_V3_ADDRESS = "0x" + "11" * 20  # 0x1111...1111
TEST_CHAIN_ID = 31337  # anvil/foundry default


def _make_client(signer: P256Signer | None = None) -> AggregatorClient:
    """Test fixture — AggregatorClient with EIP-712 domain params populated."""
    return AggregatorClient(
        AGGREGATOR_URL,
        signer or P256Signer(),
        v3_address=TEST_V3_ADDRESS,
        chain_id=TEST_CHAIN_ID,
    )


def _make_payload(session_id: int = 1) -> CanonicalPayload:
    readings = tuple(
        Reading(
            voltage_mv=5500 + i,
            current_ma=240 + i,
            timestamp_ms=1000 + i * 100,
        )
        for i in range(100)
    )
    return CanonicalPayload(
        device_id=42,
        session_id=session_id,
        epoch_start_ts=1_778_000_000,
        lat_e7=484_517_000,
        lon_e7=255_752_000,
        light_level=5000,
        tamper_flag=0,
        readings=readings,
    )


@respx.mock
def test_submit_returns_session_key_on_202():
    respx.post(f"{AGGREGATOR_URL}/submissions").mock(
        return_value=Response(
            202,
            json={
                "sessionKey": "0x" + "ab" * 32,
                "status": "pending",
                "poll": "/submissions/0xab...",
            },
        )
    )

    with _make_client() as client:
        response = client.submit(_make_payload())

    assert isinstance(response, SubmissionResponse)
    assert response.session_key.startswith("0x")
    assert len(response.session_key) == 66
    assert response.status == "pending"


@respx.mock
def test_submit_raises_on_400_validation_error():
    respx.post(f"{AGGREGATOR_URL}/submissions").mock(
        return_value=Response(
            400,
            json={
                "error": "ValidationFailed",
                "issues": [
                    {"path": ["payload", "device_id"], "message": "invalid"}
                ],
            },
        )
    )

    with _make_client() as client:
        with pytest.raises(SubmissionRejected) as exc:
            client.submit(_make_payload())

    assert exc.value.code == "ValidationFailed"
    assert exc.value.http_status == 400


@respx.mock
def test_submit_raises_on_409_duplicate():
    respx.post(f"{AGGREGATOR_URL}/submissions").mock(
        return_value=Response(
            409,
            json={
                "error": "DuplicateSessionKey",
                "sessionKey": "0x" + "cd" * 32,
            },
        )
    )

    with _make_client() as client:
        with pytest.raises(SubmissionRejected) as exc:
            client.submit(_make_payload())

    assert exc.value.code == "DuplicateSessionKey"
    assert exc.value.http_status == 409


@respx.mock
def test_get_status_returns_record():
    session_key = "0x" + "ef" * 32
    respx.get(f"{AGGREGATOR_URL}/submissions/{session_key}").mock(
        return_value=Response(
            200,
            json={
                "id": session_key,
                "status": "complete",
                "attempts": 1,
                "enqueuedAt": "2026-05-14T08:00:00Z",
                "startedAt": "2026-05-14T08:00:01Z",
                "finishedAt": "2026-05-14T08:00:05Z",
            },
        )
    )

    with _make_client() as client:
        status = client.get_status(session_key)

    assert status.status == "complete"
    assert status.attempts == 1
    assert status.finished_at == "2026-05-14T08:00:05Z"


@respx.mock
def test_get_status_404_raises_not_found():
    session_key = "0x" + "00" * 32
    respx.get(f"{AGGREGATOR_URL}/submissions/{session_key}").mock(
        return_value=Response(404, json={"error": "NotFound"})
    )

    with _make_client() as client:
        with pytest.raises(SubmissionRejected) as exc:
            client.get_status(session_key)

    assert exc.value.code == "NotFound"
    assert exc.value.http_status == 404


@respx.mock
def test_health_returns_queue_stats():
    respx.get(f"{AGGREGATOR_URL}/health").mock(
        return_value=Response(
            200,
            json={
                "status": "ok",
                "queue": {"total": 5, "pending": 1, "processing": 0},
                "uptime_s": 1234,
            },
        )
    )

    with _make_client() as client:
        health = client.health()

    assert health["status"] == "ok"
    assert health["queue"]["total"] == 5


@respx.mock
def test_wire_format_matches_server_schema():
    """Verify request body shape matches aggregator zod schema EXACTLY.

    This is the critical contract test — if it passes, edge and aggregator
    agree on serialization. If it fails, production will reject submissions.
    """
    captured: list[bytes] = []

    def capture(request):
        captured.append(request.content)
        return Response(
            202, json={"sessionKey": "0x" + "00" * 32, "status": "pending"}
        )

    respx.post(f"{AGGREGATOR_URL}/submissions").mock(side_effect=capture)

    with _make_client() as client:
        client.submit(_make_payload())

    assert len(captured) == 1
    body = json.loads(captured[0])

    # Top-level keys
    assert set(body.keys()) == {"payload", "signature", "public_key"}

    # All numeric fields are strings (uint64-safe JSON)
    payload = body["payload"]
    assert payload["device_id"] == "42"
    assert payload["session_id"] == "1"
    assert payload["lat_e7"] == "484517000"
    assert payload["lon_e7"] == "255752000"
    assert payload["light_level"] == "5000"
    assert payload["tamper_flag"] == "0"

    for field in (
        "device_id",
        "session_id",
        "epoch_start_ts",
        "lat_e7",
        "lon_e7",
        "light_level",
        "tamper_flag",
    ):
        assert isinstance(payload[field], str), f"{field} must be string"

    # signature, public_key: lowercase hex, exactly 128 chars (no 0x prefix)
    assert len(body["signature"]) == 128
    assert all(c in "0123456789abcdef" for c in body["signature"])
    assert len(body["public_key"]) == 128
    assert all(c in "0123456789abcdef" for c in body["public_key"])

    # Exactly 100 readings, all numeric fields stringified
    assert len(payload["readings"]) == 100
    for reading in payload["readings"]:
        assert set(reading.keys()) == {"voltage_mv", "current_ma", "timestamp_ms"}
        for v in reading.values():
            assert isinstance(v, str)


def test_invalid_signature_length_raises():
    """Client refuses to send if signer returns bad signature length."""

    class BadSigner(P256Signer):
        def sign(self, message_hash: bytes) -> bytes:
            return b"\x00" * 32  # wrong length

    with _make_client(signer=BadSigner()) as client:
        with pytest.raises(ValueError, match="64-byte signature"):
            client.submit(_make_payload())


@respx.mock
def test_negative_int64_encodes_correctly():
    """lat_e7/lon_e7 can be negative — verify wire format handles signed values."""
    payload = CanonicalPayload(
        device_id=42,
        session_id=99,
        epoch_start_ts=1_778_000_000,
        lat_e7=-484_517_000,  # southern hemisphere
        lon_e7=-1_255_752_000,  # western hemisphere
        light_level=5000,
        tamper_flag=0,
        readings=tuple(
            Reading(voltage_mv=5500, current_ma=240, timestamp_ms=1000)
            for _ in range(100)
        ),
    )

    captured: list[bytes] = []

    def capture(request):
        captured.append(request.content)
        return Response(
            202, json={"sessionKey": "0x" + "00" * 32, "status": "pending"}
        )

    respx.post(f"{AGGREGATOR_URL}/submissions").mock(side_effect=capture)

    with _make_client() as client:
        client.submit(payload)

    body = json.loads(captured[0])
    assert body["payload"]["lat_e7"] == "-484517000"
    assert body["payload"]["lon_e7"] == "-1255752000"
