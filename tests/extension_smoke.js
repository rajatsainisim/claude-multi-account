// Smoke test for vscode-extension/extension.js with a fake `vscode` module and fake scripts.
// Run: node tests/extension_smoke.js   (exit code 0 = all checks passed)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const assert = require("assert");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cma-ext-"));
process.env.HOME = home;
const bin = path.join(home, ".local", "bin");
const store = path.join(home, ".claude", "accounts");
const proj = path.join(home, "work", "app");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
const log = path.join(home, "calls.log");
const rows = [
  { name: "a@x.com", email: "a@x.com", plan: "team", active: true, session: false, error: null,
    limits: [{ label: "5h", percent: 82, resets_at: new Date(Date.now() + 3600e3).toISOString() },
             { label: "week", percent: 40, resets_at: new Date(Date.now() + 86400e3).toISOString() }] },
  { name: "b@x.com", email: "b@x.com", plan: "pro", active: false, session: true, error: null,
    limits: [{ label: "5h", percent: 0, resets_at: null }, { label: "week", percent: 10, resets_at: null }] },
  { name: "c@x.com", email: "c@x.com", plan: "max", active: false, session: false, error: null,
    limits: [{ label: "5h", percent: 5, resets_at: null }, { label: "week", percent: 20, resets_at: null }] },
  { name: "d@x.com", email: "d@x.com", plan: "max", active: false, session: false, error: "token rejected", limits: [] },
];
const writeStatus = () => fs.writeFileSync(path.join(bin, "claude-acct-status"),
  `#!/bin/sh\necho status "$CLAUDE_CONFIG_DIR" "$@" >> ${log}\ncase "$*" in\n*active-only*) cat <<'EOF'\n` +
  `${JSON.stringify(rows.filter((r) => r.active))}\nEOF\n;;\n*) cat <<'EOF'\n${JSON.stringify(rows)}\nEOF\n;;\nesac\n`, { mode: 0o755 });
writeStatus();
fs.writeFileSync(path.join(bin, "claude-acct"),
  `#!/bin/sh\necho acct "$@" >> ${log}\n[ -n "$CLAUDE_ACCT_PASSWORD" ] && echo "pw=$CLAUDE_ACCT_PASSWORD" >> ${log}\n` +
  `[ "$1" = help ] && echo "HELP $2"\n[ "$1" = sessions ] && echo "b@x.com running"\n` +
  `[ "$1" = import ] && echo "Imported." && echo "  work@x.com: already saved here, kept as is"\nexit 0\n`, { mode: 0o755 });
const calls = () => fs.readFileSync(log, "utf8");

// ---- fake vscode ----
const shown = { info: [], warn: [], out: "" };
const pickQueue = [];   // functions(items) -> chosen item
const warnQueue = [];   // answers for modal warnings
const inputQueue = [];
const dialogQueue = [];
const registered = {};
const executed = [];
const item = { show() { this.visible = true; } };
let windowStateCb;
let panel = null;
function fakePanel() {
  const p = {
    posted: [], disposed: false, handlers: {},
    webview: {
      html: "", cspSource: "vscode-resource:",
      asWebviewUri: (u) => "vscode-resource:" + u.path,
      postMessage(m) { p.posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage(cb) { p.handlers.msg = cb; return { dispose() {} }; },
    },
    onDidDispose(cb) { p.handlers.dispose = cb; return { dispose() {} }; },
    onDidChangeViewState(cb) { p.handlers.view = cb; return { dispose() {} }; },
    reveal() { p.revealed = true; },
    dispose() { if (!p.disposed) { p.disposed = true; p.handlers.dispose(); } },
  };
  return p;
}
const vscode = {
  ViewColumn: { Active: -1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }), file: (p) => ({ fsPath: p }) },
  StatusBarAlignment: { Right: 2 },
  QuickPickItemKind: { Separator: -1 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ""; } appendMarkdown(s) { this.value += s; } },
  window: {
    createStatusBarItem: () => item,
    createWebviewPanel: () => (panel = fakePanel()),
    createOutputChannel: () => ({ clear() { shown.out = ""; }, appendLine(s) { shown.out += s + "\n"; }, show() {}, dispose() {} }),
    showInformationMessage: async (m, ...rest) => { shown.info.push(m); return undefined; },
    showWarningMessage: async (m, ...rest) => { shown.warn.push(m); return rest.length > 1 ? warnQueue.shift() : undefined; },
    showQuickPick: async (items, opts) => { shown.lastPickTitle = opts && opts.title; const f = pickQueue.shift(); return f ? f(items) : undefined; },
    showInputBox: async (o) => { const v = inputQueue.shift(); if (v !== undefined && o.validateInput) assert.strictEqual(o.validateInput(v), null); return v; },
    createTerminal: (o) => ({ opts: o, show() { shown.terminal = o; } }),
    showSaveDialog: async (o) => { shown.saveTitle = o.title; return dialogQueue.shift(); },
    showOpenDialog: async () => dialogQueue.shift(),
    onDidChangeWindowState: (cb) => { windowStateCb = cb; return { dispose() {} }; },
    state: { focused: true },
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: [{ uri: { fsPath: proj } }],
  },
  commands: {
    registerCommand: (n, f) => { registered[n] = f; return { dispose() {} }; },
    executeCommand: (c) => executed.push(c),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "vscode" ? vscode : origLoad.call(this, req, ...rest); };

const ext = require(path.join(__dirname, "..", "vscode-extension", "extension.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { subscriptions: [], extensionUri: { path: "/ext" } };
const byLabel = (text) => (items) => items.find((i) => i.label && i.label.includes(text));
const byAccount = (name) => (items) => items.find((i) => i.row && i.row.name === name);
const setConf = (c) => fs.writeFileSync(path.join(store, ".claude-acct.conf"), JSON.stringify(c));

(async () => {
  process.env.CLAUDE_CONFIG_DIR = "/should/not/leak";
  ext.activate(ctx);
  await registered["claudeAccounts.refresh"]();

  // --- status bar
  assert.ok(item.visible, "status bar visible");
  assert.strictEqual(item.text, "$(account) Claude · a · 5h 82% · wk 40%");
  assert.strictEqual(item.backgroundColor.id, "statusBarItem.warningBackground", "80%+ is yellow");
  const tip = item.tooltip.value;
  assert.ok(tip.includes("b@x.com** *(parallel session)*"), "session tagged and not clickable");
  assert.ok(tip.includes(`command:claudeAccounts.switchTo?${encodeURIComponent(JSON.stringify(["c@x.com"]))}`), "account row switches on click");
  assert.ok(tip.includes("▰▰"), "usage bars");
  assert.ok(tip.includes("⚠ token rejected"), "errors shown");
  for (const c of ["open", "toggleAuto", "setThreshold", "runInTerminal", "refresh", "help"]) {
    assert.ok(tip.includes(`command:claudeAccounts.${c}`), `tooltip link ${c}`);
  }
  assert.ok(/status  --json/.test(calls()), "CLAUDE_CONFIG_DIR not passed to scripts");

  // --- green below 80
  rows[0].limits[0].percent = 10;
  writeStatus();
  await registered["claudeAccounts.refresh"]();
  assert.strictEqual(item.color.id, "charts.green", "green when fine");

  // --- menu: switch via account row, and via tooltip link
  pickQueue.push(byAccount("c@x.com"));
  await registered["claudeAccounts.pick"]();
  assert.ok(calls().includes("acct use c@x.com"), "menu switch runs claude-acct use");
  await registered["claudeAccounts.switchTo"]("c@x.com");
  assert.ok(shown.info.some((m) => m.includes("switched to c@x.com")));
  await registered["claudeAccounts.switchTo"]("a@x.com");
  assert.ok(shown.info.some((m) => m.includes("already active")), "active not switched");

  // --- auto-switch on/off from the menu, then threshold 85 and custom 72
  pickQueue.push(byLabel("Auto-switch is OFF"));
  await registered["claudeAccounts.pick"]();
  assert.ok(calls().includes("acct auto on"), "menu toggles auto on");
  pickQueue.push(byLabel("Switch when"), byLabel("85%"));
  await registered["claudeAccounts.pick"]();
  assert.ok(calls().includes("acct auto threshold 85"), "threshold from menu");
  pickQueue.push(byLabel("Other"));
  inputQueue.push("72");
  await registered["claudeAccounts.setThreshold"]();
  assert.ok(calls().includes("acct auto threshold 72"), "custom threshold");

  // --- per-account: own limit 100, back to default, keep out, forget (confirmed)
  pickQueue.push(byLabel("Per-account"), byAccount("c@x.com"), byLabel("Own auto-switch limit"), byLabel("100%"));
  await registered["claudeAccounts.pick"]();
  assert.ok(calls().includes("acct auto threshold 100 --account c@x.com"), "per-account limit");
  pickQueue.push(byAccount("c@x.com"), byLabel("Own auto-switch limit"), byLabel("Use the default"));
  await registered["claudeAccounts.accountSettings"]();
  assert.ok(calls().includes("acct auto threshold --unset --account c@x.com"), "per-account unset");
  pickQueue.push(byAccount("c@x.com"), byLabel("Auto-switch may use it"));
  await registered["claudeAccounts.accountSettings"]();
  assert.ok(calls().includes("acct disable c@x.com"), "keep out of auto-switch");
  setConf({ disabled: ["c@x.com"] });
  pickQueue.push(byAccount("c@x.com"), byLabel("Kept out"));
  await registered["claudeAccounts.accountSettings"]();
  assert.ok(calls().includes("acct enable c@x.com"), "allow again");
  pickQueue.push(byAccount("d@x.com"), byLabel("Forget"));
  warnQueue.push(undefined); // cancelled
  await registered["claudeAccounts.accountSettings"]();
  assert.ok(!calls().includes("acct remove d@x.com"), "forget needs confirmation");
  pickQueue.push(byAccount("d@x.com"), byLabel("Forget"));
  warnQueue.push("Forget");
  await registered["claudeAccounts.accountSettings"]();
  assert.ok(calls().includes("acct remove d@x.com"), "forget after confirmation");

  // --- run in terminal
  pickQueue.push(byLabel("Run Claude in a new terminal"), byAccount("c@x.com"));
  await registered["claudeAccounts.pick"]();
  assert.deepStrictEqual(shown.terminal.shellArgs, ["run", "c@x.com"]);
  assert.strictEqual(shown.terminal.cwd, proj);

  // --- map this folder, then unmap
  pickQueue.push(byLabel("This folder: no account mapped"), byAccount("c@x.com"));
  await registered["claudeAccounts.pick"]();
  assert.ok(calls().includes(`acct map c@x.com ${proj}`), "map folder");
  setConf({ maps: { [path.dirname(proj)]: "c@x.com" } });
  pickQueue.push(byLabel("This folder: uses c"), byLabel("Unmap"));
  await registered["claudeAccounts.pick"]();
  assert.ok(calls().includes(`acct unmap ${path.dirname(proj)}`), "unmap the mapped parent");

  // --- wrapper needs confirmation, offers reload
  pickQueue.push(byLabel("VS Code panel follows folder maps: OFF"));
  warnQueue.push(undefined);
  await registered["claudeAccounts.pick"]();
  assert.ok(!calls().includes("acct wrapper on"), "wrapper not turned on without confirmation");
  warnQueue.push("Turn on");
  await registered["claudeAccounts.toggleWrapper"]();
  assert.ok(calls().includes("acct wrapper on"), "wrapper on after confirmation");

  // --- sessions, help, add
  pickQueue.push(byLabel("Show parallel sessions"));
  await registered["claudeAccounts.pick"]();
  assert.ok(shown.out.includes("b@x.com running"), "sessions in output panel");
  await registered["claudeAccounts.help"]();
  assert.ok(shown.out.includes("HELP auto") && shown.out.includes("HELP parallel"), "help in output panel");
  pickQueue.push(byLabel("Add an account"));
  await registered["claudeAccounts.pick"]();
  assert.ok(shown.info.some((m) => m.includes("/login")), "add account explains /login");

  // --- auto-switch notification
  fs.writeFileSync(path.join(store, ".auto-state"),
    JSON.stringify({ lastEvent: { at: Date.now() / 1000 + 5, from: "a@x.com", to: "c@x.com", reason: "is at 96%" } }));
  await sleep(4500); // watchFile polls every 2 s
  assert.ok(shown.info.some((m) => m.includes("a is at 96%, now using c")), "auto-switch notification");

  // --- coming back to the window never reads the network
  const statusCalls = () => calls().split("\n").filter((l) => l.startsWith("status"));
  const before = statusCalls().length;
  windowStateCb({ focused: true });
  await sleep(300);
  assert.strictEqual(statusCalls().length, before, "focus does not read usage");

  // --- the refresh command asks for a fresh reading; a login change only for cached ones
  await registered["claudeAccounts.refresh"]();
  assert.ok(statusCalls().pop().includes("--json --fresh"), "refresh button = --fresh");
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ changed: Date.now() }));
  await sleep(4500);
  assert.ok(statusCalls().pop().includes("--json --cached"), "login change = cached, no request");

  // --- a reading shared by a hook / the terminal shows up without running anything
  const n0 = statusCalls().length;
  fs.writeFileSync(path.join(store, ".usage-cache"), JSON.stringify({ at: Date.now(), rows: rows.map((r, i) =>
    i === 0 ? { ...r, limits: [{ label: "5h", percent: 61, resets_at: null }, { label: "week", percent: 40, resets_at: null }] } : r) }));
  await sleep(4500);
  assert.ok(item.text.includes("5h 61%"), "shared reading picked up");
  assert.strictEqual(statusCalls().length, n0, "...without running the status script");

  // --- rate limited: claude-acct-status returns the last numbers marked stale; it is explained
  rows[0].stale = true;
  rows[0].blockedUntil = Date.now() + 5 * 60000;
  writeStatus();
  await registered["claudeAccounts.refresh"]();
  assert.ok(String(item.tooltip.value).includes("Anthropic asked to pause usage checks"), "explained in the tooltip");
  delete rows[0].stale;
  delete rows[0].blockedUntil;
  writeStatus();

  // --- red at 95%+, missing script explained
  rows[0].limits[0].percent = 97;
  writeStatus();
  await registered["claudeAccounts.refresh"]();
  assert.strictEqual(item.backgroundColor.id, "statusBarItem.errorBackground", "95%+ is red");
  fs.unlinkSync(path.join(bin, "claude-acct-status"));
  rows.length = 0;
  await registered["claudeAccounts.refresh"]();
  assert.ok(String(item.tooltip.value || item.tooltip).includes("Claude accounts") || String(item.tooltip).includes("not found"), "no crash");

  // --- the popup window
  assert.strictEqual(item.command, "claudeAccounts.open", "status bar click opens the window");
  rows.push({ name: "a@x.com", email: "a@x.com", plan: "team", active: true, session: false, error: null,
    limits: [{ label: "5h", percent: 20, resets_at: null }, { label: "week", percent: 40, resets_at: null }] });
  rows.push({ name: "b@x.com", email: "b@x.com", plan: "pro", active: false, session: true, error: null,
    limits: [{ label: "5h", percent: 0, resets_at: null }, { label: "week", percent: 10, resets_at: null }] });
  rows.push({ name: "d@x.com", email: "d@x.com", plan: "max", active: false, session: false, error: "token rejected", limits: [] });
  rows.push({ name: "c@x.com", email: "c@x.com", plan: "max", active: false, session: false, error: null,
    limits: [{ label: "5h", percent: 5, resets_at: null }, { label: "week", percent: 20, resets_at: null }] });
  writeStatus();
  await registered["claudeAccounts.refresh"]();
  await registered["claudeAccounts.open"]();
  const p = panel;
  assert.ok(/default-src 'none'/.test(p.webview.html) && /script-src 'nonce-[A-Za-z0-9]+'/.test(p.webview.html), "strict CSP");
  assert.ok(p.webview.html.includes("/ext/media/popup.js") && p.webview.html.includes("/ext/media/popup.css"));
  const say = async (m) => { p.posted.length = 0; await p.handlers.msg(m); await sleep(50); };
  const lastToast = () => [...p.posted].reverse().find((m) => m.type === "toast");
  await say({ type: "ready" });
  const st = p.posted.find((m) => m.type === "state");
  assert.ok(st && st.focus && st.state.rows.length >= 3, "state sent on ready");
  assert.strictEqual(st.state.suggested, "c@x.com", "suggests the account with most usage left (not active/session/error)");
  assert.strictEqual(st.state.folder, proj);
  await say({ type: "switch", name: "c@x.com" });
  assert.ok(calls().includes("acct use c@x.com") && lastToast().ok, "switch from the window");
  assert.ok(!shown.info.some((m) => m.includes("Claude now sends requests")), "no extra notification after a switch");
  await say({ type: "switch", name: "evil; rm -rf /" });
  assert.ok(!calls().includes("evil"), "unknown names are ignored");
  await say({ type: "threshold", value: 77 });
  assert.ok(calls().includes("acct auto threshold 77"), "global limit");
  await say({ type: "threshold", value: 30 });
  assert.ok(!calls().includes("acct auto threshold 30") && lastToast().ok === false, "bad limit refused");
  await say({ type: "threshold", name: "c@x.com", value: 100 });
  assert.ok(calls().includes("acct auto threshold 100 --account c@x.com"));
  await say({ type: "threshold", name: "c@x.com", unset: true });
  assert.ok(calls().split("\n").filter((l) => l === "acct auto threshold --unset --account c@x.com").length >= 1);
  await say({ type: "acctAuto", name: "c@x.com", on: false });
  assert.ok(calls().includes("acct disable c@x.com"));
  await say({ type: "auto", on: false });
  assert.ok(calls().includes("acct auto off"));
  await say({ type: "map", name: "c@x.com" });
  assert.ok(calls().includes(`acct map c@x.com ${proj}`));
  await say({ type: "remove", name: "c@x.com" });
  assert.ok(calls().includes("acct remove c@x.com"));
  await say({ type: "wrapper", on: true });
  assert.ok(calls().split("\n").filter((l) => l === "acct wrapper on").length >= 2);
  await say({ type: "refresh" });
  const states = p.posted.filter((m) => m.type === "state");
  assert.ok(states.length && states[states.length - 1].state.busy === false, "spinner stops after a refresh");
  assert.ok(calls().split("\n").filter((l) => l.startsWith("status")).pop().includes("--fresh"), "window refresh button = --fresh");
  const sinceReady = calls().split("\n").filter((l) => l.startsWith("status")).length;
  await say({ type: "ready" });
  await sleep(200);
  const afterReady = calls().split("\n").filter((l) => l.startsWith("status")).slice(sinceReady);
  assert.ok(afterReady.some((l) => /status\s+--json$/.test(l)), "opening = normal read");
  await say({ type: "help" });
  assert.ok(p.posted.some((m) => m.type === "help" && m.text.includes("HELP parallel")), "help text sent");
  await say({ type: "terminal", name: "c@x.com" });
  assert.deepStrictEqual(shown.terminal.shellArgs, ["run", "c@x.com"]);
  // re-opening while open just reveals it; clicking elsewhere closes it
  await registered["claudeAccounts.open"]();
  assert.ok(p.revealed && panel === p, "single window");
  p.handlers.view({ webviewPanel: Object.assign(p, { active: false }) });
  assert.ok(p.disposed, "closes when it loses focus");
  await registered["claudeAccounts.open"]();
  assert.ok(panel !== p, "opens fresh after closing");
  await panel.handlers.msg({ type: "close" });
  assert.ok(panel.disposed, "close button / Esc / backdrop closes it");

  // --- another machine: export settings, export logins (encrypted), import
  dialogQueue.push({ fsPath: path.join(home, "s.json") });
  await registered["claudeAccounts.exportSettings"]();
  assert.ok(calls().includes(`acct export -o ${path.join(home, "s.json")}`), "export settings");
  pickQueue.push((items) => items.filter((i) => i.row && ["a@x.com", "c@x.com"].includes(i.row.name)));
  inputQueue.push("secret123", "secret123");
  dialogQueue.push({ fsPath: path.join(home, "l.cma") });
  await registered["claudeAccounts.exportLogins"]();
  const exp = calls().split("\n").find((l) => l.startsWith("acct export --with-logins"));
  assert.ok(exp && exp.includes("--account a@x.com --account c@x.com") && exp.endsWith(`-o ${path.join(home, "l.cma")}`), "export picked logins");
  assert.ok(calls().includes("pw=secret123"), "password passed in the environment, not on the command line");
  assert.ok(!exp.includes("secret123"), "password not in argv");
  pickQueue.push((items) => items.slice(0, 1));
  inputQueue.push("secret123", "different1");
  const before2 = calls().split("\n").filter((l) => l.startsWith("acct export --with-logins")).length;
  await registered["claudeAccounts.exportLogins"]();
  assert.strictEqual(calls().split("\n").filter((l) => l.startsWith("acct export --with-logins")).length, before2, "mismatched passwords export nothing");
  const enc = path.join(home, "in.cma");
  fs.writeFileSync(enc, "Salted__xxxxxxxx");
  dialogQueue.push([{ fsPath: enc }]);
  inputQueue.push("pw4import");
  await registered["claudeAccounts.import"]();
  assert.ok(calls().includes(`acct import ${enc}`) && calls().includes("pw=pw4import"), "encrypted import asks the password");
  assert.ok(shown.out.includes("already saved here"), "import result shown");
  const plain = path.join(home, "in.json");
  fs.writeFileSync(plain, "{}");
  const pwLines = calls().split("\n").filter((l) => l.startsWith("pw=")).length;
  dialogQueue.push([{ fsPath: plain }]);
  await registered["claudeAccounts.import"]();
  assert.strictEqual(calls().split("\n").filter((l) => l.startsWith("pw=")).length, pwLines, "plain file: no password asked");

  for (const d of ctx.subscriptions) d.dispose && d.dispose();
  fs.rmSync(home, { recursive: true, force: true });
  console.log("extension smoke test: all checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
