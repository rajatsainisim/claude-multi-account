#!/usr/bin/env bash
# Remove the multi-account scripts, skills, hooks and VS Code task.
# Saved logins in ~/.claude/accounts are KEPT (delete that folder yourself if you want).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

"$HOME/.local/bin/claude-acct" wrapper off >/dev/null 2>&1 || true   # undo VS Code wrapper settings first
rm -fv "$HOME/.local/bin/claude-acct" "$HOME/.local/bin/claude-acct-status" "$HOME/.local/bin/claude-acct-pick" \
       "$HOME/.local/bin/claude-acct-wrapper"
rm -rfv "$CLAUDE_DIR/skills/switch-account" "$CLAUDE_DIR/skills/usageall"
python3 "$REPO/lib/config_merge.py" remove-hooks
python3 "$REPO/lib/config_merge.py" remove-vscode
CODE_CLI="$(command -v code || ls -t "$HOME"/.vscode-server/cli/servers/*/server/bin/code-server 2>/dev/null | head -1 || true)"
[ -n "$CODE_CLI" ] && "$CODE_CLI" --uninstall-extension claude-multi-account.claude-accounts >/dev/null 2>&1 \
  && echo "  status bar extension removed" || true
echo "Removed. Saved logins are still in $CLAUDE_DIR/accounts; the current login is unchanged."
