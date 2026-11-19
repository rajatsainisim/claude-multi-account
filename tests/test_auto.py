"""Auto-switch decision tests. Fake HOME, fake usage, no network.

Run: python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import tempfile
import time
import types
import unittest
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def load_acct(home):
    os.environ["HOME"] = str(home)
    os.environ.pop("CLAUDE_CONFIG_DIR", None)
    loader = SourceFileLoader(f"claude_acct_{id(home)}", str(REPO / "bin" / "claude-acct"))
    mod = module_from_spec(spec_from_loader(loader.name, loader))
    loader.exec_module(mod)
    return mod


def row(name, week, five, error=None):
    return {"name": name, "email": name, "plan": "pro", "active": False, "error": error,
            "limits": [] if error else [{"label": "5h", "percent": five, "resets_at": None},
                                        {"label": "week", "percent": week, "resets_at": None}]}


class AutoSwitchTest(unittest.TestCase):
    ACCOUNTS = ["a@x.com", "b@x.com", "c@x.com"]

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".claude" / "accounts").mkdir(parents=True)
        self.m = load_acct(self.home)
        for i, n in enumerate(self.ACCOUNTS):
            self.m.write_atomic(self.m.STORE / f"{n}.json", {
                "claudeAiOauth": {"accessToken": f"at{i}", "refreshToken": f"rt{i}", "expiresAt": 9e15},
                "oauthAccount": {"accountUuid": f"u{i}", "emailAddress": n}})
        self.set_live("a@x.com")
        self.usage = {}
        self.switched = []
        fake = types.SimpleNamespace(
            cf=__import__("concurrent.futures").futures,
            check=lambda name, prof, active: self.usage.get(name, row(name, 0, 0)) | {"name": name},
            share_reading=lambda rows, full: self.shared.append((rows, full)))
        self.shared = []
        self.m.status_module = lambda: fake
        self.m.use = self.fake_use

    def tearDown(self):
        self.tmp.cleanup()

    def set_live(self, name):
        i = self.ACCOUNTS.index(name)
        self.m.write_atomic(self.m.CREDS, {"claudeAiOauth": {"accessToken": f"at{i}", "refreshToken": f"rt{i}"}})
        self.m.write_atomic(self.m.GLOBAL, {"oauthAccount": {"accountUuid": f"u{i}"}})

    def fake_use(self, name):
        self.switched.append(name)
        self.set_live(name)
        print("noise that must not reach hook stdout")

    def enable(self, **kw):
        c = self.m.conf()
        c["auto"]["enabled"] = True
        c["auto"].update(kw)
        self.m.save_conf(c)

    # -- tests ---------------------------------------------------------------
    def test_off_by_default_does_nothing(self):
        self.usage = {"a@x.com": row("a@x.com", 99, 99)}
        self.assertIsNone(self.m.auto_check("stop"))
        self.assertIsNone(self.m.auto_check("limit"))
        self.assertEqual(self.switched, [])

    def test_below_threshold_no_switch(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 94, 10)}
        self.assertIsNone(self.m.auto_check("stop"))
        self.assertEqual(self.switched, [])

    def test_weekly_over_threshold_switches_to_least_used(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 95, 10), "b@x.com": row("b@x.com", 60, 5),
                      "c@x.com": row("c@x.com", 20, 50)}
        msg = self.m.auto_check("stop")
        self.assertEqual(self.switched, ["c@x.com"])  # lowest weekly wins
        self.assertIn("switched to c@x.com", msg)

    def test_five_hour_over_threshold_switches(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 10, 96)}
        self.m.auto_check("stop")
        self.assertEqual(len(self.switched), 1)

    def test_throttle_skips_second_check(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 10, 10)}
        self.m.auto_check("stop")
        self.usage = {"a@x.com": row("a@x.com", 99, 99)}
        self.assertIsNone(self.m.auto_check("stop"))  # within checkEverySec
        self.assertEqual(self.switched, [])

    def test_never_checks_faster_than_three_minutes(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 90, 10)}
        self.m.auto_check("stop")
        st = self.m.load(self.m.STATE)
        st["lastCheck"] = time.time() - 61
        self.m.write_atomic(self.m.STATE, st)
        self.usage = {"a@x.com": row("a@x.com", 96, 10)}
        self.m.auto_check("stop")
        self.assertEqual(self.switched, [])  # 1 minute later: still throttled, even close to the limit
        st["lastCheck"] = time.time() - 181
        self.m.write_atomic(self.m.STATE, st)
        self.m.auto_check("stop")
        self.assertEqual(len(self.switched), 1)

    def test_cooldown_blocks_flip_flop_below_100(self):
        self.enable()
        self.m.write_atomic(self.m.STATE, {"lastSwitch": time.time(), "active": "x"})
        self.usage = {"a@x.com": row("a@x.com", 97, 10)}
        self.assertIsNone(self.m.auto_check("stop"))
        self.assertEqual(self.switched, [])

    def test_limit_hit_ignores_cooldown_and_threshold(self):
        self.enable(threshold=100)
        self.m.write_atomic(self.m.STATE, {"lastSwitch": time.time()})
        msg = self.m.auto_check("limit")
        self.assertEqual(len(self.switched), 1)
        self.assertIn("Send your message again", msg)

    def test_threshold_100_never_switches_early(self):
        self.enable(threshold=100)
        self.usage = {"a@x.com": row("a@x.com", 99, 99)}
        self.assertIsNone(self.m.auto_check("stop"))
        self.assertEqual(self.switched, [])

    def test_per_account_threshold(self):
        self.enable()
        c = self.m.conf()
        c["thresholds"]["a@x.com"] = 100
        self.m.save_conf(c)
        self.usage = {"a@x.com": row("a@x.com", 98, 98)}
        self.assertIsNone(self.m.auto_check("stop"))
        self.assertEqual(self.switched, [])

    def test_disabled_account_never_chosen(self):
        self.enable()
        with __import__("contextlib").redirect_stdout(__import__("io").StringIO()):
            self.m.set_disabled("c@x.com", True)
        self.usage = {"a@x.com": row("a@x.com", 99, 10), "b@x.com": row("b@x.com", 70, 0),
                      "c@x.com": row("c@x.com", 0, 0)}
        self.m.auto_check("stop")
        self.assertEqual(self.switched, ["b@x.com"])

    def test_targets_over_their_threshold_or_erroring_are_skipped(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 99, 10), "b@x.com": row("b@x.com", 96, 0),
                      "c@x.com": row("c@x.com", 0, 0, error="token rejected")}
        msg = self.m.auto_check("stop")
        self.assertEqual(self.switched, [])
        self.assertIn("every other account is near its limit", msg)
        # the warning is not repeated on every reply
        st = self.m.load(self.m.STATE)
        st["lastCheck"] = 0
        self.m.write_atomic(self.m.STATE, st)
        self.assertIsNone(self.m.auto_check("stop"))

    def test_dry_run_never_switches(self):
        self.usage = {"a@x.com": row("a@x.com", 99, 10)}
        msg = self.m.auto_check("stop", dry_run=True)
        self.assertEqual(self.switched, [])
        self.assertIn("[dry run]", msg)

    def test_dry_run_does_not_delay_real_check(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 99, 10)}
        self.m.auto_check("stop", dry_run=True)
        self.m.auto_check("stop")
        self.assertEqual(len(self.switched), 1)

    def test_tool_and_prompt_hooks_use_same_throttled_check(self):
        import contextlib
        import io
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 99, 10)}
        for kind in ("tool", "tool", "prompt"):
            sys.stdin = io.StringIO("{}")
            with contextlib.redirect_stdout(io.StringIO()):
                self.m.hook(kind)
            sys.stdin = sys.__stdin__
        self.assertEqual(len(self.switched), 1)  # switched once, then throttled / cooled down

    def test_throttled_hook_does_not_load_network_module(self):
        self.enable()
        self.m.write_atomic(self.m.STATE, {"active": "a@x.com", "lastCheck": time.time(), "lastPeak": 10})
        self.m.status_module = lambda: self.fail("network module loaded on a throttled call")
        self.assertIsNone(self.m.auto_check("stop"))

    def test_hook_reading_is_shared_with_vscode(self):
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 10, 10)}
        self.m.auto_check("stop")
        self.assertEqual(self.shared[-1][1], False)
        self.assertEqual(self.shared[-1][0][0]["name"], "a@x.com")
        self.shared.clear()
        self.m.auto_check("stop", dry_run=True)
        self.assertEqual(self.shared, [])  # a dry run shares nothing

    def test_hook_prints_only_json(self):
        import contextlib
        import io
        self.enable()
        self.usage = {"a@x.com": row("a@x.com", 99, 10)}
        out = io.StringIO()
        sys.stdin = io.StringIO(json.dumps({"hook_event_name": "Stop"}))
        with contextlib.redirect_stdout(out):
            self.m.hook("stop")
        sys.stdin = sys.__stdin__
        self.assertIn("systemMessage", json.loads(out.getvalue()))

    def test_stop_failure_only_on_rate_limit(self):
        import contextlib
        import io
        self.enable()
        for err, expect in (("server_error", 0), ("rate_limit", 1)):
            sys.stdin = io.StringIO(json.dumps({"hook_event_name": "StopFailure", "error": err}))
            with contextlib.redirect_stdout(io.StringIO()):
                self.m.hook("stop-failure")
            sys.stdin = sys.__stdin__
            self.assertEqual(len(self.switched), expect)

    def test_config_files_are_not_accounts(self):
        self.enable()
        self.m.write_atomic(self.m.STATE, {"x": 1})
        self.assertEqual(sorted(self.m.profiles()), self.ACCOUNTS)

    def test_hook_never_raises(self):
        import contextlib
        import io
        sys.stdin = io.StringIO("not json")
        with contextlib.redirect_stdout(io.StringIO()):
            self.m.hook("stop")
        sys.stdin = sys.__stdin__


if __name__ == "__main__":
    unittest.main()
