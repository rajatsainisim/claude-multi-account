---
name: switch-account
description: Show the user's saved Claude accounts and switch the live login to another one without logging out, so the same chat continues. Use when the user runs /switch-account or asks to switch/change/add a Claude account.
---

# Switch Claude account

The helper `claude-acct` (in `~/.local/bin`) keeps several claude.ai logins under
`~/.claude/accounts/` and swaps only the claude.ai token. History, sessions, settings and
MCP logins stay shared. The running session re-reads `~/.claude/.credentials.json` when it
changes, so the next message already goes out on the new account. No reload and no new chat needed.

1. Run `claude-acct list --json`. Each row has `name`, `email`, `plan` and `active`.
2. Ask with AskUserQuestion (header "Account"). Offer one option per saved account that is not
   active (label = name, description = email + plan), plus **"Add a new account"**.
   Say in the question which account is active now. If there are more than 3 other accounts,
   list the 3 most likely ones and mention that the rest can be typed via Other.
3. If the user picked an account: run `claude-acct use <name>`, then `claude-acct list`, and
   tell them (in the language they write in) which account is now active and that they can keep chatting in the same chat.
   If the command says the saved login no longer works, tell them to log in to that
   account again and then run `claude-acct save <name>`.
4. If the user picked "Add a new account": tell them to log in to the new account with
   `/login` in this chat box (or the extension's login screen). They should NOT press
   Sign out / `/logout` first, because that can invalidate the saved token of the current account.
   A Stop/SessionStart hook runs `claude-acct autosave`, so the new login is saved by itself after
   the next reply. If they confirm the login now, run `claude-acct save` anyway (or
   `claude-acct save <short-name>` if they gave a name) and show `claude-acct list`.

Never print or echo token values. Do not edit the credential files by hand. Always go through `claude-acct`.
