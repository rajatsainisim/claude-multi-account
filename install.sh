#!/usr/bin/env bash
# Install the Claude multi-account setup for the current user. Safe to run again.
#   ./install.sh             full install
#   ./install.sh --no-vscode skip the VS Code tasks, shortcuts and status bar extension
# Never touches saved logins (~/.claude/accounts), credentials or unrelated settings.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
STAMP="$(date +%Y%m%d-%H%M%S)"
VSCODE=1
[ "${1:-}" = "--no-vscode" ] && VSCODE=0

command -v python3 >/dev/null || { echo "python3 is required (sudo apt install python3)"; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' \
  || { echo "python3 >= 3.8 is required"; exit 1; }

# copy a file; if a different version is already there, keep it as <file>.bak-<stamp>
place() {
  local src="$1" dst="$2" mode="$3"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ]; then
    if cmp -s "$src" "$dst"; then echo "  same: $dst"; return; fi
    cp -a "$dst" "$dst.bak-$STAMP"; echo "  updated (old kept as $(basename "$dst").bak-$STAMP): $dst"
  else
    echo "  added: $dst"
  fi
  install -m "$mode" "$src" "$dst"
}

echo "1/6 scripts -> $BIN"
for f in claude-acct claude-acct-status claude-acct-pick claude-acct-wrapper; do place "$REPO/bin/$f" "$BIN/$f" 755; done

echo "2/6 skills -> $CLAUDE_DIR/skills"
for s in switch-account usageall; do place "$REPO/skills/$s/SKILL.md" "$CLAUDE_DIR/skills/$s/SKILL.md" 644; done

echo "3/6 Claude Code hooks (autosave + auto-switch)"
python3 "$REPO/lib/config_merge.py" add-hooks

echo "4/6 VS Code tasks + Ctrl+Alt+Shift+A (Ctrl+Alt+A comes with the extension)"
if [ "$VSCODE" = 1 ]; then python3 "$REPO/lib/config_merge.py" add-vscode; else echo "  skipped"; fi

echo "5/6 VS Code status bar extension"
VSIX="$(mktemp -d)/claude-accounts.vsix"
python3 "$REPO/lib/build_vsix.py" "$VSIX" >/dev/null
CODE_CLI="$(command -v code || true)"
if [ -z "$CODE_CLI" ]; then  # Remote-SSH host: the server's own CLI installs into ~/.vscode-server
  CODE_CLI="$(ls -t "$HOME"/.vscode-server/cli/servers/*/server/bin/code-server \
                    "$HOME"/.vscode-server/bin/*/bin/code-server 2>/dev/null | head -1 || true)"
fi
if [ "$VSCODE" = 1 ] && [ -n "$CODE_CLI" ]; then
  if "$CODE_CLI" --install-extension "$VSIX" --force >/dev/null 2>&1; then
    echo "  installed (status bar, bottom right); reload VS Code windows to see it"
  else
    echo "  ! could not install; install by hand: code --install-extension $VSIX"
  fi
else
  echo "  skipped (no VS Code CLI here)"
fi

echo "6/6 PATH + save the current login"
case ":$PATH:" in
  *":$BIN:"*) echo "  $BIN is on PATH" ;;
  *) if ! grep -qs 'claude-multi-account PATH' "$HOME/.bashrc"; then
       printf '\nexport PATH="$HOME/.local/bin:$PATH"  # claude-multi-account PATH\n' >> "$HOME/.bashrc"
       echo "  added $BIN to PATH in ~/.bashrc (open a new terminal)"
     fi ;;
esac
mkdir -p "$CLAUDE_DIR/accounts" && chmod 700 "$CLAUDE_DIR/accounts"
if [ -f "$CLAUDE_DIR/.credentials.json" ]; then
  "$BIN/claude-acct" autosave
  echo; "$BIN/claude-acct" list
else
  echo "  not logged in yet: run /login in Claude Code, the hook saves it after the next reply"
fi

cat <<'EOF'

Done.
- Add more accounts: in Claude Code run /login for each one (do NOT /logout first).
  Each login is saved automatically after the next reply (or run: claude-acct save).
- VS Code: reload the window, then click the status bar (or press Ctrl+Alt+A) for the
  accounts window. Terminal: claude-acct-pick. Chat: /switch-account, /usageall.
- Auto-switch is off until you turn it on. Every command: claude-acct help
EOF
