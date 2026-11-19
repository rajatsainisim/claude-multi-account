// Claude accounts popup (webview). Renders the state the extension posts and sends back actions.
// Nothing here touches tokens: every change is a message that the extension turns into a
// `claude-acct` command.
(function () {
  "use strict";
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const $ = (sel, root = document) => root.querySelector(sel);
  const send = (type, data = {}) => vscode.postMessage({ type, ...data });

  let state = null;
  let selected = null; // account name whose row is open
  let confirming = null; // account name waiting for "Forget" confirmation
  let wrapperAsk = false;
  let customFor = null; // "*" (all accounts) or an account name: show the "other value" box
  let helpText = null;
  let toastTimer;

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lim = (r, label) => (r.limits || []).find((l) => l.label === label) || null;
  const pct = (r, label) => Math.round((lim(r, label) || {}).percent || 0);
  const peak = (r) => Math.max(pct(r, "5h"), pct(r, "week"));
  const user = (email) => String(email || "").split("@")[0];
  const limitFor = (name) => (state.conf.thresholds[name] != null ? state.conf.thresholds[name] : state.conf.auto.threshold);

  function resetText(iso) {
    if (!iso) return "not started";
    const t = new Date(iso);
    const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
    const left = mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
      : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const today = t.toDateString() === new Date().toDateString();
    const day = today ? "" : t.toLocaleDateString(undefined, { weekday: "short" }) + " ";
    return `${day}${t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}, in ${left}`;
  }

  function ago(ms) {
    if (ms == null || !isFinite(ms)) return "not read yet";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    return `${Math.round(s / 60)} min ago`;
  }

  // ---------------------------------------------------------------- render pieces
  function gauge(name, r, label, limitPct) {
    const p = pct(r, label);
    const heat = p >= 95 ? "hot" : p >= 80 ? "warm" : "";
    const l = lim(r, label);
    const mark = limitPct < 100 ? `<span class="limit-mark" style="left:${limitPct}%" title="Auto-switch at ${limitPct}%"></span>` : "";
    return `<div class="gauge">
        <span class="gauge-name">${name}</span>
        <div class="track" role="meter" aria-label="${name} usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}">
          <div class="fill ${heat}" style="width:${Math.min(100, p)}%"></div>${mark}
        </div>
        <span class="gauge-pct">${p}%</span>
        <span class="gauge-reset" title="${l && l.resets_at ? "Resets " + esc(resetText(l.resets_at)) : "The window starts with the first message"}">${esc(resetText(l && l.resets_at))}</span>
      </div>`;
  }

  function limitOptions(current, includeDefault) {
    const values = [80, 85, 90, 95, 100];
    if (current != null && !values.includes(current)) values.push(current);
    values.sort((a, b) => a - b);
    let html = includeDefault ? `<option value="default"${includeDefault === "selected" ? " selected" : ""}>Default (${state.conf.auto.threshold}%)</option>` : "";
    for (const v of values) {
      const text = v === 100 ? "100% (only when the limit is hit)" : `${v}%`;
      html += `<option value="${v}"${includeDefault !== "selected" && v === current ? " selected" : ""}>${text}</option>`;
    }
    return html + `<option value="custom">Other value…</option>`;
  }

  function row(r) {
    const c = state.conf;
    const isSel = selected === r.name;
    const disabled = c.disabled.includes(r.name);
    const own = c.thresholds[r.name];
    const chips = [];
    if (r.active) chips.push(`<span class="chip">In use</span>`);
    else if (r.name === state.suggested) chips.push(`<span class="chip best">Most usage left</span>`);
    if (r.session) chips.push(`<span class="chip session">Running in a terminal</span>`);
    if (disabled) chips.push(`<span class="chip off">Auto-switch skips it</span>`);
    if (r.error) chips.push(`<span class="chip err">Needs attention</span>`);
    if (r.stale) chips.push(`<span class="chip off" title="Anthropic limited usage checks; these are the last numbers read">Last reading</span>`);
    const lp = limitFor(r.name);
    const body = r.error
      ? `<div class="err-text">${esc(r.error)}. Log in to this account with /login, then it is saved again.</div>`
      : `<div class="gauges">${gauge("5-hour", r, "5h", lp)}${gauge("Weekly", r, "week", lp)}</div>`;
    const canUse = !r.active && !r.session;
    const confirm = confirming === r.name
      ? `<div class="confirm">Forget ${esc(r.email)} on this machine? A backup is kept; nothing is logged out.
           <span class="spacer"></span>
           <button class="btn" data-act="forget-cancel">Keep it</button>
           <button class="btn danger" data-act="forget-yes" data-name="${esc(r.name)}">Forget</button></div>`
      : "";
    return `<li class="acct${isSel ? " selected" : ""}${r.active ? " active" : ""}" data-name="${esc(r.name)}"
               tabindex="0" role="radio" aria-checked="${r.active}" aria-expanded="${isSel}">
        <span class="radio" aria-hidden="true"></span>
        <div class="acct-top">
          <span class="email">${esc(r.email)}</span>
          ${r.plan ? `<span class="plan">${esc(r.plan)}</span>` : ""}
          <span class="chips">${chips.join("")}</span>
        </div>
        ${body}
        <div class="actions">
          <div class="action-row">
            ${r.active ? `<span class="in-use-note">Claude uses this account now.</span>`
              : `<button class="btn primary" data-act="switch" data-name="${esc(r.name)}" ${canUse ? "" : "disabled"}>Use this account</button>`}
            <button class="btn" data-act="terminal" data-name="${esc(r.name)}">Open in a terminal</button>
            <span class="spacer"></span>
            ${confirming === r.name ? "" : `<button class="btn link" data-act="forget" data-name="${esc(r.name)}">Forget…</button>`}
          </div>
          <div class="action-row">
            <span class="setting">Switch away at
              <select class="select" data-act="acct-limit" data-name="${esc(r.name)}" aria-label="Auto-switch limit for ${esc(r.email)}">
                ${limitOptions(own, own == null ? "selected" : true)}
              </select>
            </span>
            ${customBox(r.name, limitFor(r.name))}
            <span class="setting">Auto-switch may use it
              <button class="switch" role="switch" aria-checked="${!disabled}" data-act="acct-auto" data-name="${esc(r.name)}"
                aria-label="Auto-switch may use ${esc(r.email)}"></button>
            </span>
          </div>
          ${confirm}
          ${r.session ? `<p class="note">It is running in a terminal or a mapped folder, so the main login cannot switch to it until that ends.</p>` : ""}
        </div>
      </li>`;
  }

  function parallelSection() {
    const c = state.conf;
    const folder = state.folder;
    const here = state.here;
    const sessions = state.rows.filter((r) => r.session);
    let folderLine = "";
    if (folder) {
      const opts = [`<option value="">The main login (no mapping)</option>`]
        .concat(state.rows.map((r) => `<option value="${esc(r.name)}"${here && here.account === r.name ? " selected" : ""}>${esc(r.email)}</option>`));
      folderLine = `<div class="line">
          <span class="label">This folder uses
            <small>${esc(here ? here.folder : folder)}${here && here.folder !== folder ? " (mapped parent folder)" : ""}</small></span>
          <select class="select" data-act="map" aria-label="Account for this folder">${opts.join("")}</select>
        </div>`;
    }
    const wrapperWarn = wrapperAsk ? `<div class="warn-box">
        Turning this on affects every VS Code window on this machine:
        <ul>
          <li>The Claude extension then starts chats in the "default" permission mode, so your own default mode is set for it too.</li>
          <li>The extension turns off its own process tracking, telemetry and update check.</li>
          <li>Folders without a mapping work as before. Turning it off removes exactly what was added.</li>
        </ul>
        <button class="btn primary" data-act="wrapper-yes">Turn it on</button>
        <button class="btn" data-act="wrapper-cancel">Cancel</button>
      </div>` : "";
    return `<section class="section">
        <h2>Accounts side by side</h2>
        <p>Run Claude as another account in a terminal while the panel keeps its own, or tie a folder to an account.</p>
        ${folderLine}
        <div class="line">
          <span class="label">The Claude panel follows folder mappings
            <small>Experimental. Reload the window after changing it.</small></span>
          <button class="switch" role="switch" aria-checked="${!!c.wrapper.enabled}" data-act="wrapper" aria-label="Claude panel follows folder mappings"></button>
        </div>
        ${wrapperWarn}
        ${sessions.length ? `<ul class="sessions">${sessions.map((r) => `<li>${esc(r.email)} is running in a terminal</li>`).join("")}</ul>` : ""}
      </section>`;
  }

  function machineSection() {
    return `<section class="section">
        <h2>Another machine</h2>
        <p>Settings only is the safest: the other machine then logs in to each account itself.
           A file with logins is encrypted with a password; if both machines keep using the same login, one is logged out
           when the other refreshes it. To hand a login over for good, use <code>claude-acct move</code> in a terminal.</p>
        <div class="action-row">
          <button class="btn" data-act="export-settings">Export settings</button>
          <button class="btn" data-act="export-logins">Export with logins…</button>
          <button class="btn" data-act="import">Import…</button>
        </div>
      </section>`;
  }

  function moreSection() {
    return `<section class="section">
        <details>
          <summary>Add an account</summary>
          <ol>
            <li>In Claude Code, run <code>/login</code> and sign in with the new account. Do not log out first.</li>
            <li>Send one message. The new account is saved by itself and shows up here.</li>
          </ol>
        </details>
        <details data-act="help-open"${helpText ? " open" : ""}>
          <summary>All commands</summary>
          <p>Everything here also works in a terminal with <code>claude-acct</code>. Shortcuts: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> opens this window,
             <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> runs Claude in a terminal as an account.</p>
          ${helpText ? `<pre class="help">${esc(helpText)}</pre>` : `<p>Loading…</p>`}
        </details>
      </section>`;
  }

  function render() {
    const app = $("#app");
    if (!state) {
      app.innerHTML = `<div class="head"><div class="head-title"><h1>Claude accounts</h1><p>Reading usage…</p></div></div>`;
      return;
    }
    const c = state.conf;
    const active = state.rows.find((r) => r.active);
    const keepScroll = $(".body") ? $(".body").scrollTop : 0;
    const focusedName = document.activeElement && document.activeElement.closest && document.activeElement.closest(".acct")
      ? document.activeElement.closest(".acct").dataset.name : null;
    const sub = active
      ? `Using <strong>${esc(active.email)}</strong>, updated ${ago(state.activeAge)}`
      : `The current login is not saved yet. Send one message in Claude, then it appears here.`;
    app.innerHTML = `
      <header class="head">
        <div class="head-title"><h1 id="title">Claude accounts</h1><p>${sub}</p></div>
        <div class="head-controls">
          <div class="auto${c.auto.enabled ? " on" : ""}">
            <label for="auto-switch">Auto-switch</label>
            <button id="auto-switch" class="switch" role="switch" aria-checked="${c.auto.enabled}" data-act="auto"></button>
            <select class="select" data-act="limit" aria-label="Switch away when usage reaches">${limitOptions(c.auto.threshold, false)}</select>
          </div>
          ${customBox("*", c.auto.threshold)}
          <button class="icon-btn${state.busy ? " spinning" : ""}" data-act="refresh" title="Refresh usage" aria-label="Refresh usage">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
          </button>
        </div>
        <button class="icon-btn close" data-act="close" title="Close (Esc)" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>
      ${state.error ? `<div class="notice">${esc(state.error)}</div>` : ""}
      <div class="body">
        <ul class="accounts" role="radiogroup" aria-labelledby="title">${state.rows.map(row).join("")}</ul>
        ${parallelSection()}
        ${machineSection()}
        ${moreSection()}
      </div>
      <footer class="foot">Click outside or press Esc to close. Usage is read when this window opens and when you press refresh.</footer>`;
    $(".body").scrollTop = keepScroll;
    if (focusedName) {
      const el = document.querySelector(`.acct[data-name="${CSS.escape(focusedName)}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function toast(text, ok) {
    const t = $("#toast");
    t.textContent = text;
    t.className = `toast ${ok ? "ok" : "bad"}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4200);
  }

  // ---------------------------------------------------------------- events
  function customBox(key, current) {
    if (customFor !== key) return "";
    return `<span class="setting custom">
        <input class="num" type="number" min="50" max="100" step="1" value="${current}" data-custom="${esc(key)}"
          aria-label="Switch away at this percent" />%
        <button class="btn" data-act="custom-save" data-key="${esc(key)}">Save</button>
        <button class="btn link" data-act="custom-cancel">Cancel</button>
      </span>`;
  }

  function saveCustom(key) {
    const input = document.querySelector(`input[data-custom="${CSS.escape(key)}"]`);
    const n = Number(input && input.value);
    if (!Number.isInteger(n) || n < 50 || n > 100) return toast("Use a whole number from 50 to 100.", false);
    customFor = null;
    if (key === "*") send("threshold", { value: n });
    else send("threshold", { name: key, value: n });
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) {
      if (!e.target.closest(".sheet")) send("close"); // click on the backdrop
      const acct = e.target.closest(".acct");
      if (acct && selected !== acct.dataset.name) {
        selected = acct.dataset.name;
        confirming = null;
        render();
      }
      return;
    }
    const act = el.dataset.act;
    const name = el.dataset.name;
    if (el.tagName === "SELECT" || act === "help-open") return; // handled on change / toggle
    e.preventDefault();
    switch (act) {
      case "close": return send("close");
      case "refresh": return send("refresh");
      case "auto": return send("auto", { on: el.getAttribute("aria-checked") !== "true" });
      case "switch": return send("switch", { name });
      case "terminal": return send("terminal", { name });
      case "acct-auto": return send("acctAuto", { name, on: el.getAttribute("aria-checked") !== "true" });
      case "forget": confirming = name; return render();
      case "forget-cancel": confirming = null; return render();
      case "forget-yes": confirming = null; return send("remove", { name });
      case "wrapper":
        if (state.conf.wrapper.enabled) return send("wrapper", { on: false });
        wrapperAsk = true;
        return render();
      case "wrapper-yes": wrapperAsk = false; return send("wrapper", { on: true });
      case "wrapper-cancel": wrapperAsk = false; return render();
      case "export-settings": return send("exportSettings");
      case "export-logins": return send("exportLogins");
      case "import": return send("import");
      case "custom-save": return saveCustom(el.dataset.key);
      case "custom-cancel": customFor = null; return render();
    }
  });

  document.addEventListener("change", (e) => {
    const el = e.target;
    const act = el.dataset && el.dataset.act;
    if (act === "limit") {
      if (el.value === "custom") { customFor = "*"; return render(); }
      send("threshold", { value: Number(el.value) });
    } else if (act === "acct-limit") {
      const name = el.dataset.name;
      if (el.value === "default") return send("threshold", { name, unset: true });
      if (el.value === "custom") { customFor = name; return render(); }
      send("threshold", { name, value: Number(el.value) });
    } else if (act === "map") {
      send("map", { name: el.value || null });
    }
  });

  document.addEventListener("toggle", (e) => {
    if (e.target.dataset && e.target.dataset.act === "help-open" && e.target.open && !helpText) send("help");
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset && e.target.dataset.custom) {
      e.preventDefault();
      return saveCustom(e.target.dataset.custom);
    }
    if (e.key === "Escape") {
      if (confirming || wrapperAsk || customFor) {
        confirming = null;
        wrapperAsk = false;
        customFor = null;
        return render();
      }
      return send("close");
    }
    const acct = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("acct")
      ? document.activeElement : null;
    if (!acct) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...document.querySelectorAll(".acct")];
      const next = all[(all.indexOf(acct) + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length];
      next.focus();
    } else if (e.key === " ") {
      e.preventDefault();
      selected = acct.dataset.name;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = state.rows.find((x) => x.name === acct.dataset.name);
      if (r && !r.active && !r.session) send("switch", { name: r.name });
      else { selected = acct.dataset.name; render(); }
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "state") {
      state = m.state;
      if (selected == null || !state.rows.some((r) => r.name === selected)) {
        const active = state.rows.find((r) => r.active);
        selected = active ? active.name : state.rows[0] && state.rows[0].name;
      }
      render();
      if (m.focus) {
        const first = $(".acct.active") || $(".acct");
        if (first) first.focus({ preventScroll: true });
      }
    } else if (m.type === "toast") {
      toast(m.text, m.ok);
    } else if (m.type === "help") {
      helpText = m.text;
      render();
    }
  });

  render();
  send("ready");
})();
