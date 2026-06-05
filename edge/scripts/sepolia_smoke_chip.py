"""Sepolia end-to-end with ATECC608B hardware signer (chip on slot 0).

Same pipeline as scripts/sepolia_smoke.py, but the signature comes from the
secure element instead of a PEM key. The payload is byte-identical to the
software smoke test, so the ONLY new variable is the hardware signature.

Run on the Raspberry Pi (chip on I2C bus 1), from edge/ with the venv:

    python scripts/sepolia_smoke_chip.py

Aggregator must be running on WSL and reachable (portproxy on Windows).
Default --url targets the Windows LAN IP that forwards to the WSL aggregator.
"""

import argparse
import sys
import time

from hal.edge_device import CanonicalPayload, Reading
from hal.signing_atecc import ATECCSigner
from network.client import AggregatorClient, SubmissionRejected


def make_payload(session_id: int, epoch_start_ts: int) -> CanonicalPayload:
    """Identical to sepolia_smoke.make_payload — proven to pass the circuit."""
    readings = tuple(
        Reading(voltage_mv=5500 + i, current_ma=240 + i, timestamp_ms=1000 + i * 100)
        for i in range(100)
    )
    return CanonicalPayload(
        device_id=43,
        session_id=session_id,
        epoch_start_ts=epoch_start_ts,
        lat_e7=484_438_370,
        lon_e7=255_607_898,
        light_level=5000,
        tamper_flag=0,
        readings=readings,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Sepolia E2E with ATECC608B signer")
    ap.add_argument("--url", default="http://192.168.1.102:3000")
    ap.add_argument("--poll-interval-s", type=float, default=5.0)
    ap.add_argument("--max-poll-s", type=float, default=300.0)
    args = ap.parse_args()

    session_id = int(time.time())
    epoch_start_ts = int(time.time())

    signer = ATECCSigner()
    print("=== Hardware signer (ATECC608B slot 0) ===")
    print(f"  pubkey: 0x{signer.public_key.hex()}")

    payload = make_payload(session_id, epoch_start_ts)
    print("=== Payload ===")
    print(
        f"  device_id={payload.device_id} session_id={session_id} "
        f"epoch_start_ts={epoch_start_ts}"
    )
    print(
        f"  location {payload.lat_e7 / 1e7:.4f}N {payload.lon_e7 / 1e7:.4f}E, "
        f"{len(payload.readings)} readings"
    )

    with AggregatorClient(args.url, signer, verify_ssl=False) as client:
        print(f"=== Submitting to {args.url} ===")
        try:
            resp = client.submit(payload)
            print(f"  accepted (HTTP 202), sessionKey={resp.session_key}")
        except SubmissionRejected as e:
            print(f"  REJECTED: {e.code} (HTTP {e.http_status}) {e.message}")
            return 1
        except Exception as e:
            print(f"  TRANSPORT ERROR: {type(e).__name__}: {e}")
            return 2

        print(f"=== Polling (every {args.poll_interval_s:.0f}s) ===")
        start = time.time()
        while time.time() - start < args.max_poll_s:
            elapsed = int(time.time() - start)
            try:
                st = client.get_status(resp.session_key)
            except Exception as e:
                print(f"  [{elapsed:3d}s] poll failed: {e}")
                time.sleep(args.poll_interval_s)
                continue
            err = f" error={st.error}" if st.error else ""
            print(f"  [{elapsed:3d}s] status={st.status} attempts={st.attempts}{err}")
            if st.status == "complete":
                print()
                print("=== SUCCESS — hardware-signed ProofSubmitted on Sepolia ===")
                print("  https://sepolia.etherscan.io/address/"
                      "0xD1Cb30374a2D0D1B3fd9830eAAFf527D5FC13f5f")
                return 0
            if st.status == "failed":
                print(f"=== FAILED: {st.error} ===")
                return 1
            if st.status == "quarantined":
                print(f"=== QUARANTINED: {st.error} ===")
                return 1
            time.sleep(args.poll_interval_s)
        print("=== TIMEOUT ===")
        return 1


if __name__ == "__main__":
    sys.exit(main())
