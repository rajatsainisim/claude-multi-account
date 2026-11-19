// Status bar + menus for the claude-multi-account scripts. Plain JS, no dependencies.
// Reads usage with `claude-acct-status --json` and changes things only through `claude-acct`
// commands; it never touches tokens itself. Runs where the accounts are (a workspace extension,
// so under Remote-SSH it runs on the remote machine).
"use strict";
const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const BIN = path.join(HOME, ".local", "bin");
const ACCT = path.join(BIN, "claude-acct");
const STATUS = path.join(BIN, "claude-acct-status");
const MAIN = path.join(HOME, ".claude");
const STORE = path.join(MAIN, "accounts");
const CONF = path.join(STORE, ".claude-acct.conf");
const STATE = path.join(STORE, ".auto-state");
const CACHE = path.join(STORE, ".usage-cache"); // usage numbers only, shared by all windows
const CREDS = path.join(MAIN, ".credentials.json");
const SEP = vscode.QuickPickItemKind.Separator;

let item;
let output;
let rows = [];
let lastError = null;
let fetchedAt = 0;
let loading = null;
let timer;
let seenEventAt = 0;

// ------------------------------------------------------------------ helpers
const readJSON = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
};
const conf = () => {
  const c = readJSON(CONF);
  c.auto = { enabled: false, threshold: 95, ...(c.auto || {}) };
  c.disabled = c.disabled || [];
  c.thresholds = c.thresholds || {};
  c.maps = c.maps || {};
  c.wrapper = c.wrapper || {};
  return c;
};
const short = (email) => String(email || "?").split("@")[0];
const limit = (r, label) => (r && (r.limits || []).find((l) => l.label === label)) || null;
const pct = (r, label) => Math.round((limit(r, label) || {}).percent || 0);
const peak = (r) => Math.max(pct(r, "5h"), pct(r, "week"));
const bar = (p) => "▰".repeat(Math.min(10, Math.round(p / 10))) + "▱".repeat(10 - Math.min(10, Math.round(p / 10)));
const cmdLink = (cmd, args) => `command:${cmd}${args ? "?" + encodeURIComponent(JSON.stringify(args)) : ""}`;
const sorted = () => [...rows].sort((a, b) => (b.active - a.active) || (a.error ? 1 : 0) - (b.error ? 1 : 0) || peak(a) - peak(b));
const folderPath = () => {
  const f = (vscode.workspace.workspaceFolders || [])[0];
  return f ? f.uri.fsPath : null;
};
function mappedHere(c) {
  let p = folderPath();
  while (p) {
    if (c.maps[p]) return { folder: p, account: c.maps[p] };
    const up = path.dirname(p);
    if (up === p) break;
    p = up;
  }
  return null;
}

function when(iso) {
  if (!iso) return "not started";
  const t = new Date(iso);
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  const left = mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  const sameDay = t.toDateString() === new Date().toDateString();
  const day = sameDay ? "" : t.toLocaleDateString(undefined, { weekday: "short" }) + " ";
  return `${day}${t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} (in ${left})`;
}

function run(args, timeout = 60000, cmd = ACCT, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    delete env.CLAUDE_CONFIG_DIR; // always the main setup
    cp.execFile(cmd, args, { timeout, env }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") })
    );
  });
}

async function acct(args, success) {
  const res = await run(args);
  const text = (res.ok ? res.stdout : res.stderr || res.stdout).trim().split("\n").filter(Boolean).pop() || "";
  if (res.ok) vscode.window.showInformationMessage(`Claude: ${success || text}`);
  else vscode.window.showWarningMessage(`Claude: ${text || "command failed"}`);
  render();
  return res.ok;
}

// ------------------------------------------------------------------ usage
// Anthropic allows only about 30 usage reads per account per hour, and Claude Code reads it too.
// So usage is read only when you ask for it: when the accounts window opens and when you press
// its refresh button. claude-acct-status itself reuses a reading for 2 minutes (30 s for the
// refresh button) and, after a "rate limited" answer, does not ask again until the wait Anthropic
// gave is over, showing the last numbers meanwhile. A switch of the account in use is shown from
// the last readings without asking. Readings from the auto-switch hooks or a terminal arrive
// through CACHE for free. The status bar shows the last reading and how old it is.
let ownWriteAt = 0;
const backgroundMs = () =>
  Math.max(0, vscode.workspace.getConfiguration("claudeAccounts").get("backgroundRefreshMinutes", 0)) * 60000;
const readAtOf = (r) => (r && r.readAt) || 0;
const ageMs = () => {
  const t = Math.max(0, ...rows.map(readAtOf));
  return t ? Date.now() - t : Infinity;
};
const activeAgeMs = () => {
  const t = readAtOf(rows.find((r) => r.active));
  return t ? Date.now() - t : Infinity;
};
const limitedNote = () => {
  const until = Math.max(0, ...rows.map((r) => r.blockedUntil || 0));
  return until > Date.now()
    ? `Anthropic asked to pause usage checks, so the last reading is shown. Next check after ${new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`
    : null;
};

function loadCache() {
  const c = readJSON(CACHE);
  if (!Array.isArray(c.rows)) return false;
  rows = c.rows;
  fetchedAt = c.at || 0;
  return true;
}

async function readStatus(args) {
  if (!fs.existsSync(STATUS)) {
    lastError = "claude-acct-status not found: run install.sh from claude-multi-account";
    return null;
  }
  const res = await run(args, 60000, STATUS);
  if (!res.ok) {
    lastError = res.stderr.split("\n")[0] || "could not read usage";
    return null;
  }
  try {
    lastError = null;
    return JSON.parse(res.stdout);
  } catch {
    lastError = "unexpected output from claude-acct-status";
    return null;
  }
}

// mode: "open" (reuse readings under 2 min), "fresh" (refresh button: under 30 s), "cached" (never ask)
async function refresh(mode = "open") {
  if (loading) return loading;
  const args = ["--json", ...(mode === "fresh" ? ["--fresh"] : mode === "cached" ? ["--cached"] : [])];
  loading = (async () => {
    const data = await readStatus(args);
    if (data) {
      rows = data;
      fetchedAt = Date.now();
      ownWriteAt = Date.now(); // claude-acct-status wrote the shared cache itself
    }
  })().finally(() => {
    loading = null;
    render(); // also tells the window that the refresh is over (stops the spinner)
  });
  postState();
  return loading;
}

// ------------------------------------------------------------------ status bar
function render() {
  const c = conf();
  const active = rows.find((r) => r.active);
  item.color = undefined;
  item.backgroundColor = undefined;
  if (!rows.length) {
    item.text = "$(account) Claude: …";
    item.tooltip = lastError || "Reading usage of your Claude accounts…";
    item.show();
    postState();
    return;
  }
  const auto = c.auto.enabled ? " $(sync)" : "";
  if (active && !active.error) {
    item.text = `$(account) Claude · ${short(active.email)} · 5h ${pct(active, "5h")}% · wk ${pct(active, "week")}%${auto}`;
    const p = peak(active);
    if (p >= 95) item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    else if (p >= 80) item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    else item.color = new vscode.ThemeColor("charts.green");
  } else {
    item.text = active ? `$(account) Claude · ${short(active.email)} $(warning)${auto}` : `$(account) Claude · login not saved${auto}`;
    item.color = new vscode.ThemeColor("charts.yellow");
  }

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Claude accounts** · auto-switch ${c.auto.enabled ? `**ON** at ${c.auto.threshold}%` : "**off**"}` +
    ` · *click an account to switch*\n\n`);
  md.appendMarkdown("| | Account | 5h | | Week | | 5h resets |\n|---|---|---|--:|---|--:|---|\n");
  for (const r of sorted()) {
    const icon = r.active ? "$(check)" : r.session ? "$(terminal)" : "";
    const tags = [
      r.session ? "parallel session" : "",
      c.disabled.includes(r.name) ? "auto: off" : "",
      c.thresholds[r.name] != null ? `auto at ${c.thresholds[r.name]}%` : "",
    ].filter(Boolean).join(", ");
    const name = r.active || r.session ? `**${r.email}**` : `[${r.email}](${cmdLink("claudeAccounts.switchTo", [r.name])} "Switch to ${r.email}")`;
    if (r.error) {
      md.appendMarkdown(`| ${icon} | ${name} | ⚠ ${r.error} | | | | |\n`);
    } else {
      md.appendMarkdown(`| ${icon} | ${name}${tags ? ` *(${tags})*` : ""} | \`${bar(pct(r, "5h"))}\` | ${pct(r, "5h")}% | ` +
        `\`${bar(pct(r, "week"))}\` | ${pct(r, "week")}% | ${when((limit(r, "5h") || {}).resets_at)} |\n`);
    }
  }
  const age = Math.round(ageMs() / 60000);
  const activeAge = Math.round(activeAgeMs() / 1000);
  const activeNote = active && isFinite(activeAge)
    ? `${short(active.email)} read ${activeAge < 60 ? `${activeAge}s` : activeAge < 3600 ? `${Math.round(activeAge / 60)} min` : `${Math.round(activeAge / 3600)} h`} ago, ` : "";
  md.appendMarkdown(
    `\n[$(window) Open](${cmdLink("claudeAccounts.open")}) · ` +
    `[$(sync) Auto-switch ${c.auto.enabled ? "off" : "on"}](${cmdLink("claudeAccounts.toggleAuto")}) · ` +
    `[$(dashboard) Switch at ${c.auto.threshold}%](${cmdLink("claudeAccounts.setThreshold")}) · ` +
    `[$(terminal) Run in terminal](${cmdLink("claudeAccounts.runInTerminal")}) · ` +
    `[$(refresh) Refresh](${cmdLink("claudeAccounts.refresh")}) · ` +
    `[$(question) Help](${cmdLink("claudeAccounts.help")})` +
    `\n\n*${activeNote}click to open the window and update.*` +
    (limitedNote() ? `\n\n$(warning) ${limitedNote()}` : lastError ? `\n\n$(warning) Last update failed: ${lastError}` : ""));
  item.tooltip = md;
  item.show();
  postState();
}

// ------------------------------------------------------------------ menus
function accountItems(c) {
  return sorted().map((r) => ({
    label: `${r.active ? "$(check) " : r.session ? "$(terminal) " : "$(account) "}${r.email}`,
    description: r.error ? `⚠ ${r.error}` : `5h ${pct(r, "5h")}% · week ${pct(r, "week")}%`,
    detail: r.error ? undefined : [
      `5h resets ${when((limit(r, "5h") || {}).resets_at)}`,
      `week resets ${when((limit(r, "week") || {}).resets_at)}`,
      r.plan ? `[${r.plan}]` : "",
      r.active ? "active" : r.session ? "in a parallel session" : "",
      c && c.disabled.includes(r.name) ? "auto: off" : "",
      c && c.thresholds[r.name] != null ? `auto at ${c.thresholds[r.name]}%` : "",
    ].filter(Boolean).join(" · "),
    row: r,
  }));
}

async function ensureFresh() {
  await refresh("open");
}

async function pick() {
  await ensureFresh();
  const c = conf();
  const here = mappedHere(c);
  const folder = folderPath();
  const items = [
    { label: "Switch the main login", kind: SEP },
    ...accountItems(c),
    { label: "Auto-switch", kind: SEP },
    { label: `$(sync) Auto-switch is ${c.auto.enabled ? "ON" : "OFF"}`, description: `turn ${c.auto.enabled ? "off" : "on"}`, action: "auto" },
    { label: `$(dashboard) Switch when 5-hour or weekly usage reaches ${c.auto.threshold}%`, description: "change", action: "threshold" },
    { label: "$(person) Per-account settings…", description: "own limit, keep out of auto-switch, forget", action: "account" },
    { label: "Parallel accounts", kind: SEP },
    { label: "$(terminal) Run Claude in a new terminal as…", action: "terminal" },
    folder ? {
      label: `$(folder) This folder: ${here ? `uses ${short(here.account)}` : "no account mapped"}`,
      description: here ? "change or unmap" : "map it to an account", action: "map",
    } : null,
    {
      label: `$(beaker) VS Code panel follows folder maps: ${c.wrapper.enabled ? "ON" : "OFF"}`,
      description: `experimental, turn ${c.wrapper.enabled ? "off" : "on"}`, action: "wrapper",
    },
    { label: "$(list-unordered) Show parallel sessions", action: "sessions" },
    { label: "More", kind: SEP },
    { label: "$(refresh) Refresh usage now", description: `updated ${Math.round(ageMs() / 60000) || 0} min ago`, action: "refresh" },
    { label: "$(add) Add an account…", action: "add" },
    { label: "$(question) Help: every command", action: "help" },
  ].filter(Boolean);
  const choice = await vscode.window.showQuickPick(items, { title: "Claude accounts", matchOnDescription: true });
  if (!choice) return;
  const actions = {
    auto: toggleAuto, threshold: () => setThreshold(), account: () => accountSettings(), terminal: () => runInTerminal(),
    map: mapFolder, wrapper: toggleWrapper, sessions: showSessions, refresh: () => refresh("fresh"), add: addAccount, help: showHelp,
  };
  if (choice.action) return actions[choice.action]();
  return switchTo(choice.row.name);
}

async function switchTo(name) {
  const r = rows.find((x) => x.name === name);
  if (r && r.active) return vscode.window.showInformationMessage(`Claude: ${r.email} is already active.`);
  const ok = await acct(["use", name], `switched to ${name}. The next message uses it; the chat continues.`);
  if (ok) refresh("cached");
}

async function chooseAccount(title) {
  await ensureFresh();
  const choice = await vscode.window.showQuickPick(accountItems(conf()), { title });
  return choice && choice.row;
}

async function runInTerminal(name) {
  const r = typeof name === "string" ? rows.find((x) => x.name === name) : await chooseAccount("Run Claude in a new terminal as");
  if (!r) return;
  const term = vscode.window.createTerminal({
    name: `Claude · ${short(r.email)}`,
    cwd: folderPath() || undefined,
    shellPath: ACCT,
    shellArgs: ["run", r.name],
  });
  term.show();
  setTimeout(() => refresh("cached"), 15000);
}

async function toggleAuto() {
  const on = !conf().auto.enabled;
  await acct(["auto", on ? "on" : "off"], `auto-switch ${on ? "ON" : "OFF"}.`);
}

async function askThreshold(title, current, allowDefault) {
  const opts = [80, 85, 90, 95, 100].map((n) => ({
    label: `${n}%${n === current ? "  $(check)" : ""}`,
    description: n === 100 ? "use the account fully; switch only when a limit is actually hit" : n === 95 ? "default" : "",
    value: n,
  }));
  if (allowDefault) opts.unshift({ label: "Use the default", description: `${conf().auto.threshold}%`, value: "unset" });
  opts.push({ label: "Other…", value: "custom" });
  const choice = await vscode.window.showQuickPick(opts, { title });
  if (!choice) return null;
  if (choice.value !== "custom") return choice.value;
  const text = await vscode.window.showInputBox({
    title, prompt: "Switch when usage reaches this % (50-100)", value: String(current || 95),
    validateInput: (v) => (/^\d+$/.test(v) && +v >= 50 && +v <= 100 ? null : "A whole number from 50 to 100"),
  });
  return text ? +text : null;
}

async function setThreshold() {
  const v = await askThreshold("Auto-switch: switch away when 5-hour or weekly usage reaches", conf().auto.threshold, false);
  if (v != null) await acct(["auto", "threshold", String(v)], `auto-switch now switches at ${v}%.`);
}

async function accountSettings(name) {
  const r = typeof name === "string" ? rows.find((x) => x.name === name) : await chooseAccount("Settings for which account?");
  if (!r) return;
  const c = conf();
  const own = c.thresholds[r.name];
  const off = c.disabled.includes(r.name);
  const choice = await vscode.window.showQuickPick([
    { label: `$(dashboard) Own auto-switch limit: ${own != null ? `${own}%` : `default (${c.auto.threshold}%)`}`, description: "change", action: "limit" },
    { label: off ? "$(circle-slash) Kept out of auto-switch" : "$(pass) Auto-switch may use it", description: off ? "allow again" : "keep it out", action: "toggle" },
    { label: "$(arrow-swap) Switch the main login to it", action: "switch" },
    { label: "$(terminal) Run Claude in a new terminal as it", action: "terminal" },
    { label: "$(trash) Forget this account on this machine", action: "remove" },
  ], { title: r.email });
  if (!choice) return;
  if (choice.action === "limit") {
    const v = await askThreshold(`${r.email}: switch away at`, own != null ? own : c.auto.threshold, true);
    if (v === "unset") return acct(["auto", "threshold", "--unset", "--account", r.name], `${r.email} uses the default limit.`);
    if (v != null) return acct(["auto", "threshold", String(v), "--account", r.name], `${r.email} switches away at ${v}%.`);
  } else if (choice.action === "toggle") {
    return acct([off ? "enable" : "disable", r.name]);
  } else if (choice.action === "switch") {
    return switchTo(r.name);
  } else if (choice.action === "terminal") {
    return runInTerminal(r.name);
  } else if (choice.action === "remove") {
    const sure = await vscode.window.showWarningMessage(
      `Forget ${r.email} on this machine? Its saved login is deleted (a backup stays in ~/.claude/accounts/.backup). Nothing is logged out.`,
      { modal: true }, "Forget");
    if (sure === "Forget" && (await acct(["remove", r.name]))) refresh("cached");
  }
}

async function mapFolder() {
  const folder = folderPath();
  if (!folder) return vscode.window.showWarningMessage("Claude: open a folder first.");
  const here = mappedHere(conf());
  const items = accountItems(conf()).map((i) => ({ ...i, description: undefined }));
  if (here) items.unshift({ label: "$(close) Unmap", description: here.folder, action: "unmap" });
  const choice = await vscode.window.showQuickPick(items, { title: `Which account should ${path.basename(folder)} use?` });
  if (!choice) return;
  if (choice.action === "unmap") return acct(["unmap", here.folder], `${path.basename(here.folder)} is no longer mapped.`);
  const ok = await acct(["map", choice.row.name, folder], `${path.basename(folder)} now uses ${choice.row.email} in "Run in terminal".`);
  if (ok && !conf().wrapper.enabled) {
    const more = await vscode.window.showInformationMessage(
      "The Claude panel can follow this map too, with the experimental wrapper.", "Tell me more");
    if (more) toggleWrapper();
  }
}

async function toggleWrapper() {
  const on = !conf().wrapper.enabled;
  if (on) {
    const sure = await vscode.window.showWarningMessage(
      "Experimental: let the Claude panel of a mapped folder start as that folder's account?\n\n" +
      "This sets claudeCode.claudeProcessWrapper for every VS Code window on this machine. With a wrapper the Claude " +
      "extension starts chats in the 'default' permission mode, so your Claude defaultMode is also set as " +
      "claudeCode.initialPermissionMode, and the extension turns off its own process tracking, telemetry and update check. " +
      "Unmapped folders work as before. Turning it off removes exactly what was added.",
      { modal: true }, "Turn on");
    if (sure !== "Turn on") return;
  }
  if (await acct(["wrapper", on ? "on" : "off"], `panel wrapper ${on ? "ON" : "OFF"}.`)) {
    const reload = await vscode.window.showInformationMessage("Reload this window to apply it.", "Reload now");
    if (reload) vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function showSessions() {
  const res = await run(["sessions"]);
  output.clear();
  output.appendLine(res.stdout || res.stderr);
  output.show(true);
}

async function addAccount() {
  vscode.window.showInformationMessage(
    "To add an account: run /login in Claude Code and sign in with the new account. Do NOT log out or press Sign out first. " +
    "It is saved automatically after the next reply.", { modal: true });
}

async function showHelp() {
  const res = await run(["help"]);
  const more = await Promise.all(["accounts", "auto", "parallel"].map((t) => run(["help", t])));
  output.clear();
  output.appendLine([res, ...more].map((r) => r.stdout).join("\n" + "─".repeat(80) + "\n"));
  output.show(true);
}

// ------------------------------------------------------------------ another machine
// The three ways from `claude-acct help move`; move (over SSH) stays in the terminal.
async function exportSettings() {
  const uri = await vscode.window.showSaveDialog({
    title: "Export settings (no logins)",
    defaultUri: vscode.Uri.file(path.join(HOME, "claude-accounts-settings.json")),
    filters: { "Claude accounts export": ["json"] },
  });
  if (!uri) return;
  const res = await run(["export", "-o", uri.fsPath]);
  if (res.ok) vscode.window.showInformationMessage(`Claude: settings exported to ${uri.fsPath}. On the other machine use Import, then /login once per account.`);
  else vscode.window.showWarningMessage(`Claude: ${res.stderr.trim().split("\n").pop()}`);
}

async function askPassword() {
  const pw = await vscode.window.showInputBox({
    title: "Password for the export file", password: true, ignoreFocusOut: true,
    prompt: "At least 8 characters. You need it again on the other machine.",
    validateInput: (v) => (v.length >= 8 ? null : "Use at least 8 characters"),
  });
  if (!pw) return null;
  const again = await vscode.window.showInputBox({ title: "The same password again", password: true, ignoreFocusOut: true });
  if (again !== pw) {
    vscode.window.showWarningMessage("Claude: the passwords differ. Nothing was exported.");
    return null;
  }
  return pw;
}

async function exportLogins() {
  await refresh("cached");
  const picked = await vscode.window.showQuickPick(
    sorted().map((r) => ({ label: r.email, description: r.active ? "in use" : r.plan || "", picked: true, row: r })),
    { title: "Which logins go into the file?", canPickMany: true, ignoreFocusOut: true });
  if (!picked || !picked.length) return;
  const pw = await askPassword();
  if (!pw) return;
  const uri = await vscode.window.showSaveDialog({
    title: "Export logins (encrypted)",
    defaultUri: vscode.Uri.file(path.join(HOME, "claude-accounts-logins.cma")),
    filters: { "Encrypted Claude accounts export": ["cma"] },
  });
  if (!uri) return;
  const args = ["export", "--with-logins", ...picked.flatMap((p) => ["--account", p.row.name]), "-o", uri.fsPath];
  const res = await run(args, 60000, ACCT, { CLAUDE_ACCT_PASSWORD: pw });
  if (res.ok) {
    vscode.window.showInformationMessage(
      `Claude: ${picked.length} login(s) exported, encrypted, to ${uri.fsPath}. If both machines keep using the same login, ` +
      "one of them is logged out when the other refreshes it; to hand a login over for good, use `claude-acct move` in a terminal.");
  } else {
    vscode.window.showWarningMessage(`Claude: ${res.stderr.trim().split("\n").pop()}`);
  }
}

async function importFile() {
  const uris = await vscode.window.showOpenDialog({
    title: "Import Claude accounts", canSelectMany: false, defaultUri: vscode.Uri.file(HOME),
    filters: { "Claude accounts export": ["json", "cma"], "All files": ["*"] },
  });
  if (!uris || !uris.length) return;
  const file = uris[0].fsPath;
  let env = {};
  try {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    if (head.toString("latin1") === "Salted__") {
      const pw = await vscode.window.showInputBox({ title: "Password of the export file", password: true, ignoreFocusOut: true });
      if (!pw) return;
      env = { CLAUDE_ACCT_PASSWORD: pw };
    }
  } catch (e) {
    return vscode.window.showWarningMessage(`Claude: cannot read ${file}: ${e.message}`);
  }
  const show = (res) => {
    output.clear();
    output.appendLine((res.stdout + res.stderr).trim());
    output.show(true);
  };
  let res = await run(["import", file], 60000, ACCT, env);
  show(res);
  if (!res.ok) return vscode.window.showWarningMessage(`Claude: ${res.stderr.trim().split("\n").pop()}`);
  refresh("cached");
  if (res.stdout.includes("already saved here")) {
    const a = await vscode.window.showInformationMessage(
      "Claude: imported. Some accounts were already saved here and were kept as they are.", "Replace them with the file's logins");
    if (a) {
      res = await run(["import", file, "--replace", "--no-settings"], 60000, ACCT, env);
      show(res);
      refresh("cached");
    }
  } else {
    vscode.window.showInformationMessage("Claude: imported. Details are in the Claude Accounts output.");
  }
}

// ------------------------------------------------------------------ popup (webview)
// A large panel in the editor area with its own theme. It closes when it loses focus (a click
// anywhere else in VS Code), on Esc, on a click outside its sheet, or with its close button.
let panel = null;
let extUri;

function suggestedAccount(c) {
  const usable = rows.filter((r) => !r.error && !r.session && !r.active && !c.disabled.includes(r.name) &&
    peak(r) < (c.thresholds[r.name] != null ? c.thresholds[r.name] : c.auto.threshold));
  usable.sort((a, b) => pct(a, "week") - pct(b, "week") || pct(a, "5h") - pct(b, "5h"));
  return usable[0] ? usable[0].name : null;
}

function postState(focus = false) {
  if (!panel) return;
  const c = conf();
  panel.webview.postMessage({
    type: "state",
    focus,
    state: {
      rows: sorted(), conf: c, suggested: suggestedAccount(c), folder: folderPath(), here: mappedHere(c),
      activeAge: isFinite(activeAgeMs()) ? activeAgeMs() : null, busy: !!loading, error: limitedNote() || lastError,
    },
  });
}

function popupToast(ok, text) {
  if (panel) panel.webview.postMessage({ type: "toast", ok, text });
}

async function popupRun(args, okText) {
  const res = await run(args);
  const last = (res.ok ? res.stdout : res.stderr || res.stdout).trim().split("\n").filter(Boolean).pop() || "";
  popupToast(res.ok, res.ok ? okText || last : last || "That did not work.");
  render();
  return res.ok;
}

function nonce() {
  return require("crypto").randomBytes(16).toString("base64").replace(/[^A-Za-z0-9]/g, "");
}

function popupHtml(webview) {
  const n = nonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "popup.css"));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "popup.js"));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"><title>Claude accounts</title></head>
<body><div class="backdrop"><div class="sheet" id="app" role="dialog" aria-modal="true" aria-labelledby="title"></div></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<script nonce="${n}" src="${js}"></script></body></html>`;
}

async function openPopup() {
  if (panel) return panel.reveal(vscode.ViewColumn.Active);
  panel = vscode.window.createWebviewPanel("claudeAccounts.popup", "Claude accounts",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extUri, "media")] });
  panel.iconPath = new vscode.ThemeIcon("account");
  panel.webview.html = popupHtml(panel.webview);
  panel.onDidDispose(() => (panel = null));
  panel.onDidChangeViewState((e) => {
    if (!e.webviewPanel.active) e.webviewPanel.dispose(); // clicked somewhere else: close like a popup
  });
  panel.webview.onDidReceiveMessage((m) => onPopupMessage(m).catch((e) => popupToast(false, String(e.message || e))));
}

const known = (name) => typeof name === "string" && rows.some((r) => r.name === name);

async function onPopupMessage(m) {
  if (!m || typeof m.type !== "string") return;
  switch (m.type) {
    case "ready":
      postState(true);
      await refresh("open");
      return;
    case "close":
      return panel && panel.dispose();
    case "refresh":
      await refresh("fresh");
      return popupToast(!limitedNote() && !lastError,
        limitedNote() || (lastError ? `Could not read usage: ${lastError}` : "Usage updated."));
    case "auto":
      return popupRun(["auto", m.on ? "on" : "off"], `Auto-switch is ${m.on ? "on" : "off"}.`);
    case "threshold": {
      if (m.name !== undefined && !known(m.name)) return;
      if (m.unset) return popupRun(["auto", "threshold", "--unset", "--account", m.name], `${short(m.name)} uses the default limit.`);
      const v = Number(m.value);
      if (!Number.isInteger(v) || v < 50 || v > 100) return popupToast(false, "Use a whole number from 50 to 100.");
      return m.name
        ? popupRun(["auto", "threshold", String(v), "--account", m.name], `${short(m.name)} switches away at ${v}%.`)
        : popupRun(["auto", "threshold", String(v)], `Auto-switch switches away at ${v}%.`);
    }
    case "acctAuto":
      if (!known(m.name)) return;
      return popupRun([m.on ? "enable" : "disable", m.name],
        m.on ? `Auto-switch may use ${short(m.name)} again.` : `Auto-switch skips ${short(m.name)}.`);
    case "switch":
      if (!known(m.name)) return;
      if (await popupRun(["use", m.name], `Now using ${m.name}. The chat continues on it.`)) refresh("cached");
      return;
    case "terminal":
      if (known(m.name)) runInTerminal(m.name);
      return;
    case "remove":
      if (!known(m.name)) return;
      if (await popupRun(["remove", m.name], `Forgot ${m.name}. A backup is kept.`)) refresh("cached");
      return;
    case "map": {
      const folder = folderPath();
      if (!folder) return popupToast(false, "Open a folder first.");
      if (m.name === null) {
        const here = mappedHere(conf());
        return here ? popupRun(["unmap", here.folder], "This folder uses the main login again.") : undefined;
      }
      if (!known(m.name)) return;
      return popupRun(["map", m.name, folder], `This folder now uses ${m.name} in terminals.`);
    }
    case "wrapper":
      if (await popupRun(["wrapper", m.on ? "on" : "off"], `The panel follows folder mappings: ${m.on ? "on" : "off"}. Reload the window to apply it.`)) {
        vscode.window.showInformationMessage("Claude accounts: reload this window to apply the panel change.", "Reload now")
          .then((a) => a && vscode.commands.executeCommand("workbench.action.reloadWindow"));
      }
      return;
    case "exportSettings":
      return exportSettings();
    case "exportLogins":
      return exportLogins();
    case "import":
      return importFile();
    case "help": {
      const parts = await Promise.all([[], ["accounts"], ["auto"], ["parallel"], ["files"]].map((t) => run(["help", ...t])));
      if (panel) panel.webview.postMessage({ type: "help", text: parts.map((r) => r.stdout.trimEnd()).join("\n\n" + "─".repeat(72) + "\n\n") });
      return;
    }
  }
}

// ------------------------------------------------------------------ lifecycle
function watch(file, onChange) {
  let last = 0;
  fs.watchFile(file, { interval: 2000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs || Date.now() - last < 1500) return;
    last = Date.now();
    onChange();
  });
  return { dispose: () => fs.unwatchFile(file) };
}

function activate(context) {
  item = vscode.window.createStatusBarItem("claudeAccounts.status", vscode.StatusBarAlignment.Right, 1000);
  item.name = "Claude Accounts";
  item.command = "claudeAccounts.open";
  extUri = context.extensionUri;
  output = vscode.window.createOutputChannel("Claude Accounts");
  seenEventAt = (readJSON(STATE).lastEvent || {}).at || 0;
  const reg = (name, fn) => vscode.commands.registerCommand(name, fn);
  context.subscriptions.push(
    item,
    output,
    reg("claudeAccounts.open", openPopup),
    reg("claudeAccounts.pick", pick),
    reg("claudeAccounts.switchTo", switchTo),
    reg("claudeAccounts.runInTerminal", runInTerminal),
    reg("claudeAccounts.toggleAuto", toggleAuto),
    reg("claudeAccounts.setThreshold", setThreshold),
    reg("claudeAccounts.accountSettings", accountSettings),
    reg("claudeAccounts.mapFolder", mapFolder),
    reg("claudeAccounts.toggleWrapper", toggleWrapper),
    reg("claudeAccounts.help", showHelp),
    reg("claudeAccounts.exportSettings", exportSettings),
    reg("claudeAccounts.exportLogins", exportLogins),
    reg("claudeAccounts.import", importFile),
    reg("claudeAccounts.refresh", () => refresh("fresh")),
    // the main login changed (a switch from anywhere): show it from the last readings, no request
    watch(CREDS, () => refresh("cached")),
    // a reading shared by a hook, the terminal or another window: show it, no request needed
    watch(CACHE, () => {
      if (Date.now() - ownWriteAt > 2000 && loadCache()) render();
    }),
    // auto-switch happened: tell the user
    watch(STATE, () => {
      const ev = readJSON(STATE).lastEvent;
      if (ev && ev.at > seenEventAt) {
        seenEventAt = ev.at;
        vscode.window.showInformationMessage(`Claude auto-switch: ${short(ev.from)} ${ev.reason}, now using ${short(ev.to)}.`);
        render();
      }
    }),
    watch(CONF, render),
    // coming back to VS Code: just show how old the reading is (no request)
    vscode.window.onDidChangeWindowState((s) => s.focused && render()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeAccounts.backgroundRefreshMinutes")) restartTimer();
    }),
    { dispose: () => clearInterval(timer) }
  );
  if (loadCache()) render();
  else refresh("open"); // first run: one reading
  restartTimer();
}

function restartTimer() {
  clearInterval(timer);
  if (backgroundMs() > 0) timer = setInterval(() => refresh("open"), backgroundMs()); // off by default
}

function deactivate() {}

module.exports = { activate, deactivate };
