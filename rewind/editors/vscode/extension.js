// Rewind for VS Code: opens the code map inside the editor and drives the
// rewind CLI (steps, restore, recording, watching). No dependencies.
"use strict";

const vscode = require("vscode");
const cp = require("child_process");

const maps = new Map(); // repo root -> { proc, port, panel }
let watcher = null;
let status;
let output;

function exe() {
  return vscode.workspace.getConfiguration("rewind").get("path") || "rewind";
}

function root() {
  const doc = vscode.window.activeTextEditor?.document;
  const folder = (doc && vscode.workspace.getWorkspaceFolder(doc.uri)) || vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    cp.execFile(exe(), args, { cwd, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === "ENOENT"
          ? `Could not find "${exe()}". Install rewind or set "rewind.path" in your settings.`
          : (stderr || err.message).trim();
        reject(new Error(msg));
      } else resolve(stdout);
    });
  });
}

function needRoot() {
  const r = root();
  if (!r) vscode.window.showWarningMessage("Open a folder that is a Git repository to use Rewind.");
  return r;
}

// ---------------------------------------------------------------- code map

async function openMap() {
  const cwd = needRoot();
  if (!cwd) return;
  let m = maps.get(cwd);
  if (m?.panel) { m.panel.reveal(); return; }
  if (!m) {
    m = await startServer(cwd).catch((e) => { vscode.window.showErrorMessage(`Rewind: ${e.message}`); return null; });
    if (!m) return;
    maps.set(cwd, m);
  }
  const panel = vscode.window.createWebviewPanel("rewindMap", `Rewind Map`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    portMapping: [{ webviewPort: m.port, extensionHostPort: m.port }],
  });
  m.panel = panel;
  const url = `http://localhost:${m.port}/`;
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:${m.port}; style-src 'unsafe-inline'">
<style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;overflow:hidden;background:transparent}</style></head>
<body><iframe src="${url}" title="Rewind map"></iframe></body></html>`;
  panel.onDidDispose(() => {
    m.panel = null;
    m.proc.kill();
    maps.delete(cwd);
  });
}

function startServer(cwd) {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(exe(), ["map", "--no-open", "--addr", "127.0.0.1:0"], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    let buf = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("the map server did not start")); }, 15000);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? `Could not find "${exe()}". Install rewind or set "rewind.path".` : e.message));
    });
    proc.stderr.on("data", (d) => log(d.toString()));
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const match = buf.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve({ proc, port: +match[1], panel: null }); }
    });
    proc.on("exit", (code) => { clearTimeout(timer); if (code) reject(new Error(`rewind map exited with code ${code}`)); });
  });
}

// ---------------------------------------------------------------- steps

async function steps() {
  const cwd = needRoot();
  if (!cwd) return;
  let data;
  try { data = JSON.parse(await run(["log", "--json"], cwd)); }
  catch (e) { vscode.window.showInformationMessage(`Rewind: ${e.message}`); return; }
  const items = [...data.steps].reverse().map((s) => ({
    label: `Step ${s.step}`,
    description: s.summary,
    detail: [s.kind, new Date(s.time * 1000).toLocaleTimeString(), s.prompt ? `“${s.prompt.replace(/\s+/g, " ").slice(0, 100)}”` : ""].filter(Boolean).join(" · "),
    step: s.step,
  }));
  const pick = await vscode.window.showQuickPick(items, { title: `Rewind · ${data.session}`, placeHolder: "Pick a step", matchOnDescription: true, matchOnDetail: true });
  if (!pick) return;
  const action = await vscode.window.showQuickPick([
    { label: "$(diff) Show what this step changed", id: "show" },
    { label: "$(type-hierarchy) Open the code map", id: "map" },
    { label: "$(history) Restore my files to this step…", id: "restore" },
  ], { title: `Step ${pick.step}: ${pick.description}` });
  if (!action) return;
  try {
    if (action.id === "show") {
      const text = await run(["show", String(pick.step), "-p"], cwd);
      const doc = await vscode.workspace.openTextDocument({ content: text, language: "diff" });
      await vscode.window.showTextDocument(doc, { preview: true });
    } else if (action.id === "map") {
      await openMap();
    } else {
      const plan = await run(["restore", "-n", String(pick.step)], cwd);
      const files = plan.trim().split("\n").filter((l) => l.trim()).length;
      const ok = await vscode.window.showWarningMessage(
        `Restore step ${pick.step}? This changes ${files} file${files === 1 ? "" : "s"} in your working folder. Your current files are saved as a new step first, so you can undo this.`,
        { modal: true, detail: plan.trim() }, "Restore");
      if (ok !== "Restore") return;
      await run(["restore", String(pick.step)], cwd);
      vscode.window.showInformationMessage(`Rewind: restored step ${pick.step}.`);
      refreshStatus();
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Rewind: ${e.message}`);
  }
}

// ---------------------------------------------------------------- recording

async function record() {
  const cwd = needRoot();
  if (!cwd) return;
  const picks = await vscode.window.showQuickPick([
    { label: "Claude Code", id: "claude", picked: true },
    { label: "OpenAI Codex CLI", id: "codex" },
    { label: "Gemini CLI", id: "gemini" },
    { label: "Cursor", id: "cursor" },
  ], { canPickMany: true, title: "Record sessions from which agents?", placeHolder: "Rewind adds its hooks to each agent's project settings" });
  if (!picks?.length) return;
  try {
    let out = "";
    for (const p of picks) out += await run(["init", p.id], cwd);
    log(out);
    vscode.window.showInformationMessage(`Rewind is recording ${picks.map((p) => p.label).join(", ")} sessions in this repository.`, "Show details")
      .then((c) => c && output.show());
  } catch (e) {
    vscode.window.showErrorMessage(`Rewind: ${e.message}`);
  }
}

function toggleWatch() {
  if (watcher) {
    watcher.kill();
    watcher = null;
    vscode.window.showInformationMessage("Rewind stopped watching.");
    refreshStatus();
    return;
  }
  const cwd = needRoot();
  if (!cwd) return;
  watcher = cp.spawn(exe(), ["watch"], { cwd, env: { ...process.env, NO_COLOR: "1" } });
  watcher.stdout.on("data", (d) => { log(d.toString()); refreshStatus(); });
  watcher.stderr.on("data", (d) => log(d.toString()));
  watcher.on("error", (e) => { vscode.window.showErrorMessage(`Rewind: ${e.message}`); watcher = null; refreshStatus(); });
  watcher.on("exit", () => { watcher = null; refreshStatus(); });
  vscode.window.showInformationMessage("Rewind is watching this folder: every change is recorded as a step once your files settle.");
  refreshStatus();
}

// ---------------------------------------------------------------- status bar

async function refreshStatus() {
  const cwd = root();
  if (!cwd || !status) return;
  let text = "$(history) Rewind";
  let tip = "Open the Rewind code map";
  try {
    const data = JSON.parse(await run(["log", "--json"], cwd));
    const last = data.steps[data.steps.length - 1];
    text = `$(history) ${data.session} · step ${last.step}`;
    tip = `Rewind: ${data.steps.length} steps. Last: ${last.summary}. Click to open the map.`;
  } catch (e) { /* no session yet */ }
  if (watcher) text = "$(eye) " + text.replace("$(history) ", "");
  status.text = text;
  status.tooltip = tip;
  status.show();
}

function log(text) {
  output.append(text);
}

function activate(context) {
  output = vscode.window.createOutputChannel("Rewind");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "rewind.openMap";
  context.subscriptions.push(
    output, status,
    vscode.commands.registerCommand("rewind.openMap", openMap),
    vscode.commands.registerCommand("rewind.steps", steps),
    vscode.commands.registerCommand("rewind.record", record),
    vscode.commands.registerCommand("rewind.watch", toggleWatch),
    vscode.window.onDidChangeWindowState((s) => s.focused && refreshStatus()),
  );
  const timer = setInterval(refreshStatus, 10000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refreshStatus();
}

function deactivate() {
  for (const m of maps.values()) m.proc.kill();
  if (watcher) watcher.kill();
}

module.exports = { activate, deactivate };
