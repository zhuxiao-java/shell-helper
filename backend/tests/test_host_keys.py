"""主机密钥确认：未知密钥要带指纹，错误材料不能保存。"""
import sys
import unittest
from pathlib import Path

import paramiko

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.host_keys import HostKeyChanged, RejectUnknown, UnknownHostKey, describe_public_key, fingerprint_of


class HostKeyTests(unittest.TestCase):
    def test_unknown_key_exposes_fingerprint(self):
        key = paramiko.RSAKey.generate(1024)
        with self.assertRaises(UnknownHostKey) as caught:
            RejectUnknown("example.com", 2222).missing_host_key(None, "[example.com]:2222", key)
        error = caught.exception
        self.assertEqual(error.host, "example.com")
        self.assertEqual(error.port, 2222)
        self.assertEqual(error.fingerprint, fingerprint_of(key))
        self.assertEqual(error.payload()["code"], "unknown_host_key")
        self.assertEqual(describe_public_key(error.key_type, error.public_key), error.fingerprint)

    def test_changed_key_uses_the_key_just_presented(self):
        key = paramiko.RSAKey.generate(1024)
        exc = paramiko.BadHostKeyException("10.0.0.8", key, paramiko.RSAKey.generate(1024))
        changed = HostKeyChanged.from_paramiko(exc, 22)
        self.assertEqual(changed.payload()["code"], "host_key_changed")
        self.assertEqual(changed.fingerprint, fingerprint_of(key))

    def test_rejects_invalid_material(self):
        with self.assertRaises(ValueError):
            describe_public_key("ssh-rsa", "not-a-key")
