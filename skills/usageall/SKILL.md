---
name: usageall
description: Show usage limits (5-hour session %, weekly %, reset times) of ALL saved Claude accounts at once, so the user can pick which one to switch to. Use when the user runs /usageall or asks for status/limit/usage of all accounts.
---

# Status of all Claude accounts

1. Run `claude-acct-status` (in `~/.local/bin`). It reads the accounts saved by `claude-acct`,
   refreshes an expired token of an inactive account by itself (backup + save back to that
   account's file) and never touches the active login, settings or `claude-acct`.
2. Show the output to the user as a compact markdown table: account, plan, 5h used %, 5h reset,
   weekly used %, weekly reset (add a "week <model>" column only if some account has one).
   Mark the active account. If a row has an error, show it in that row.
3. In one or two lines in the user's language, suggest which account is best to switch to now (lowest weekly %,
   then lowest 5h %, and not close to 100%), and say they can switch with `/switch-account`.
   Do not switch by yourself.

Never print token values. Never edit files under `~/.claude/accounts/` by hand.
