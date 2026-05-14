"""Sepolia end-to-end smoke test (with persistent edge device key).

Pipeline: load-or-create P-256 key → canonical payload → POST /submissions →
aggregator validates → witness + proof + local verify → submitProof on real
V3 contract on Sepolia → wait for tx confirmation.

Run AFTER aggregator started in live mode (chain:live). From edge/ root
with venv active:

    python scripts/sepolia_smoke.py

The first run generates a fresh P-256 keypair and saves it to
./edge-test-key.pem. Register the printed pubkey in DeviceRegistry
(see Quarantined section in script output), then re-run — same key
will be reused, and submission should succeed.

Flags:
    --url URL              aggregator endpoint (default http://localhost:3000)
    --key-file PATH        persistent key file (default ./edge-test-key.pem)
    --new-key              force regenerate even if key file exists
    --session-id N         specific session_id (default: unix timestamp)
    --poll-interval-s F    seconds between status polls (default 5)
    --max-poll-s F         timeout for polling (default 300)
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from hal.edge_device import CanonicalPayload, Reading
from hal.signing import P256Signer
from network.client import AggregatorClient, SubmissionRejected


def load_or_create_signer(
    key_path: Path, force_new: bool = False
) -> tuple[P256Signer, bool]:
    """Load persistent key from PEM file, or create + save new one.

    Returns:
        (signer, is_new) — is_new=True if a fresh key was generated.
    """
    if key_path.exists() and not force_new:
        private_key = serialization.load_pem_private_key(
            key_path.read_bytes(), password=None
        )
        return P256Signer(private_key=private_key), False

    private_key = ec.generate_private_key(ec.SECP256R1())
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_path.write_bytes(pem)
    key_path.chmod(0o600)
    return P256Signer(private_key=private_key), True


def make_payload(session_id: int) -> CanonicalPayload:
    """Test payload: 100 readings ~5.5V × ~240mA (sensible energy)."""
    readings = tuple(
        Reading(
            voltage_mv=5500 + i,
            current_ma=240 + i,
            timestamp_ms=1_000 + i * 100,
        )
        for i in range(100)
    )
    return CanonicalPayload(
        device_id=42,
        session_id=session_id,
        epoch_start_ts=1_778_000_000,
        lat_e7=484_517_000,   # ~48.45° N (Sniatyn)
        lon_e7=255_752_000,   # ~25.57° E
        light_level=5000,
        tamper_flag=0,
        readings=readings,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Sepolia E2E smoke test")
    parser.add_argument("--url", default="http://localhost:3000")
    parser.add_argument(
        "--key-file",
        type=Path,
        default=Path("edge-test-key.pem"),
        help="persistent edge key file (default ./edge-test-key.pem)",
    )
    parser.add_argument(
        "--new-key",
        action="store_true",
        help="force regenerate key even if file exists",
    )
    parser.add_argument("--session-id", type=int, default=None)
    parser.add_argument("--poll-interval-s", type=float, default=5.0)
    parser.add_argument("--max-poll-s", type=float, default=300.0)
    args = parser.parse_args()

    session_id = args.session_id or int(time.time())

    # 1. Load or create edge keypair
    signer, is_new = load_or_create_signer(args.key_file, force_new=args.new_key)
    pubkey_hex = signer.public_key.hex()
    print("=== Edge device keypair ===")
    if is_new:
        print(f"  📝 Fresh key generated, saved to {args.key_file}")
        print(f"     This pubkey must be registered in DeviceRegistry.")
    else:
        print(f"  📁 Loaded persistent key from {args.key_file}")
    print(f"  Public key (X||Y, 64 bytes): 0x{pubkey_hex}")
    print()

    # 2. Payload
    payload = make_payload(session_id=session_id)
    total_energy = sum(r.voltage_mv * r.current_ma for r in payload.readings)
    print("=== Payload ===")
    print(f"  device_id:       {payload.device_id}")
    print(f"  session_id:      {payload.session_id}")
    print(f"  epoch_start_ts:  {payload.epoch_start_ts}")
    print(
        f"  location:        {payload.lat_e7 / 1e7:.4f}°N, "
        f"{payload.lon_e7 / 1e7:.4f}°E"
    )
    print(f"  readings:        {len(payload.readings)} samples")
    print(f"  ∑(V·I):          {total_energy} (mV·mA)")
    print()

    # 3. Submit + poll
    with AggregatorClient(args.url, signer, verify_ssl=False) as client:
        print(f"=== Submitting to {args.url} ===")
        try:
            response = client.submit(payload)
            print("  ✓ Accepted (HTTP 202)")
            print(f"  sessionKey: {response.session_key}")
        except SubmissionRejected as e:
            print(f"  ✗ Rejected: {e.code} (HTTP {e.http_status})")
            print(f"    {e.message}")
            return 1
        except Exception as e:
            print(f"  ✗ Transport error: {type(e).__name__}: {e}")
            return 2
        print()

        print(f"=== Polling status (every {args.poll_interval_s:.0f}s) ===")
        start = time.time()
        while time.time() - start < args.max_poll_s:
            elapsed = int(time.time() - start)
            try:
                status = client.get_status(response.session_key)
            except Exception as e:
                print(f"  [{elapsed:3d}s] poll failed: {e}")
                time.sleep(args.poll_interval_s)
                continue

            err_part = f" error={status.error}" if status.error else ""
            print(
                f"  [{elapsed:3d}s] status={status.status} "
                f"attempts={status.attempts}{err_part}"
            )

            if status.status == "complete":
                print()
                print("=== ✓ SUCCESS ===")
                print("  Submission completed on real Sepolia.")
                print("  V3 contract accepted the proof and emitted ProofSubmitted event.")
                print("  Etherscan:")
                print("    https://sepolia.etherscan.io/address/0xD1Cb30374a2D0D1B3fd9830eAAFf527D5FC13f5f")
                return 0

            if status.status == "failed":
                print()
                print("=== ✗ FAILED ===")
                print(f"  {status.error}")
                return 1

            if status.status == "quarantined":
                print()
                print("=== ⚠ QUARANTINED (no gas wasted) ===")
                print(f"  {status.error}")
                code = (status.error or {}).get("code", "")
                if code == "DeviceNotActive":
                    print()
                    print("  Pipeline validated — reached chain layer, contract")
                    print("  rejected at simulate step (free of gas).")
                    print()
                    print("  Register this device via cast (already executed earlier")
                    print("  for previous key — must re-register if you used --new-key):")
                    print()
                    print(f"  cast send 0x6249935e8f293cac2a7c4ce3717a14a8b1e83e03 \\")
                    print(f"    \"registerDevice(bytes,int32,int32)\" \\")
                    print(f"    0x{pubkey_hex} \\")
                    print(f"    484517000 484517000 \\")
                    print(f"    --private-key $OPERATOR_PRIVATE_KEY \\")
                    print(f"    --rpc-url $RPC_URL")
                    print()
                    print(f"  Then re-run: python scripts/sepolia_smoke.py")
                return 0  # quarantine is diagnostic, not failure

            time.sleep(args.poll_interval_s)

        print(f"  ✗ TIMEOUT after {args.max_poll_s:.0f}s")
        return 1


if __name__ == "__main__":
    sys.exit(main())
