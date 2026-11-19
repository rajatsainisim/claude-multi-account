"""Export / import / move tests. Fake homes, no network (a fake ssh runs the other machine locally).

Run: python3 -m unittest discover -s tests -v
"""
import contextlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HAS_OPENSSL = shutil.which("openssl") is not None


def make_home(root, accounts, live=None):
    main = root / ".claude"
    (main / "accounts").mkdir(parents=True)
    for i, n in enumerate(accounts):
        (main / "accounts" / f"{n}.json").write_text(json.dumps({
            "claudeAiOauth": {"accessToken": f"at-{n}", "refreshToken": f"rt-{n}", "expiresAt": 9e15,
                              "subscriptionType": "pro"},
            "oauthAccount": {"accountUuid": f"u-{n}", "emailAddress": n}}))
    if live:
        (main / ".credentials.json").write_text(json.dumps(
            {"claudeAiOauth": {"accessToken": f"at-{live}", "refreshToken": f"rt-{live}", "expiresAt": 9e15}}))
        (root / ".claude.json").write_text(json.dumps({"oauthAccount": {"accountUuid": f"u-{live}"}}))
    bin_dir = root / ".local" / "bin"
    bin_dir.mkdir(parents=True)
    for f in ("claude-acct", "claude-acct-status"):
        shutil.copy(REPO / "bin" / f, bin_dir / f)
    return main


def load_acct(home):
    os.environ["HOME"] = str(home)
    os.environ.pop("CLAUDE_CONFIG_DIR", None)
    loader = SourceFileLoader(f"acct_{os.urandom(4).hex()}", str(home / ".local" / "bin" / "claude-acct"))
    mod = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(mod)
    real = mod.status_module

    def status_module():
        s = real()
        s.profile_pids = lambda name: []
        return s
    mod.status_module = status_module
    mod.token_account = lambda oauth: {"accountUuid": "u-" + oauth["accessToken"][3:]}
    return mod


def quiet(fn, *a):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        fn(*a)
    return out.getvalue() + err.getvalue()


class TransferTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.a_home = self.root / "laptop"
        self.b_home = self.root / "vm"
        self.a_main = make_home(self.a_home, ["work@x.com", "side@x.com", "old@x.com"], live="work@x.com")
        self.b_main = make_home(self.b_home, ["work@x.com"], live="work@x.com")
        self.a = load_acct(self.a_home)
        c = self.a.conf()
        c["auto"].update(enabled=True, threshold=90)
        c["thresholds"]["side@x.com"] = 100
        c["disabled"] = ["old@x.com"]
        c["maps"] = {str(self.root): "side@x.com", "/no/such/folder": "side@x.com"}
        self.a.save_conf(c)
        os.environ.pop("CLAUDE_ACCT_PASSWORD", None)

    def tearDown(self):
        os.environ.pop("CLAUDE_ACCT_PASSWORD", None)
        self.tmp.cleanup()

    def file(self, name):
        return str(self.root / name)

    # -- settings only ---------------------------------------------------------------
    def test_settings_export_has_no_logins(self):
        out = self.file("s.json")
        msg = quiet(self.a.export_cmd, ["-o", out])
        data = json.loads(Path(out).read_text())
        self.assertNotIn("at-", Path(out).read_text())
        self.assertNotIn("rt-", Path(out).read_text())
        self.assertEqual(sorted(a["email"] for a in data["accounts"]), ["old@x.com", "side@x.com", "work@x.com"])
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        self.assertIn("No logins inside", msg)

    def test_settings_import_merges_and_lists_logins_needed(self):
        out = self.file("s.json")
        quiet(self.a.export_cmd, ["-o", out])
        b = load_acct(self.b_home)
        msg = quiet(b.import_cmd, [out])
        c = b.conf()
        self.assertTrue(c["auto"]["enabled"])
        self.assertEqual(c["auto"]["threshold"], 90)
        self.assertEqual(c["thresholds"], {"side@x.com": 100})
        self.assertEqual(c["disabled"], ["old@x.com"])
        self.assertEqual(c["maps"], {str(self.root): "side@x.com"})  # folders missing here are left out
        need = msg.split("log in once with /login to: ")[1].split("\n")[0].split(", ")
        self.assertEqual(sorted(need), ["old@x.com", "side@x.com"])
        self.assertEqual(sorted(b.profiles()), ["work@x.com"])  # no login appeared from nowhere

    # -- with logins -----------------------------------------------------------------
    def test_plain_login_export_and_import(self):
        out = self.file("l.json")
        msg = quiet(self.a.export_cmd, ["--with-logins", "--plain", "--account", "side", "-o", out])
        self.assertIn("IN PLAIN TEXT", msg)
        self.assertIn("rt-side@x.com", Path(out).read_text())
        b = load_acct(self.b_home)
        msg = quiet(b.import_cmd, [out])
        self.assertIn("side@x.com: imported", msg)
        saved = json.loads((self.b_main / "accounts" / "side@x.com.json").read_text())
        self.assertEqual(saved["claudeAiOauth"]["refreshToken"], "rt-side@x.com")

    @unittest.skipUnless(HAS_OPENSSL, "openssl not installed")
    def test_encrypted_roundtrip_and_wrong_password(self):
        out = self.file("l.cma")
        os.environ["CLAUDE_ACCT_PASSWORD"] = "correct horse"
        quiet(self.a.export_cmd, ["--with-logins", "-o", out])
        raw = Path(out).read_bytes()
        self.assertTrue(raw.startswith(b"Salted__"))
        self.assertNotIn(b"rt-", raw)
        b = load_acct(self.b_home)
        os.environ["CLAUDE_ACCT_PASSWORD"] = "wrong password"
        with self.assertRaises(SystemExit) as e:
            quiet(b.import_cmd, [out])
        self.assertIn("Wrong password", str(e.exception.code))
        self.assertEqual(sorted(b.profiles()), ["work@x.com"])
        os.environ["CLAUDE_ACCT_PASSWORD"] = "correct horse"
        msg = quiet(b.import_cmd, [out])
        self.assertIn("side@x.com: imported", msg)
        self.assertIn("old@x.com: imported", msg)

    def test_import_never_replaces_without_asking_and_never_the_login_in_use(self):
        out = self.file("l.json")
        quiet(self.a.export_cmd, ["--with-logins", "--plain", "-o", out])
        b = load_acct(self.b_home)
        msg = quiet(b.import_cmd, [out])
        self.assertIn("work@x.com: already saved here", msg)
        msg = quiet(b.import_cmd, [out, "--replace"])
        self.assertIn("work@x.com: in use on this machine now, kept as is", msg)
        self.assertIn("side@x.com: replaced", msg)

    def test_rejects_foreign_files_and_bad_names(self):
        bad = self.file("bad.json")
        Path(bad).write_text(json.dumps({"hello": 1}))
        with self.assertRaises(SystemExit):
            quiet(self.a.import_cmd, [bad])
        evil = self.file("evil.json")
        Path(evil).write_text(json.dumps({"format": "claude-multi-account", "version": 1, "settings": {},
                                          "accounts": [{"name": "../../x", "login": {"claudeAiOauth": {
                                              "accessToken": "a", "refreshToken": "r"}}}]}))
        quiet(self.a.import_cmd, [evil])
        self.assertFalse((self.root / "x.json").exists())
        self.assertFalse(any(p.name.startswith("..") for p in (self.a_main / "accounts").iterdir()))

    # -- move ------------------------------------------------------------------------
    def fake_ssh(self):
        """A stand-in for ssh: runs the remote command on the fake VM home."""
        script = self.root / "fake-ssh"
        script.write_text(f"""#!/usr/bin/env python3
import os, subprocess, sys
host, cmd = sys.argv[1], sys.argv[2]
env = dict(os.environ, HOME={str(self.b_home)!r})
sys.exit(subprocess.run(["bash", "-c", cmd], env=env).returncode)
""")
        script.chmod(0o755)
        return str(script)

    def test_move_hands_the_login_over_and_forgets_it_here(self):
        msg = quiet(self.a.move_cmd, ["side", "--to", "vm", "--ssh-command", self.fake_ssh()])
        self.assertIn("Moved side@x.com to vm", msg)
        self.assertFalse((self.a_main / "accounts" / "side@x.com.json").exists())
        self.assertTrue(list((self.a_main / "accounts" / ".backup").glob("side@x.com.*.json")))
        there = json.loads((self.b_main / "accounts" / "side@x.com.json").read_text())
        self.assertEqual(there["claudeAiOauth"]["refreshToken"], "rt-side@x.com")
        conf_there = self.b_main / "accounts" / ".claude-acct.conf"
        there_conf = json.loads(conf_there.read_text()) if conf_there.exists() else {}
        self.assertFalse(there_conf.get("thresholds"))  # a move carries the login only, not settings

    def test_move_refuses_the_account_in_use(self):
        with self.assertRaises(SystemExit) as e:
            quiet(self.a.move_cmd, ["work", "--to", "vm", "--ssh-command", self.fake_ssh()])
        self.assertIn("in use here", str(e.exception.code))

    def test_move_keeps_the_login_when_the_other_side_fails(self):
        broken = self.root / "broken-ssh"
        broken.write_text("#!/bin/sh\necho 'connection refused' >&2\nexit 255\n")
        broken.chmod(0o755)
        with self.assertRaises(SystemExit) as e:
            quiet(self.a.move_cmd, ["side", "--to", "vm", "--ssh-command", str(broken)])
        self.assertIn("nothing was removed here", str(e.exception.code))
        self.assertTrue((self.a_main / "accounts" / "side@x.com.json").exists())


if __name__ == "__main__":
    unittest.main()
