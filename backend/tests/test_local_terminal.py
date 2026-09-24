"""本地 PTY、鉴权、双向 WebSocket 和进程释放；仅使用隔离目录。"""
import asyncio
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from app.api import sessions, terminals
from app.services import local_pty_service as local
from app.services.session_manager import SessionManager
from test_file_content import asgi_request


def read_until(channel, needle, timeout=5):
    data = b""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        chunk = terminals._blocking_read(channel)
        if chunk is None:
            break
        data += chunk
        if needle in data:
            return data
        time.sleep(0.01)
    raise AssertionError(f"未收到 {needle!r}，输出为 {data!r}")


class ConfigurationTests(unittest.TestCase):
    def test_environment_does_not_expose_application_secrets(self):
        with patch.dict(os.environ, {"SHELL_HELPER_TOKEN": "test-only", "SHELL_HELPER_MASTER_KEY": "test-only",
                                     "ELECTRON_RUN_AS_NODE": "1", "NODE_OPTIONS": "test-only"}):
            env = local.terminal_environment()
        self.assertFalse(any(key.startswith(("SHELL_HELPER_", "ELECTRON_")) for key in env))
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertEqual(env["TERM"], "xterm-256color")

    def test_invalid_directory_never_spawns(self):
        with patch.object(local.subprocess, "Popen") as spawn:
            for value in ["relative", "/not-a-shell-helper-directory", "bad\x00path"]:
                with self.assertRaises(ValueError):
                    local.connect(value)
            spawn.assert_not_called()

    def test_invalid_resize_messages_are_ignored(self):
        channel = Mock()
        for text in ['null', '[]', 'false', 'invalid', '{"type":"resize","cols":null}',
                     '{"type":"resize","cols":-1}', '{"type":"resize","rows":999999}',
                     '{"type":"resize","rows":"oops"}', '{"type":"resize","cols":true}']:
            terminals._handle_control(channel, text)
        channel.resize_pty.assert_not_called()
        terminals._handle_control(channel, '{"type":"resize","cols":120,"rows":32}')
        channel.resize_pty.assert_called_once_with(width=120, height=32)

    def test_windows_adapter_binary_frames_unicode_resize_and_close(self):
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        process = Mock(fileobj=reader)
        factory = Mock()
        factory.spawn.return_value = process
        with patch.dict(sys.modules, {"winpty": SimpleNamespace(PtyProcess=factory)}):
            channel = local.WindowsChannel("C:\\Users\\test", ["powershell.exe", "-NoLogo"], {"TERM": "xterm-256color"})
        writer.sendall("中文".encode())
        self.assertTrue(channel.recv_ready())
        self.assertEqual(channel.recv(), "中文".encode())
        encoded = "中文".encode()
        channel.sendall(encoded[:2])
        process.write.assert_not_called()
        channel.sendall(encoded[2:])
        process.write.assert_called_once_with("中文")
        channel.resize_pty(110, 36)
        process.setwinsize.assert_called_once_with(36, 110)
        writer.shutdown(socket.SHUT_WR)
        self.assertEqual(channel.recv(), b"")
        self.assertTrue(channel.eof_received)
        channel.close()
        channel.close()
        process.close.assert_called_once_with(force=True)

    def test_windows_blocked_write_does_not_block_output_or_close(self):
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        entered, release, drained = threading.Event(), threading.Event(), threading.Event()
        process = Mock(fileobj=reader)
        process.write.side_effect = lambda _text: (entered.set(), release.wait(3))
        factory = Mock()
        factory.spawn.return_value = process
        with patch.dict(sys.modules, {"winpty": SimpleNamespace(PtyProcess=factory)}):
            channel = local.WindowsChannel("C:\\Users\\test", ["cmd.exe"], {})
        self.addCleanup(channel.close)
        output = []

        def read_and_close():
            if channel.recv_ready():
                output.append(channel.recv())
            channel.close()
            drained.set()

        sending = threading.Thread(target=channel.sendall, args=(b"input",))
        receiving = threading.Thread(target=read_and_close)
        sending.start()
        try:
            self.assertTrue(entered.wait(1))
            writer.sendall(b"output")
            receiving.start()
            self.assertTrue(drained.wait(1), "阻塞写入不应持有读取或关闭锁")
            self.assertEqual(output, [b"output"])
            process.close.assert_called_once_with(force=True)
        finally:
            release.set()
            sending.join(3)
            if receiving.ident is not None:
                receiving.join(3)


@unittest.skipUnless(os.name == "posix", "需要 POSIX 伪终端")
class PosixTerminalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="shell-helper-pty-")
        self.addCleanup(self.directory.cleanup)
        self.root = str(Path(self.directory.name).resolve())
        self.env = patch.dict(os.environ, {"HOME": self.root, "SHELL": "/bin/sh", "PS1": "PTY_TEST> "})
        self.env.start()
        self.addCleanup(self.env.stop)

    def channel(self):
        channel = local.connect(self.root)
        self.addCleanup(channel.close)
        channel.sendall(b"stty -echo; printf '\\nREADY\\n'\r")
        read_until(channel, b"\r\nREADY\r\n")
        return channel

    def test_real_tty_directory_unicode_and_resize(self):
        channel = self.channel()
        self.assertEqual(os.getsid(channel.process.pid), channel.process.pid)
        channel.sendall("test -t 0 && test -t 1 && printf '\\n真实TTY-中文\\n'; pwd\r".encode())
        output = read_until(channel, (self.root + "\r\n").encode())
        self.assertIn("真实TTY-中文".encode(), output)
        channel.resize_pty(101, 33)
        channel.sendall(b"stty size\r")
        read_until(channel, b"33 101\r\n")

    def test_ctrl_c_interrupts_foreground_and_shell_stays_alive(self):
        channel = self.channel()
        channel.sendall(b"sleep 30\r")
        time.sleep(0.2)
        channel.sendall(b"\x03")
        channel.sendall(b"printf '\\nINTERRUPTED\\n'\r")
        read_until(channel, b"\r\nINTERRUPTED\r\n", timeout=3)
        self.assertIsNone(channel.process.poll())

    def test_exit_drains_output_and_close_reaps_process(self):
        channel = self.channel()
        channel.sendall(b"printf '\\nFINAL_OUTPUT\\n'; exit\r")
        read_until(channel, b"\r\nFINAL_OUTPUT\r\n")
        end = time.monotonic() + 3
        while terminals._blocking_read(channel) is not None and time.monotonic() < end:
            time.sleep(.01)
        self.assertTrue(channel.eof_received)
        channel.close()
        self.assertIsNotNone(channel.process.returncode)

    def test_close_terminates_foreground_but_not_other_terminals(self):
        first, second = self.channel(), self.channel()
        first.sendall(b"sh -c 'printf \"\\nCHILD=%s\\n\" \"$$\"; exec sleep 30'\r")
        data = read_until(first, b"CHILD=")
        match = re.search(rb"CHILD=(\d+)\r\n", data)
        if not match:
            data += read_until(first, b"\r\n")
            match = re.search(rb"CHILD=(\d+)\r\n", data)
        self.assertIsNotNone(match)
        child_pid = int(match[1])
        first.close()
        self.assertIsNotNone(first.process.returncode)
        end = time.monotonic() + 3
        while time.monotonic() < end:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(.02)
        else:
            self.fail("前台进程未退出")
        second.sendall(b"printf '\\nSECOND_ALIVE\\n'\r")
        read_until(second, b"\r\nSECOND_ALIVE\r\n")

    def test_saved_local_connection_does_not_read_credentials(self):
        manager = SessionManager()
        self.addCleanup(manager.close_all)
        host = SimpleNamespace(protocol="local", remote_cwd=self.root)
        with patch("app.core.db.session_scope"), patch("app.repositories.host_repo.get_host", return_value=host), patch("app.repositories.host_repo.resolve_password") as password:
            session = manager.create("saved-local", "terminal")
            password.assert_not_called()
        self.assertEqual(session.transport, "local")
        self.assertEqual(session.remote_cwd, self.root)
        with self.assertRaises(KeyError):
            manager.get_provider(session.session_id)
        manager.close_all()
        self.assertTrue(session.channel.closed)
        self.assertIsNotNone(session.channel.process.returncode)


@unittest.skipUnless(os.name == "posix", "需要 POSIX 伪终端")
class LocalApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="shell-helper-local-api-")
        self.manager = SessionManager()
        self.app = FastAPI()
        self.app.include_router(sessions.router)
        self.app.include_router(terminals.router)
        self.patches = [patch.dict(os.environ, {"HOME": self.directory.name, "SHELL": "/bin/sh"}),
                        patch("app.api.sessions.get_session_manager", return_value=self.manager),
                        patch("app.api.terminals.get_session_manager", return_value=self.manager),
                        patch("app.core.security._expected", return_value="local-test-token")]
        for p in self.patches:
            p.start()
        self.auth = {"Authorization": "Bearer local-test-token"}
        self.tasks = []

    async def asyncTearDown(self):
        for task, incoming in self.tasks:
            await incoming.put({"type": "websocket.disconnect", "code": 1000})
            await asyncio.wait_for(task, 3)
        await asyncio.to_thread(self.manager.close_all)
        for p in reversed(self.patches):
            p.stop()
        self.directory.cleanup()

    async def open_session(self):
        status, _, body = await asgi_request(self.app, "POST", "/api/sessions/local", headers=self.auth)
        self.assertEqual(status, 201, body)
        return json.loads(body)["session_id"]

    async def websocket(self, sid, token="local-test-token"):
        incoming, outgoing = asyncio.Queue(), asyncio.Queue()
        route = f"/api/terminals/{sid}/ws"
        scope = {"type": "websocket", "asgi": {"version": "3.0"}, "scheme": "ws", "path": route,
                 "raw_path": route.encode(), "query_string": f"token={token}".encode(), "headers": [],
                 "client": ("127.0.0.1", 1), "server": ("127.0.0.1", 2), "subprotocols": []}
        await incoming.put({"type": "websocket.connect"})
        task = asyncio.create_task(self.app(scope, incoming.get, outgoing.put))
        self.tasks.append((task, incoming))
        return task, incoming, outgoing, await asyncio.wait_for(outgoing.get(), 3)

    async def test_authentication_and_duplicate_attach(self):
        with patch.object(self.manager, "create_local") as create:
            status, _, _ = await asgi_request(self.app, "POST", "/api/sessions/local")
            self.assertEqual(status, 401)
            create.assert_not_called()
        sid = await self.open_session()
        _, _, _, denied = await self.websocket(sid, "wrong")
        self.assertEqual(denied["code"], 4401)
        self.assertFalse(self.manager.get(sid).terminal_attached)
        _, _, _, accepted = await self.websocket(sid)
        self.assertEqual(accepted["type"], "websocket.accept")
        _, _, _, duplicate = await self.websocket(sid)
        self.assertEqual(duplicate["code"], 4409)

    async def test_output_eof_closes_websocket_and_releases_session(self):
        sid = await self.open_session()
        channel = self.manager.get(sid).channel
        task, incoming, outgoing, accepted = await self.websocket(sid)
        self.assertEqual(accepted["type"], "websocket.accept")
        await incoming.put({"type": "websocket.receive", "bytes": b"printf '\\nWS_DONE\\n'; exit\r"})
        output = b""
        while True:
            message = await asyncio.wait_for(outgoing.get(), 4)
            if message["type"] == "websocket.close":
                self.assertEqual(message["code"], 1000)
                break
            output += message.get("bytes", b"")
        await task
        self.assertIn(b"\r\nWS_DONE\r\n", output)
        self.assertIsNone(self.manager.get(sid))
        self.assertTrue(channel.closed)
        self.assertIsNotNone(channel.process.returncode)

    async def test_client_disconnect_releases_running_shell(self):
        sid = await self.open_session()
        channel = self.manager.get(sid).channel
        task, incoming, _, _ = await self.websocket(sid)
        await incoming.put({"type": "websocket.disconnect", "code": 1000})
        await asyncio.wait_for(task, 3)
        self.assertIsNone(self.manager.get(sid))
        self.assertIsNotNone(channel.process.returncode)


if __name__ == "__main__":
    unittest.main()
