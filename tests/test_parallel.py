"""Parallel session tests: profiles, ownership of tokens, run, maps, wrapper. Fake HOME, no network.

Run: python3 -m unittest discover -s tests -v
"""
import contextlib
import io
import json
import os
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load(name, file, env=None):
    os.environ.pop("CLAUDE_CONFIG_DIR", None)
    os.environ.update(env or {})
    loader = SourceFileLoader(f"{name}_{os.urandom(4).hex()}", str(REPO / "bin" / file))
    mod = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(mod)
    return mod


class ParallelTest(unittest.TestCase):
    ACCOUNTS = ["a@x.com", "b@x.com"]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        os.environ["HOME"] = str(self.home)
        os.environ.pop("CLAUDE_ACCT_PROFILES", None)
        self.main = self.home / ".claude"
        (self.main / "accounts").mkdir(parents=True)
        (self.main / "skills").mkdir()
        (self.main / "settings.json").write_text(json.dumps({"permissions": {"defaultMode": "bypassPermissions"}}))
        (self.home / ".claude.json").write_text(json.dumps({
            "oauthAccount": {"accountUuid": "u0"}, "mcpServers": {"m": {"command": "x"}},
            "projects": {"/p": {"hasTrustDialogAccepted": True}}}))
        for i, n in enumerate(self.ACCOUNTS):
            (self.main / "accounts" / f"{n}.json").write_text(json.dumps({
                "claudeAiOauth": {"accessToken": f"at{i}", "refreshToken": f"rt{i}", "expiresAt": 9e15},
                "oauthAccount": {"accountUuid": f"u{i}", "emailAddress": n}}))
        (self.main / ".credentials.json").write_text(json.dumps(
            {"claudeAiOauth": {"accessToken": "at0", "refreshToken": "rt0", "expiresAt": 9e15}}))
        self.pids = {}  # account -> list of pids "using" its profile
        self.acct = self.fresh_acct()

    def tearDown(self):
        os.environ.pop("CLAUDE_CONFIG_DIR", None)
        self.tmp.cleanup()

    def fresh_acct(self, env=None):
        acct = load("acct", "claude-acct", env)
        real_status_module = acct.status_module

        def status_module():
            mod = real_status_module()
            mod.profile_pids = lambda name: self.pids.get(name, [])
            return mod
        acct.status_module = status_module
        acct.token_account = lambda oauth: {"accountUuid": "u" + oauth["accessToken"][-1]}
        return acct

    def status(self):
        return self.acct.status_module()

    # -- profiles --------------------------------------------------------------
    def test_claim_builds_profile_with_shared_links_and_own_login(self):
        d = self.status().claim("b@x.com")
        self.assertEqual(d, self.home / ".claude-profiles" / "b@x.com")
        self.assertTrue((d / "skills").is_symlink())
        self.assertEqual((d / "settings.json").resolve(), (self.main / "settings.json").resolve())
        self.assertEqual(json.loads((d / ".credentials.json").read_text())["claudeAiOauth"]["refreshToken"], "rt1")
        g = json.loads((d / ".claude.json").read_text())
        self.assertEqual(g["oauthAccount"]["emailAddress"], "b@x.com")
        self.assertIn("m", g["mcpServers"])
        self.assertIn("/p", g["projects"])
        self.assertFalse((d / ".credentials.json").is_symlink())
        self.assertFalse((d / "accounts").exists())  # saved logins are never exposed to a session

    def test_session_states(self):
        s = self.status()
        self.assertEqual(s.session_state("b@x.com"), "none")
        s.claim("b@x.com")
        self.assertEqual(s.session_state("b@x.com"), "idle")
        self.pids["b@x.com"] = [123]
        self.assertEqual(s.session_state("b@x.com"), "running")

    def test_release_returns_newest_tokens(self):
        s = self.status()
        d = s.claim("b@x.com")
        (d / ".credentials.json").write_text(json.dumps(
            {"claudeAiOauth": {"accessToken": "new", "refreshToken": "rt1-rotated", "expiresAt": 9e15}}))
        s.release("b@x.com")
        saved = json.loads((self.main / "accounts" / "b@x.com.json").read_text())
        self.assertEqual(saved["claudeAiOauth"]["refreshToken"], "rt1-rotated")
        self.assertFalse((d / ".credentials.json").exists())
        self.assertTrue(list((self.main / "accounts" / ".backup").glob("b@x.com.*.json")))

    def test_use_refuses_running_session(self):
        self.status().claim("b@x.com")
        self.pids["b@x.com"] = [123]
        with self.assertRaises(SystemExit) as e, contextlib.redirect_stdout(io.StringIO()):
            self.acct.use("b@x.com")
        self.assertIn("parallel session", str(e.exception.code))
        live = json.loads((self.main / ".credentials.json").read_text())["claudeAiOauth"]
        self.assertEqual(live["refreshToken"], "rt0")  # main login untouched

    def test_use_takes_back_idle_session_tokens(self):
        d = self.status().claim("b@x.com")
        (d / ".credentials.json").write_text(json.dumps(
            {"claudeAiOauth": {"accessToken": "at1", "refreshToken": "rt1-rotated", "expiresAt": 9e15}}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.use("b@x.com")
        live = json.loads((self.main / ".credentials.json").read_text())["claudeAiOauth"]
        self.assertEqual(live["refreshToken"], "rt1-rotated")
        self.assertFalse((d / ".credentials.json").exists())

    def test_status_reads_running_session_without_refresh(self):
        s = self.status()
        d = s.claim("b@x.com")
        (d / ".credentials.json").write_text(json.dumps(
            {"claudeAiOauth": {"accessToken": "session-token", "refreshToken": "rt1", "expiresAt": 0}}))
        self.pids["b@x.com"] = [1]
        used = []
        s.http_json = lambda url, token=None, body=None, timeout=20: (
            used.append((url, token)) or {"limits": []})
        row = s.check("b@x.com", json.loads((self.main / "accounts" / "b@x.com.json").read_text()), False)
        self.assertTrue(row["session"])
        self.assertEqual(used, [(s.USAGE_URL, "session-token")])  # expired, yet NOT refreshed

    # -- inside a session ------------------------------------------------------
    def test_hook_inside_session_uses_main_store_and_never_auto_switches(self):
        d = self.status().claim("b@x.com")
        inner = self.fresh_acct({"CLAUDE_CONFIG_DIR": str(d)})
        self.assertEqual(inner.STORE, self.main / "accounts")
        self.assertEqual(inner.CREDS, d / ".credentials.json")
        c = inner.conf()
        c["auto"]["enabled"] = True
        inner.save_conf(c)
        self.assertIsNone(inner.auto_check("limit"))
        with self.assertRaises(SystemExit):
            inner.use("a@x.com")

    # -- run, maps, wrapper ----------------------------------------------------
    def capture_exec(self, mod):
        calls = []
        mod.os.execve = lambda path, argv, env: calls.append((path, argv, env))
        return calls

    def test_run_other_account_gets_profile(self):
        self.acct.find_claude = lambda: "/bin/claude"
        calls = self.capture_exec(self.acct)
        with contextlib.redirect_stderr(io.StringIO()):
            self.acct.run(["b@x.com", "--", "--resume"])
        path, argv, env = calls[0]
        self.assertEqual(argv, ["/bin/claude", "--resume"])
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], str(self.home / ".claude-profiles" / "b@x.com"))

    def test_run_main_account_is_plain(self):
        self.acct.find_claude = lambda: "/bin/claude"
        calls = self.capture_exec(self.acct)
        with contextlib.redirect_stderr(io.StringIO()):
            self.acct.run(["a@x.com"])
        self.assertNotIn("CLAUDE_CONFIG_DIR", calls[0][2])

    def test_map_nearest_parent(self):
        work = self.home / "work"
        (work / "app" / "src").mkdir(parents=True)
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.map_cmd(["b@x.com", str(work)])
        self.assertEqual(self.acct.mapped_account(work / "app" / "src"), "b@x.com")
        self.assertIsNone(self.acct.mapped_account(self.home))
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.map_cmd([str(work)], remove=True)
        self.assertIsNone(self.acct.mapped_account(work / "app"))

    def run_wrapper(self, cwd, enabled):
        c = self.acct.conf()
        c["wrapper"] = {"enabled": enabled, "added": {}}
        c["maps"] = {str(self.home / "work"): "b@x.com"}
        self.acct.save_conf(c)
        w = load("wrapper", "claude-acct-wrapper")
        w.load_acct = lambda: self.acct
        calls = self.capture_exec(w)
        real = self.home / "claude-bin"
        real.write_text("#!/bin/sh\n")
        real.chmod(0o755)
        old = os.getcwd()
        os.chdir(cwd)
        try:
            w.sys.argv = ["wrapper", str(real), "--input-format", "stream-json"]
            w.main()
        finally:
            os.chdir(old)
        return calls[0]

    def test_wrapper_maps_folder_only_when_enabled(self):
        (self.home / "work" / "app").mkdir(parents=True)
        path, argv, env = self.run_wrapper(self.home / "work" / "app", enabled=True)
        self.assertEqual(argv[1:], ["--input-format", "stream-json"])
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], str(self.home / ".claude-profiles" / "b@x.com"))
        path, argv, env = self.run_wrapper(self.home / "work" / "app", enabled=False)
        self.assertNotIn("CLAUDE_CONFIG_DIR", env)
        path, argv, env = self.run_wrapper(self.home, enabled=True)  # unmapped folder
        self.assertNotIn("CLAUDE_CONFIG_DIR", env)

    def test_wrapper_drops_a_vanished_claude_path(self):
        w = load("wrapper", "claude-acct-wrapper")
        self.acct.find_claude = lambda: "/found/claude"
        w.load_acct = lambda: self.acct
        calls = self.capture_exec(w)
        w.sys.argv = ["wrapper", str(self.home / "gone" / "claude"), "-p", "hi"]
        w.main()
        self.assertEqual(calls[0][1], ["/found/claude", "-p", "hi"])

    def test_remove_keeps_backup_and_respects_sessions(self):
        self.status().claim("b@x.com")
        self.pids["b@x.com"] = [1]
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
            self.acct.main(["remove", "b@x.com"])
        self.pids["b@x.com"] = []
        self.status().release("b@x.com")
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.main(["remove", "b@x.com"])
        self.assertFalse((self.main / "accounts" / "b@x.com.json").exists())
        self.assertTrue(list((self.main / "accounts" / ".backup").glob("b@x.com.*.json")))

    def test_shared_reading_keeps_last_good_numbers_on_rate_limit(self):
        s = self.status()
        good = {"name": "a@x.com", "email": "a@x.com", "active": True, "session": False, "error": None,
                "limits": [{"label": "5h", "percent": 40, "resets_at": None}]}
        s.share_reading([good, dict(good, name="b@x.com", email="b@x.com", active=False)], full=True)
        limited = dict(good, error="rate limited, try again in a minute", limits=[])
        s.share_reading([limited], full=False)
        cache = json.loads((self.main / "accounts" / ".usage-cache").read_text())
        a = next(r for r in cache["rows"] if r["name"] == "a@x.com")
        self.assertEqual(a["limits"][0]["percent"], 40)
        self.assertTrue(a["stale"])
        self.assertNotIn("Token", json.dumps(cache))
        self.assertEqual(len(cache["rows"]), 2)

    def _usage_server(self, s, answers):
        """Fake the usage endpoint: answers is a list of dicts or HTTP codes, one per request."""
        import urllib.error
        calls = []

        def http_json(url, token=None, body=None, timeout=20):
            calls.append(url)
            a = answers.pop(0)
            if isinstance(a, int):
                err = urllib.error.HTTPError(url, a, "x", {"Retry-After": "120"}, None)
                raise err
            return a
        s.http_json = http_json
        return calls

    def test_reading_is_reused_and_rate_limit_is_respected(self):
        s = self.status()
        prof = json.loads((self.main / "accounts" / "a@x.com.json").read_text())
        usage = {"limits": [{"kind": "session", "percent": 12, "resets_at": None}]}
        calls = self._usage_server(s, [usage, 429])
        r1 = s.check("a@x.com", prof, True)
        s.share_reading([r1], full=True)
        r2 = s.check("a@x.com", prof, True)               # within 2 minutes: no request
        self.assertEqual(len(calls), 1)
        self.assertEqual(r2["limits"][0]["percent"], 12)
        cache = json.loads((self.main / "accounts" / ".usage-cache").read_text())
        cache["rows"][0]["readAt"] -= 10 * 60 * 1000       # make the reading old
        (self.main / "accounts" / ".usage-cache").write_text(json.dumps(cache))
        r3 = s.check("a@x.com", prof, True)               # asks, gets 429 -> last numbers, stale
        self.assertEqual(len(calls), 2)
        self.assertTrue(r3["stale"])
        self.assertEqual(r3["limits"][0]["percent"], 12)
        self.assertGreater(r3["blockedUntil"] / 1000, __import__("time").time() + 170)  # Retry-After + margin
        s.READ_TTL = 0
        r4 = s.check("a@x.com", prof, True)               # still blocked: no request at all
        self.assertEqual(len(calls), 2)
        self.assertTrue(r4["stale"])

    def test_cached_only_never_asks(self):
        s = self.status()
        s.CACHED_ONLY = True
        calls = self._usage_server(s, [])
        prof = json.loads((self.main / "accounts" / "b@x.com.json").read_text())
        r = s.check("b@x.com", prof, False)
        self.assertEqual(calls, [])
        self.assertEqual(r["error"], "not read yet")

    def test_wrapper_on_off_only_touches_what_it_added(self):
        vs = self.home / ".config/Code/User/settings.json"
        vs.parent.mkdir(parents=True)
        vs.write_text(json.dumps({"editor.fontSize": 14, "claudeCode.initialPermissionMode": "plan"}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.wrapper_cmd(["on"])
        data = json.loads(vs.read_text())
        self.assertTrue(data["claudeCode.claudeProcessWrapper"].endswith("claude-acct-wrapper"))
        self.assertEqual(data["claudeCode.initialPermissionMode"], "plan")  # user's own value kept
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.wrapper_cmd(["off"])
        self.assertEqual(json.loads(vs.read_text()),
                         {"editor.fontSize": 14, "claudeCode.initialPermissionMode": "plan"})

    def test_wrapper_on_sets_permission_mode_when_missing(self):
        vs = self.home / ".config/Code/User/settings.json"
        vs.parent.mkdir(parents=True)
        vs.write_text("{}")
        with contextlib.redirect_stdout(io.StringIO()):
            self.acct.wrapper_cmd(["on"])
        self.assertEqual(json.loads(vs.read_text())["claudeCode.initialPermissionMode"], "bypassPermissions")


if __name__ == "__main__":
    unittest.main()
