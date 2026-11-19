#!/usr/bin/env python3
"""Merge (or remove) the multi-account pieces into existing config files, never overwriting them.

  config_merge.py add-hooks       add the autosave + auto-switch hooks to Claude settings
  config_merge.py remove-hooks    remove only our hooks
  config_merge.py add-vscode      add the VS Code tasks + shortcuts (Ctrl+Alt+A, Ctrl+Alt+Shift+A)
  config_merge.py remove-vscode   remove only those tasks + shortcuts

Every file that is changed is backed up first as <file>.bak-<timestamp>. Files that cannot be
parsed as plain JSON (for example with // comments) are left alone and a manual snippet is printed.
"""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HOME = Path.home()
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR", HOME / ".claude"))
SETTINGS = CLAUDE_DIR / "settings.json"
VSCODE_DIRS = [HOME / ".config/Code/User", HOME / ".config/Code - Insiders/User",
               HOME / "Library/Application Support/Code/User"]

# (event, marker that identifies our hook, command, timeout)
HOOKS = [
    ("Stop", "claude-acct autosave", "$HOME/.local/bin/claude-acct autosave >/dev/null 2>&1 || true", 20),
    ("SessionStart", "claude-acct autosave", "$HOME/.local/bin/claude-acct autosave >/dev/null 2>&1 || true", 20),
    # auto-switch: no-ops in a few ms while auto-switch is off
    ("Stop", "claude-acct hook stop", "$HOME/.local/bin/claude-acct hook stop 2>/dev/null || true", 60),
    ("StopFailure", "claude-acct hook stop-failure", "$HOME/.local/bin/claude-acct hook stop-failure 2>/dev/null || true", 60),
    # long turns: check between tool calls too (throttled, returns in ms most of the time)
    ("PostToolUse", "claude-acct hook tool", "$HOME/.local/bin/claude-acct hook tool 2>/dev/null || true", 60),
    # never start a new message on an account that is already over its threshold
    ("UserPromptSubmit", "claude-acct hook prompt", "$HOME/.local/bin/claude-acct hook prompt 2>/dev/null || true", 60),
]
HOOK_MARKS = {m for _, m, _, _ in HOOKS}

def _task(label, command, panel):
    return {"label": label, "type": "shell", "command": command, "problemMatcher": [],
            "presentation": {"reveal": "always", "focus": True, "panel": panel, "clear": True, "close": False}}


# (task, keybinding or None, how the key is shown). Ctrl+Alt+A now belongs to the status bar
# extension (it opens the accounts window); the terminal picker stays as a task.
VSCODE_ITEMS = [
    (_task("Claude: Switch account", "${userHome}/.local/bin/claude-acct-pick", "dedicated"),
     None, None),
    (_task("Claude: Run in terminal as account", "${userHome}/.local/bin/claude-acct-pick --run", "new"),
     "ctrl+alt+shift+a", "Ctrl+Alt+Shift+A"),
]
LABELS = {t["label"] for t, _, _ in VSCODE_ITEMS}

def read_json(path, default):
    if not path.exists() or not path.read_text().strip():
        return default, True
    try:
        return json.loads(path.read_text()), True
    except ValueError:
        return None, False


def write_json(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        shutil.copy2(path, path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}"))
        mode = path.stat().st_mode & 0o777
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def has_hook(groups, mark):
    return any(mark in (h.get("command") or "") for g in groups for h in g.get("hooks", []))


def is_ours(cmd):
    return any(m in (cmd or "") for m in HOOK_MARKS)


def add_hooks():
    data, ok = read_json(SETTINGS, {})
    if not ok:
        sys.exit(f"! {SETTINGS} is not valid JSON; not touched. Fix it and run install again.")
    hooks = data.setdefault("hooks", {})
    added = []
    for ev, mark, cmd, timeout in HOOKS:
        groups = hooks.setdefault(ev, [])
        if not has_hook(groups, mark):
            groups.append({"hooks": [{"type": "command", "command": cmd, "timeout": timeout}]})
            added.append(f"{ev} ({mark})")
    if added:
        write_json(SETTINGS, data)
        print(f"  hooks added to {SETTINGS}: {', '.join(added)} (backup kept)")
    else:
        print("  hooks already present, settings.json not changed")


def remove_hooks():
    data, ok = read_json(SETTINGS, {})
    if not ok or not data.get("hooks"):
        print("  no hooks to remove")
        return
    changed = False
    for ev in {e for e, _, _, _ in HOOKS}:
        groups = data["hooks"].get(ev, [])
        kept = []
        for g in groups:
            hs = [h for h in g.get("hooks", []) if not is_ours(h.get("command"))]
            changed |= len(hs) != len(g.get("hooks", []))
            if hs:
                kept.append({**g, "hooks": hs})
        if kept:
            data["hooks"][ev] = kept
        elif ev in data["hooks"]:
            del data["hooks"][ev]
    if not data["hooks"]:
        del data["hooks"]
    if changed:
        write_json(SETTINGS, data)
        print("  claude-acct hooks removed (backup kept)")
    else:
        print("  no claude-acct hooks found")


def vscode_dirs():
    return [d for d in VSCODE_DIRS if d.is_dir()]


def manual_snippet(path, item):
    print(f"  ! {path} has comments or is not plain JSON; not touched. Add this by hand:")
    print("    " + json.dumps(item))


def add_vscode():
    dirs = vscode_dirs()
    if not dirs:
        print("  no desktop VS Code here (normal on a VM: the shortcuts come from your laptop's VS Code"
              " and run on the VM through Remote-SSH)")
        return
    for d in dirs:
        tpath = d / "tasks.json"
        tasks, ok = read_json(tpath, {"version": "2.0.0", "tasks": []})
        if not ok:
            for task, _, _ in VSCODE_ITEMS:
                manual_snippet(tpath, task)
        else:
            lst = tasks.setdefault("tasks", [])
            changed = []
            for task, _, _ in VSCODE_ITEMS:
                same = [t for t in lst if t.get("label") == task["label"]]
                if same and same[0].get("command") == task["command"]:
                    continue
                lst = [t for t in lst if t.get("label") != task["label"]] + [task]
                changed.append(f"'{task['label']}' {'updated' if same else 'added'}")
            if changed:
                tasks["tasks"] = lst
                tasks.setdefault("version", "2.0.0")
                write_json(tpath, tasks, 0o644)
                print(f"  tasks {', '.join(changed)} in {tpath}")
            else:
                print(f"  tasks already present in {tpath}")
        kpath = d / "keybindings.json"
        keys, ok = read_json(kpath, [])
        # older installs bound Ctrl+Alt+A to the terminal picker task; that would hide the extension's key
        old = {"key": "ctrl+alt+a", "command": "workbench.action.tasks.runTask", "args": "Claude: Switch account"}
        if ok and old in keys:
            keys = [k for k in keys if k != old]
            write_json(kpath, keys, 0o644)
            print(f"  Ctrl+Alt+A now opens the accounts window (old terminal binding removed from {kpath})")
        for task, key, shown in VSCODE_ITEMS:
            if key is None:
                continue
            binding = {"key": key, "command": "workbench.action.tasks.runTask", "args": task["label"]}
            if not ok:
                manual_snippet(kpath, binding)
            elif any(k.get("key") == key and k.get("args") == task["label"] for k in keys):
                print(f"  {shown} already present in {kpath}")
            elif [k for k in keys if k.get("key") == key]:
                clash = [k for k in keys if k.get("key") == key][0]
                print(f"  ! {shown} is already used in {kpath} for {clash.get('command')}; not changed."
                      f" Run '{task['label']}' from the command palette, or bind it by hand.")
            else:
                keys = keys + [binding]
                write_json(kpath, keys, 0o644)
                print(f"  {shown} added in {kpath}")


def remove_vscode():
    for d in vscode_dirs():
        tpath, kpath = d / "tasks.json", d / "keybindings.json"
        tasks, ok = read_json(tpath, None)
        if ok and tasks and any(t.get("label") in LABELS for t in tasks.get("tasks", [])):
            tasks["tasks"] = [t for t in tasks["tasks"] if t.get("label") not in LABELS]
            write_json(tpath, tasks, 0o644)
            print(f"  tasks removed from {tpath}")
        keys, ok = read_json(kpath, None)
        if ok and keys and any(k.get("args") in LABELS for k in keys):
            write_json(kpath, [k for k in keys if k.get("args") not in LABELS], 0o644)
            print(f"  shortcuts removed from {kpath}")

if __name__ == "__main__":
    actions = {"add-hooks": add_hooks, "remove-hooks": remove_hooks,
               "add-vscode": add_vscode, "remove-vscode": remove_vscode}
    if len(sys.argv) != 2 or sys.argv[1] not in actions:
        sys.exit(__doc__)
    actions[sys.argv[1]]()
