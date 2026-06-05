import cryptoauthlib as cal

# secp256r1 curve order n (low-s normalization; Noir verify rejects high-s)
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


class ATECCSigner:
    """Hardware P-256 signer (ATECC608B slot 0). Drop-in for P256Signer:
    .public_key (64B X||Y) and .sign(hash)->64B r||s (low-s)."""

    def __init__(self, slot=0, bus=1):
        self._slot = slot
        cfg = cal.cfg_ateccx08a_i2c_default()
        cfg.cfg.atcai2c.bus = bus
        assert cal.atcab_init(cfg) == 0, "atcab_init failed"
        pub = bytearray(64)
        assert cal.atcab_get_pubkey(slot, pub) == 0, "get_pubkey failed"
        self.public_key = bytes(pub)

    def sign(self, message_hash):
        assert len(message_hash) == 32, "need 32-byte hash"
        sig = bytearray(64)
        assert cal.atcab_sign(self._slot, message_hash, sig) == 0, "sign failed"
        r = int.from_bytes(sig[:32], "big")
        s = int.from_bytes(sig[32:], "big")
        if s > N // 2:
            s = N - s
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")
