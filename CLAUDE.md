# Instructions for Claude: set up or update claude-multi-account on this machine

The user opened this repo and wants the multi-account setup installed (or updated). Usually
they are logged in to ONE Claude account already. Reply in the language the user writes in.
README.md explains every feature; `claude-acct help <topic>` is the reference.

## Install or update
1. Look first (read only): `ls ~/.local/bin/claude-acct* ~/.claude/skills`,
   `~/.local/bin/claude-acct list` if it exists, and whether `~/.claude/.credentials.json` exists.
   Tell the user what you found and what the installer will add or update.
2. If this is a git clone, run `git pull --ff-only` first. Then run `./install.sh`
   (`--no-vscode` only if the user asks). It is safe to run again: it backs up what it replaces
   and merges settings instead of overwriting them.
3. Verify and show the user: `claude-acct list` (the account in use has `*`),
   `claude-acct-status`, and, when VS Code is here, that the extension
   `claude-multi-account.claude-accounts` is installed. Ask them to reload VS Code windows.
4. If accounts are missing, tell the user to add them one by one with `/login` in Claude Code.
   They must NOT press Sign out or run `/logout` first; that can invalidate the saved login of
   the current account. Each login is saved after the next reply (or run `claude-acct save`).
   Check with `claude-acct list` after each one.
5. If VS Code shows "Unable to watch for file changes", the Linux watch limit is too low:
   `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-inotify-watches.conf`
   then `sudo sysctl --system`. Ask before using sudo.
6. Mention: click the status bar or press Ctrl+Alt+A for the accounts window;
   `claude-acct help` lists everything. Auto-switch (`claude-acct auto on`) and the panel wrapper
   (`claude-acct wrapper on`) stay off until the user turns them on. Do not turn them on yourself.

## Bringing accounts from another machine
Offer the three ways from `claude-acct help move` and let the user pick: settings only (then
/login per account; safest), logins in an encrypted file, or `claude-acct move <name> --to <host>`.
Explain that a copied login used on both machines logs one of them out.

## Rules
- Never print, echo, copy or commit login or token values. Never edit files in
  `~/.claude/accounts/` or `~/.claude/.credentials.json` by hand; always go through `claude-acct`.
- Do not read usage in a loop: Anthropic allows about 30 usage reads per account per hour.
  `claude-acct-status` reuses readings for 2 minutes; use `--cached` when a fresh number is not needed.
- Do not change unrelated settings. If install.sh reports a file it could not parse, show the user
  the snippet it printed instead of rewriting the file.
- If something fails, `./uninstall.sh` removes everything this repo added (saved logins stay).
