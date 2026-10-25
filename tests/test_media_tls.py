"""Offline TLS trust selection; no credentials or network requests are used."""

import os
from pathlib import Path
import ssl
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.request import HTTPSHandler, Request

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from server.media import _NoRedirect, _default_transport, _tls_context


class MediaTLSTests(unittest.TestCase):
    def setUp(self):
        # The caller's custom roots must not influence these offline cases.
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def assert_verifies(self, context):
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_macos_prefers_local_system_trust(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        truststore = SimpleNamespace(SSLContext=Mock(return_value=context))
        with patch("server.media.sys.platform", "darwin"), \
                patch.dict(sys.modules, {"truststore": truststore}), \
                patch("server.media.ssl.create_default_context") as fallback:
            self.assertIs(_tls_context(), context)
        truststore.SSLContext.assert_called_once_with(ssl.PROTOCOL_TLS_CLIENT)
        fallback.assert_not_called()
        self.assert_verifies(context)

    def test_explicit_roots_take_precedence_over_macos_store(self):
        truststore = SimpleNamespace(SSLContext=Mock())
        with tempfile.TemporaryDirectory() as directory:
            cafile = Path(directory) / "custom.pem"
            cafile.touch()
            with patch.dict(os.environ, {"SSL_CERT_FILE": str(cafile), "SSL_CERT_DIR": directory}), \
                    patch("server.media.sys.platform", "darwin"), \
                    patch.dict(sys.modules, {"truststore": truststore}), \
                    patch("server.media.ssl.create_default_context") as factory:
                self.assertIs(_tls_context(), factory.return_value)
                factory.assert_called_once_with(cafile=str(cafile), capath=directory)
        truststore.SSLContext.assert_not_called()

    def test_invalid_explicit_paths_fail_without_fallback(self):
        for name in ("SSL_CERT_FILE", "SSL_CERT_DIR"):
            for value in ("", "/nonexistent-dream-studio-ca-location"):
                with self.subTest(name=name, value=value), \
                        patch.dict(os.environ, {name: value}), \
                        patch("server.media.ssl.create_default_context") as factory:
                    with self.assertRaises(ValueError):
                        _tls_context()
                    factory.assert_not_called()

    def test_invalid_explicit_certificate_fails_without_system_fallback(self):
        truststore = SimpleNamespace(SSLContext=Mock())
        with tempfile.TemporaryDirectory() as directory:
            cafile = Path(directory) / "invalid.pem"
            cafile.write_text("not a certificate", encoding="utf-8")
            with patch.dict(os.environ, {"SSL_CERT_FILE": str(cafile)}), \
                    patch("server.media.sys.platform", "darwin"), \
                    patch.dict(sys.modules, {"truststore": truststore}):
                with self.assertRaises(ssl.SSLError):
                    _tls_context()
        truststore.SSLContext.assert_not_called()

    def test_missing_truststore_uses_default_verified_context(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with patch("server.media.sys.platform", "darwin"), \
                patch.dict(sys.modules, {"truststore": None, "certifi": None}), \
                patch("server.media.ssl.create_default_context", return_value=context):
            self.assertIs(_tls_context(), context)
        self.assert_verifies(context)
        self.assertEqual(context.get_ca_certs(), [])

    def test_empty_default_store_can_load_certifi(self):
        context = Mock()
        context.get_ca_certs.return_value = []
        certifi = SimpleNamespace(where=Mock(return_value="/test/roots.pem"))
        with patch("server.media.sys.platform", "linux"), \
                patch.dict(sys.modules, {"certifi": certifi}), \
                patch("server.media.ssl.create_default_context", return_value=context):
            self.assertIs(_tls_context(), context)
        context.load_verify_locations.assert_called_once_with(cafile="/test/roots.pem")

    def test_populated_default_store_is_preserved(self):
        context = Mock()
        context.get_ca_certs.return_value = [{"subject": "existing root"}]
        certifi = SimpleNamespace(where=Mock())
        with patch("server.media.sys.platform", "linux"), \
                patch.dict(sys.modules, {"certifi": certifi}), \
                patch("server.media.ssl.create_default_context", return_value=context):
            self.assertIs(_tls_context(), context)
        certifi.where.assert_not_called()
        context.load_verify_locations.assert_not_called()

    def test_unusable_fallback_bundle_fails_closed(self):
        context = Mock()
        context.get_ca_certs.return_value = []
        context.load_verify_locations.side_effect = ssl.SSLError("invalid bundle")
        with patch("server.media.sys.platform", "linux"), \
                patch.dict(sys.modules, {"certifi": SimpleNamespace(where=lambda: "/invalid.pem")}), \
                patch("server.media.ssl.create_default_context", return_value=context):
            with self.assertRaises(ssl.SSLError):
                _tls_context()

    def test_transport_uses_verified_context_and_keeps_redirect_block(self):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        with patch("server.media._tls_context", return_value=context), \
                patch("server.media.build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{"code": 0}'
            self.assertEqual(_default_transport("https://www.runninghub.cn/", {}, {}, 1), {"code": 0})
        redirect, https = opener.call_args.args
        self.assertIsInstance(redirect, _NoRedirect)
        self.assertIsInstance(https, HTTPSHandler)
        self.assertIs(https._context, context)
        self.assert_verifies(context)
        self.assertIsNone(redirect.redirect_request(
            Request("https://www.runninghub.cn/"), None, 302, "Found", {}, "https://other.example/"))

    def test_context_failure_prevents_any_request(self):
        with patch("server.media._tls_context", side_effect=ssl.SSLError("invalid trust configuration")), \
                patch("server.media.build_opener") as opener:
            with self.assertRaises(ssl.SSLError):
                _default_transport("https://www.runninghub.cn/", {}, {}, 1)
        opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
