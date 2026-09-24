"""完全隔离的文件 Provider、协议与 ASGI API 回归测试。"""
import asyncio
import io
import json
import posixpath
import stat
import sys
import threading
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlencode
from ftplib import error_perm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from app.api import files, sessions
from app.services.file_provider import SftpProvider, ContentError, MAX_CONTENT_BYTES, digest, validate_text
from app.services.ftp_service import FtpProvider
from app.services.session_manager import SessionManager, Session, validate_capability


class FakeSftp:
    def __init__(self):
        self.files = {"/文本 file.txt": b"original\r\n"}
        self.modes = {"/文本 file.txt": stat.S_IFREG | 0o640}
        self.deleted = []
        self.closed = False
        self.rename_supported = True
        self.before_replace = None

    def get_channel(self):
        return SimpleNamespace(settimeout=lambda _: None)

    def lstat(self, path):
        if path not in self.files:
            raise FileNotFoundError(path)
        return SimpleNamespace(st_mode=self.modes.get(path, stat.S_IFREG | 0o600), st_size=len(self.files[path]))

    def open(self, path, mode):
        if "w" in mode:
            if path in self.files and "x" in mode:
                raise FileExistsError(path)
            owner = self

            class Writer(io.BytesIO):
                def close(self):
                    if not self.closed:
                        owner.files[path] = self.getvalue()
                    super().close()
            return Writer()
        return io.BytesIO(self.files[path])

    def chmod(self, path, mode):
        self.modes[path] = stat.S_IFREG | mode

    def posix_rename(self, old, new):
        if not self.rename_supported:
            raise OSError("不支持扩展")
        self.files[new] = self.files.pop(old)
        self.modes[new] = self.modes.pop(old)

    def remove(self, path):
        self.deleted.append(path)
        if path not in self.files:
            raise FileNotFoundError(path)
        del self.files[path]

    def close(self):
        self.closed = True


class FakeFtp:
    def __init__(self):
        self.files = {"/文本 file.txt": b"original\r\n"}
        self.closed = False
        self.reported_size = None
        self.ftype = "file"
        self.deleted = []
        self.refuse_rename = False

    def mlsd(self, path, facts):
        return [(posixpath.basename(p), {"type": self.ftype, "size": str(self.reported_size if self.reported_size is not None else len(data))}) for p, data in self.files.items()]

    def retrbinary(self, command, callback, blocksize):
        data = self.files[command[5:]]
        for offset in range(0, len(data), blocksize):
            callback(data[offset:offset + blocksize])

    def storbinary(self, command, source, blocksize, callback):
        data = source.read()
        self.files[command[5:]] = data
        callback(data)

    def rename(self, old, new):
        if self.refuse_rename:
            raise error_perm("550 不支持覆盖")
        self.files[new] = self.files.pop(old)

    def delete(self, path):
        self.deleted.append(path)
        self.files.pop(path, None)

    def quit(self):
        self.closed = True

    close = quit


class StorageHandshakeTests(unittest.TestCase):
    def test_actual_sqlite_path_outside_data_directory(self):
        from sqlalchemy import create_engine
        from app.main import _print_handshake

        with tempfile.TemporaryDirectory(prefix='shell-helper-handshake-') as directory:
            root = Path(directory)
            database = root / '独立 数据库.db'
            engine = create_engine(f'sqlite:///{database}')
            try:
                settings = SimpleNamespace(data_dir=root / '后端数据', token='test-only', host='127.0.0.1')
                output = io.StringIO()
                with patch('app.main.get_settings', return_value=settings), patch('app.main.get_engine', return_value=engine), patch('sys.stdout', output):
                    _print_handshake(1234)
                payload = json.loads(output.getvalue().removeprefix('HANDSHAKE '))
                self.assertEqual(payload['database_path'], str(database.resolve()))
                self.assertEqual(payload['data_dir'], str(settings.data_dir.resolve()))
                self.assertEqual(payload['port'], 1234)
                self.assertNotIn('db_url', payload)
            finally:
                engine.dispose()

    def test_memory_database_has_no_local_file(self):
        from sqlalchemy import create_engine
        from app.main import _print_handshake

        engine = create_engine('sqlite:///:memory:')
        try:
            output = io.StringIO()
            settings = SimpleNamespace(data_dir=Path('.'), token='test-only', host='127.0.0.1')
            with patch('app.main.get_settings', return_value=settings), patch('app.main.get_engine', return_value=engine), patch('sys.stdout', output):
                _print_handshake(1234)
            self.assertIsNone(json.loads(output.getvalue().removeprefix('HANDSHAKE '))['database_path'])
        finally:
            engine.dispose()


class ProviderTests(unittest.TestCase):
    path = "/文本 file.txt"

    def test_text_detection_and_encodings(self):
        for data in [b"", b"abc\r\n", "中文".encode("utf-8"), "中文".encode("utf-16"), "中文".encode("utf-32"), "中文".encode("gbk")]:
            validate_text(data)
        for data in [b"\x7fELFhello", b"MZsomething", b"abc\x00", b"\x1b[0m", b"x" * (MAX_CONTENT_BYTES + 1)]:
            with self.assertRaises(ContentError):
                validate_text(data)

    def test_sftp_write_preserves_mode_and_bytes(self):
        remote = FakeSftp()
        provider = SftpProvider(remote)
        original = provider.read_content(self.path)
        data = "新文本\r\n".encode("utf-16")
        self.assertEqual(provider.write_content(self.path, data, digest(original)), digest(data))
        self.assertEqual(remote.files[self.path], data)
        self.assertEqual(stat.S_IMODE(remote.modes[self.path]), 0o640)
        self.assertNotIn(self.path, remote.deleted)
        self.assertEqual(len(remote.files), 1)

    def test_conflict_and_deleted_remote(self):
        for factory, provider_type in [(FakeSftp, SftpProvider), (FakeFtp, FtpProvider)]:
            remote = factory()
            provider = provider_type(remote)
            expected = digest(provider.read_content(self.path))
            remote.files[self.path] = b"other editor"
            with self.assertRaises(ContentError) as error:
                provider.write_content(self.path, b"local", expected)
            self.assertEqual(error.exception.status, 409)
            self.assertEqual(remote.files[self.path], b"other editor")
            del remote.files[self.path]
            with self.assertRaises(ContentError) as error:
                provider.write_content(self.path, b"local", expected)
            self.assertEqual(error.exception.status, 409)

    def test_second_digest_check_after_staging(self):
        remote = FakeSftp()
        provider = SftpProvider(remote)
        original_chmod = remote.chmod
        def chmod(path, mode):
            original_chmod(path, mode)
            remote.files[self.path] = b"concurrent edit"
        remote.chmod = chmod
        with self.assertRaises(ContentError):
            provider.write_content(self.path, b"local", digest(b"original\r\n"))
        self.assertEqual(remote.files[self.path], b"concurrent edit")
        self.assertEqual(len(remote.files), 1)

    def test_safe_replace_no_delete_fallback(self):
        for remote, provider_type in [(FakeSftp(), SftpProvider), (FakeFtp(), FtpProvider)]:
            remote.rename_supported = False
            remote.refuse_rename = True
            provider = provider_type(remote)
            with self.assertRaises(ContentError):
                provider.write_content(self.path, b"local", digest(b"original\r\n"))
            self.assertEqual(remote.files[self.path], b"original\r\n")
            self.assertNotIn(self.path, remote.deleted)

    def test_ftp_stream_limit_closes_control_connection(self):
        remote = FakeFtp()
        remote.files[self.path] = b"x" * (MAX_CONTENT_BYTES + 1)
        remote.reported_size = 1
        provider = FtpProvider(remote)
        with self.assertRaises(ContentError) as error:
            provider.read_content(self.path)
        self.assertEqual(error.exception.status, 413)
        self.assertTrue(remote.closed)
        with self.assertRaises(ContentError) as error:
            provider.list("/")
        self.assertEqual(error.exception.status, 410)

    def test_symlinks_directories_and_path_injection(self):
        remote = FakeSftp()
        provider = SftpProvider(remote)
        for mode in [stat.S_IFLNK, stat.S_IFDIR]:
            remote.modes[self.path] = mode | 0o777
            with self.assertRaises(ContentError):
                provider.read_content(self.path)
        ftp = FakeFtp()
        ftp.ftype = "OS.unix=slink"
        with self.assertRaises(ContentError):
            FtpProvider(ftp).read_content(self.path)
        with self.assertRaises(ContentError):
            FtpProvider(FakeFtp()).read_content("/abc\r\nDELE file")

    def test_close_waits_for_active_operation(self):
        remote = FakeSftp()
        provider = SftpProvider(remote)
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        original = remote.open
        def blocking_open(path, mode):
            entered.set()
            release.wait(2)
            self.assertFalse(remote.closed)
            return original(path, mode)
        remote.open = blocking_open
        reader = threading.Thread(target=lambda: provider.read_content(self.path))
        reader.start()
        self.assertTrue(entered.wait(1))
        closer = threading.Thread(target=lambda: (provider.close(), closed.set()))
        closer.start()
        self.assertFalse(closed.wait(.05))
        release.set()
        reader.join(2)
        closer.join(2)
        self.assertTrue(closed.is_set())

    def test_protocol_matrix(self):
        expected = {"ssh": {"terminal", "sftp"}, "sftp": {"sftp"}, "ftp": {"ftp"}, "telnet": {"terminal"}, "local": {"terminal"}}
        for protocol, allowed in expected.items():
            for stype in ["terminal", "sftp", "ftp"]:
                if stype in allowed:
                    validate_capability(protocol, stype)
                else:
                    with self.assertRaises(ValueError):
                        validate_capability(protocol, stype)

    def test_illegal_protocol_rejected_before_credentials_or_network(self):
        manager = SessionManager()
        with patch('app.core.db.session_scope') as scope, patch('app.repositories.host_repo.get_host', return_value=SimpleNamespace(protocol='sftp')), patch('app.repositories.host_repo.resolve_password') as password, patch.object(manager, '_create_terminal') as connect:
            with self.assertRaises(ValueError):
                manager.create('isolated-host', 'terminal')
            password.assert_not_called()
            connect.assert_not_called()


async def asgi_request(app, method, route, query=None, data=b"", headers=None):
    messages = []
    sent = False
    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": data, "more_body": False}
    async def send(message):
        messages.append(message)
    await app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
               "scheme": "http", "path": route, "raw_path": route.encode(), "query_string": urlencode(query or {}).encode(),
               "root_path": "", "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
               "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 2)}, receive, send)
    start = next(m for m in messages if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return start["status"], dict(start["headers"]), body


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(files.router)
        self.app.include_router(sessions.router)
        self.remote = FakeSftp()
        self.provider = SftpProvider(self.remote)
        self.manager = SessionManager()
        self.manager._sessions['test'] = Session('test', 'isolated-host', 'sftp', 'ssh', 'sftp', provider=self.provider)
        self.patches = [patch('app.api.files.get_session_manager', return_value=self.manager),
                        patch('app.api.sessions.get_session_manager', return_value=self.manager),
                        patch('app.core.security._expected', return_value='test-only-token')]
        for p in self.patches:
            p.start()
        self.auth = {"Authorization": "Bearer test-only-token"}
        self.query = {"session_id": "test", "path": "/文本 file.txt"}

    async def asyncTearDown(self):
        for p in self.patches:
            p.stop()

    async def test_auth_read_and_confirmed_write(self):
        status, _, _ = await asgi_request(self.app, 'GET', '/api/files/content', self.query)
        self.assertEqual(status, 401)
        status, headers, data = await asgi_request(self.app, 'GET', '/api/files/content', self.query, headers=self.auth)
        self.assertEqual(status, 200)
        self.assertEqual(data, b"original\r\n")
        status, _, _ = await asgi_request(self.app, 'PUT', '/api/files/content', self.query, b"new", {**self.auth, 'X-Expected-SHA256': headers[b'x-content-sha256'].decode()})
        self.assertEqual(status, 200)
        self.assertEqual(self.remote.files[self.query['path']], b"new")

    async def test_limit_conflict_missing_and_invalid_session(self):
        headers = {**self.auth, 'X-Expected-SHA256': digest(b"original\r\n")}
        for data, status in [(b'x' * (MAX_CONTENT_BYTES + 1), 413), (b'a\x00', 415)]:
            result = await asgi_request(self.app, 'PUT', '/api/files/content', self.query, data, headers)
            self.assertEqual(result[0], status)
        self.remote.files[self.query['path']] = b"changed"
        self.assertEqual((await asgi_request(self.app, 'PUT', '/api/files/content', self.query, b'local', headers))[0], 409)
        self.assertEqual((await asgi_request(self.app, 'GET', '/api/files/content', {**self.query, 'path': '/missing'}, headers=self.auth))[0], 404)
        self.assertEqual((await asgi_request(self.app, 'GET', '/api/files/content', {**self.query, 'session_id': 'missing'}, headers=self.auth))[0], 410)

    async def test_protocol_api_returns_400(self):
        with patch.object(self.manager, 'create', side_effect=ValueError('SFTP 不支持终端')):
            result = await asgi_request(self.app, 'POST', '/api/sessions', data=json.dumps({'host_id': 'isolated-host', 'type': 'terminal'}).encode(), headers={**self.auth, 'Content-Type': 'application/json'})
            self.assertEqual(result[0], 400)


if __name__ == '__main__':
    unittest.main()
