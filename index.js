"use strict";
const { app, BrowserWindow, ipcMain, session, nativeTheme, shell } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
app.commandLine.appendSwitch("remote-debugging-port", "0");
nativeTheme.themeSource = "dark";
const ipcRates = /* @__PURE__ */ new Map();
function rateOk(ch) {
  const now = Date.now();
  const e = ipcRates.get(ch) || { n: 0, reset: now + 1e3 };
  if (now > e.reset) {
    e.n = 0;
    e.reset = now + 1e3;
  }
  e.n++;
  ipcRates.set(ch, e);
  return e.n <= 100;
}
let mainWindow = null;
function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: "#04040a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  });
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; img-src 'self' data: blob: https: file:; media-src 'self' blob:;"
        ],
        "X-Content-Type-Options": ["nosniff"],
        "X-Frame-Options": ["SAMEORIGIN"]
      }
    });
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const ok = url.startsWith("http://localhost") || url.startsWith("file://");
    if (!ok) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
ipcMain.on("app:exit", () => {
  if (rateOk("app:exit")) app.quit();
});
ipcMain.on("app:minimize", () => {
  if (!rateOk("app:minimize") || !mainWindow) return;
  mainWindow.setFullScreen(false);
  mainWindow.minimize();
});
ipcMain.on("app:restore", () => {
  if (!mainWindow) return;
  mainWindow.restore();
  mainWindow.setFullScreen(true);
});
ipcMain.handle("app:getSystemInfo", async () => {
  if (!rateOk("sysinfo")) return null;
  const cpus = os.cpus();
  return {
    platform: process.platform,
    hostname: os.hostname(),
    username: os.userInfo().username,
    totalRam: Math.round(os.totalmem() / 1073741824),
    freeRam: Math.round(os.freemem() / 1073741824),
    cpuModel: cpus[0]?.model || "Unknown",
    cpuCount: cpus.length,
    arch: os.arch(),
    osRelease: os.release(),
    uptime: Math.floor(os.uptime() / 3600),
    homedir: os.homedir()
  };
});
ipcMain.handle("fs:scanDirectory", async (event, dirPath) => {
  if (!rateOk("scandir")) return [];
  const home = os.homedir();
  const resolved = path.resolve(dirPath || home);
  const allowed = [home, "/Applications", "/tmp", "/Users", "/"];
  if (!allowed.some((p) => resolved.startsWith(p))) return [];
  try {
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    const filtered = entries.filter((e) => !e.name.startsWith(".") || dirPath === home);
    return await Promise.all(filtered.map(async (e) => {
      let size = 0, modified = "";
      try {
        const s = await fs.promises.stat(path.join(resolved, e.name));
        size = s.size;
        modified = s.mtime.toISOString();
      } catch {
      }
      return {
        name: e.name,
        type: e.isDirectory() ? "folder" : "file",
        ext: path.extname(e.name).slice(1).toLowerCase(),
        size,
        modified,
        fullPath: path.join(resolved, e.name)
      };
    }));
  } catch {
    return [];
  }
});
ipcMain.handle("fs:readFile", async (event, filePath) => {
  if (!rateOk("readfile")) return null;
  const home = os.homedir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(home)) return null;
  try {
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 10 * 1024 * 1024) return null;
    return await fs.promises.readFile(resolved);
  } catch {
    return null;
  }
});
ipcMain.handle("proverbs:run", async (event, cmd) => {
  if (!rateOk("proverbs")) return "Rate limit exceeded";
  const safe = String(cmd || "").slice(0, 200).replace(/[;&|`$]/g, "");
  return new Promise((resolve) => {
    const args = safe.split(" ").filter(Boolean);
    const proc = spawn("node", ["index.js", ...args], {
      cwd: path.join(os.homedir(), "proverbs"),
      timeout: 1e4
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      out += d.toString();
    });
    proc.on("close", () => resolve(out || "(no output)"));
    proc.on("error", () => resolve("Proverbs CLI not found at ~/proverbs\nMake sure /Users/Stizzop/proverbs/index.js exists"));
    setTimeout(() => {
      proc.kill();
      resolve(out || "Command timed out after 9s");
    }, 9e3);
  });
});
ipcMain.handle("app:getVersion", () => app.getVersion());
ipcMain.handle("app:checkUpdate", async () => ({ available: false, version: app.getVersion(), notes: "" }));
ipcMain.handle("app:applyUpdate", async () => ({ scheduled: true }));
function parseBTJson(json) {
  try {
    const data = JSON.parse(json);
    const entry = (data.SPBluetoothDataType || [])[0] || {};
    const props = entry.controller_properties || {};
    const powered = props.controller_state === "attrib_enabled";
    const devices = [];
    const addDevices = (map, connected) => {
      for (const [name, info] of Object.entries(map || {})) {
        devices.push({
          name,
          address: info.device_address || "",
          connected,
          battery: info.device_batteryPercent || null,
          type: info.device_minorType || info.device_majorType || "Device"
        });
      }
    };
    addDevices(entry.device_connected, true);
    addDevices(entry.device_not_connected, false);
    return { powered, devices };
  } catch {
    return { powered: false, devices: [] };
  }
}
let _blueutilPath = void 0;
async function findBlueutil() {
  if (_blueutilPath !== void 0) return _blueutilPath;
  for (const p of ["/usr/local/bin/blueutil", "/opt/homebrew/bin/blueutil"]) {
    const { code } = await runCmd(p, ["--version"]);
    if (code === 0) {
      _blueutilPath = p;
      return p;
    }
  }
  _blueutilPath = null;
  return null;
}
ipcMain.handle("bt:status", async () => {
  const { out } = await runCmd("system_profiler", ["SPBluetoothDataType", "-json"], 1e4);
  const parsed = parseBTJson(out);
  const blueutilPath = await findBlueutil();
  return { ...parsed, hasBlueutil: !!blueutilPath };
});
ipcMain.handle("bt:toggle", async (event, on) => {
  const p = await findBlueutil();
  if (!p) return { ok: false, error: "blueutil not installed" };
  const { code } = await runCmd(p, ["-p", on ? "1" : "0"]);
  return { ok: code === 0 };
});
ipcMain.handle("bt:connect", async (event, address) => {
  const p = await findBlueutil();
  if (!p) return { ok: false, error: "blueutil not installed" };
  const { code, err } = await runCmd(p, ["--connect", address], 2e4);
  return { ok: code === 0, error: err };
});
ipcMain.handle("bt:disconnect", async (event, address) => {
  const p = await findBlueutil();
  if (!p) return { ok: false, error: "blueutil not installed" };
  const { code, err } = await runCmd(p, ["--disconnect", address], 1e4);
  return { ok: code === 0, error: err };
});
const _cache = /* @__PURE__ */ new Map();
function cached(key, ttlMs, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.val);
  return fn().then((val) => {
    _cache.set(key, { val, exp: Date.now() + ttlMs });
    return val;
  });
}
function parseIOReg(out) {
  const get = (key) => {
    const m = out.match(new RegExp(`"${key}"\\s*=\\s*(\\S+)`));
    return m ? m[1] : null;
  };
  const cycleCount = parseInt(get("CycleCount")) || null;
  const designCap = parseInt(get("DesignCapacity")) || null;
  const maxCap = parseInt(get("MaxCapacity")) || null;
  const tempRaw = parseInt(get("Temperature")) || null;
  return {
    cycleCount,
    healthPct: designCap && maxCap ? Math.round(maxCap / designCap * 100) : null,
    tempC: tempRaw ? (tempRaw / 10).toFixed(1) : null
  };
}
ipcMain.handle("battery:status", () => cached("battery", 5e3, async () => {
  const [pmOut, ioOut] = await Promise.all([
    runCmd("pmset", ["-g", "batt"]),
    runCmd("ioreg", ["-rn", "AppleSmartBattery"])
  ]);
  const m = pmOut.out.match(/(\d+)%;\s*([\w\s/]+?)(?:\s*;|$)/m);
  const timeM = pmOut.out.match(/(\d+:\d+)\s+remaining/);
  const onAC = pmOut.out.includes("'AC Power'");
  const extra = parseIOReg(ioOut.out);
  return {
    percentage: m ? parseInt(m[1]) : null,
    status: m ? m[2].trim() : "unknown",
    timeRemaining: timeM ? timeM[1] : null,
    onAC,
    ...extra
  };
}));
ipcMain.handle("volume:get", () => cached("volume", 3e3, async () => {
  const [volOut, muteOut] = await Promise.all([
    runCmd("osascript", ["-e", "output volume of (get volume settings)"]),
    runCmd("osascript", ["-e", "output muted of (get volume settings)"])
  ]);
  return {
    volume: parseInt(volOut.out.trim()) || 0,
    muted: muteOut.out.trim() === "true"
  };
}));
ipcMain.handle("volume:set", async (event, level) => {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  await runCmd("osascript", ["-e", `set volume output volume ${clamped}`]);
  _cache.delete("volume");
  return { ok: true, volume: clamped };
});
ipcMain.handle("volume:mute", async (event, mute) => {
  const cmd = mute ? "set volume with output muted" : "set volume without output muted";
  await runCmd("osascript", ["-e", cmd]);
  _cache.delete("volume");
  return { ok: true };
});
const AIRPORT = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";
const WIFI_IF = "en0";
function runCmd(bin, args, timeoutMs = 12e3) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args);
    let out = "", err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) => resolve({ code, out, err }));
    proc.on("error", (e) => resolve({ code: -1, out: "", err: e.message }));
    setTimeout(() => {
      proc.kill();
      resolve({ code: -1, out, err: "timeout" });
    }, timeoutMs);
  });
}
function parseAirportScan(raw) {
  const lines = raw.trim().split("\n").slice(1);
  return lines.map((line) => {
    const m = line.match(/([0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})/i);
    if (!m) return null;
    const bssid = m[1];
    const bssidIdx = line.indexOf(bssid);
    const ssid = line.substring(0, bssidIdx).trim();
    if (!ssid) return null;
    const rest = line.substring(bssidIdx + bssid.length).trim().split(/\s+/);
    const rssi = parseInt(rest[0]) || -100;
    const security = rest.slice(4).join(" ") || "NONE";
    return { ssid, bssid, rssi, security, secured: !/NONE/i.test(security) };
  }).filter(Boolean);
}
ipcMain.handle("wifi:status", async () => {
  const { out } = await runCmd("networksetup", ["-getairportnetwork", WIFI_IF]);
  const m = out.match(/Current Wi-Fi Network:\s*(.+)/);
  return { connected: !!m, ssid: m ? m[1].trim() : null };
});
ipcMain.handle("wifi:scan", async () => {
  const { out, err } = await runCmd(AIRPORT, ["-s"], 15e3);
  if (!out.trim()) return { ok: false, networks: [], error: err };
  return { ok: true, networks: parseAirportScan(out) };
});
ipcMain.handle("wifi:connect", async (event, ssid, password) => {
  const args = ["-setairportnetwork", WIFI_IF, ssid];
  if (password) args.push(password);
  const { code, err } = await runCmd("networksetup", args, 3e4);
  return { ok: code === 0, error: err };
});
ipcMain.handle("wifi:disconnect", async () => {
  const { code, err } = await runCmd(AIRPORT, ["-z"]);
  return { ok: code === 0, error: err };
});
const _downloads = /* @__PURE__ */ new Map();
let _dlId = 0;
app.on("browser-window-created", () => {
});
session.defaultSession.on("will-download", (event, item) => {
  const id = ++_dlId;
  const dl = {
    id,
    filename: item.getFilename(),
    url: item.getURL(),
    totalBytes: item.getTotalBytes(),
    receivedBytes: 0,
    state: "progressing",
    savePath: path.join(os.homedir(), "Downloads", item.getFilename())
  };
  item.setSavePath(dl.savePath);
  _downloads.set(id, dl);
  item.on("updated", (_, state) => {
    dl.receivedBytes = item.getReceivedBytes();
    dl.state = state;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("download:update", { ...dl });
  });
  item.on("done", (_, state) => {
    dl.state = state;
    dl.receivedBytes = item.getTotalBytes();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("download:done", { ...dl });
  });
});
ipcMain.handle("download:list", () => Array.from(_downloads.values()));
ipcMain.handle("download:open", (_, p) => shell.openPath(p));
ipcMain.handle("download:reveal", (_, p) => shell.showItemInFolder(p));
ipcMain.handle("download:clear", () => {
  _downloads.clear();
  return true;
});
const ALL_REPOS = [
  "revelations-os",
  "taxflow-pro",
  "bowdwn",
  "automix",
  "legalvault-pro",
  "fema-platform",
  "genmed-clinical-sync",
  "rals-unified",
  "liquor-ledger",
  "leadforge",
  "proverbs",
  "IdeaPlanner",
  "freepost",
  "cloutkiller",
  "grow-clout-hub",
  "syllabus-script-space",
  "artistmanager",
  "petsitter-pro",
  "groomtrack-pro",
  "mobile-massage",
  "mobile-barber",
  "mobile-salon",
  "tradeiqdesk",
  "vybe-engine",
  "business-software-management-services",
  "black-wall-street-legacy",
  "school-manager",
  "contractor-os",
  "tuffbets",
  "command-hq",
  "dealerflow-pro",
  "govcoreerp",
  "olive",
  "admin-center",
  "pcscanfix"
];
ipcMain.handle("rev:listRepos", async () => {
  const home = os.homedir();
  return ALL_REPOS.map((r) => ({
    name: r,
    path: path.join(home, r),
    exists: fs.existsSync(path.join(home, r))
  }));
});
function sendProgress(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("rev:progress", text);
  }
}
ipcMain.handle("rev:update", async (event, issue) => {
  if (!rateOk("rev:update")) return { ok: false, output: "Rate limit exceeded" };
  const home = os.homedir();
  const proverbs = path.join(home, "proverbs", "index.js");
  if (!fs.existsSync(proverbs)) {
    return { ok: false, output: "Proverbs CLI not found at ~/proverbs/index.js.\nRun: git clone <proverbs-repo> ~/proverbs && cd ~/proverbs && npm install" };
  }
  const existingRepos = ALL_REPOS.map((r) => path.join(home, r)).filter((p) => fs.existsSync(p));
  const issueLower = issue.toLowerCase();
  const mentionedRepos = existingRepos.filter((r) => {
    const name = path.basename(r).toLowerCase();
    return issueLower.includes(name) || issueLower.includes(name.replace(/-/g, " ")) || issueLower.includes(name.replace(/-/g, ""));
  });
  const osKeywords = ["os", "revelations", "terminal", "browser", "ephesians", "desktop", "login", "window", "topbar", "sidebar", "orb", "settings", "notepad", "files", "file manager", "app store", "celestia"];
  const isOSIssue = osKeywords.some((k) => issueLower.includes(k));
  const targetRepos = mentionedRepos.length > 0 ? mentionedRepos : existingRepos.slice(0, 5);
  if (isOSIssue && !targetRepos.includes(path.join(home, "revelations-os"))) {
    targetRepos.unshift(path.join(home, "revelations-os"));
  }
  sendProgress(`\x1B[35m[rev]\x1B[0m Analyzing issue: ${issue.slice(0, 80)}...
`);
  sendProgress(`\x1B[35m[rev]\x1B[0m Target repos: ${targetRepos.map((r) => path.basename(r)).join(", ")}
`);
  sendProgress(`\x1B[35m[rev]\x1B[0m Invoking Proverbs CLI...

`);
  const prompt = [
    `[Revelations OS — rev update]`,
    `ISSUE REPORTED BY USER: ${issue}`,
    ``,
    `CONTEXT:`,
    `- You are running inside Revelations OS, the RAXX Beats Studios desktop platform`,
    `- The OS source is at ~/revelations-os`,
    `- Target repositories: ${targetRepos.join(", ")}`,
    ``,
    `INSTRUCTIONS:`,
    `1. Analyze the issue description`,
    `2. Identify which files in the target repos need to be changed`,
    `3. Apply the fix directly to the files`,
    `4. Report what was changed and why`,
    `5. If the issue is in revelations-os itself, note that a rebuild is needed`
  ].join("\n");
  return new Promise((resolve) => {
    let output = "";
    const args = ["--issue", prompt, "--repos", targetRepos.join(","), "--mode", "fix"];
    const proc = spawn("node", [proverbs, ...args], {
      cwd: path.join(home, "proverbs"),
      env: { ...process.env, REV_ISSUE: issue, REV_REPOS: targetRepos.join(","), REV_MODE: "fix" }
    });
    proc.stdout.on("data", (d) => {
      const text = d.toString();
      output += text;
      sendProgress(text);
    });
    proc.stderr.on("data", (d) => {
      const text = d.toString();
      output += text;
      sendProgress(`\x1B[33m${text}\x1B[0m`);
    });
    proc.on("close", (code) => {
      const status = code === 0 ? "✓ Complete" : `⚠ Exited (${code})`;
      const needsRebuild = isOSIssue || targetRepos.some((r) => r.includes("revelations-os"));
      sendProgress(`
\x1B[35m[rev]\x1B[0m ${status}
`);
      if (needsRebuild) {
        sendProgress(`\x1B[35m[rev]\x1B[0m OS changes detected — run 'rev rebuild' to apply them.
`);
      }
      resolve({ ok: code === 0, output, needsRebuild, targetRepos: targetRepos.map((r) => path.basename(r)) });
    });
    proc.on("error", (err) => {
      const msg = `Proverbs error: ${err.message}`;
      sendProgress(`\x1B[31m${msg}\x1B[0m
`);
      resolve({ ok: false, output: msg, needsRebuild: false });
    });
    setTimeout(() => {
      proc.kill();
      sendProgress(`
\x1B[31m[rev] Timed out after 5 minutes\x1B[0m
`);
      resolve({ ok: false, output: output || "Timed out", needsRebuild: false });
    }, 3e5);
  });
});
ipcMain.handle("rev:rebuild", async () => {
  if (!rateOk("rev:rebuild")) return { ok: false, output: "Rate limit exceeded" };
  const osDir = path.join(os.homedir(), "revelations-os");
  if (!fs.existsSync(osDir)) return { ok: false, output: "revelations-os repo not found at ~/revelations-os" };
  sendProgress(`\x1B[35m[rev]\x1B[0m Rebuilding Revelations OS...
`);
  const evite = path.join(osDir, "node_modules", "electron-vite", "bin", "electron-vite.js");
  if (!fs.existsSync(evite)) return { ok: false, output: "electron-vite not installed. Run: cd ~/revelations-os && npm install" };
  return new Promise((resolve) => {
    let output = "";
    const build = spawn("node", [evite, "build"], { cwd: osDir });
    build.stdout.on("data", (d) => {
      const t = d.toString();
      output += t;
      sendProgress(t);
    });
    build.stderr.on("data", (d) => {
      const t = d.toString();
      output += t;
      sendProgress(t);
    });
    build.on("close", (code) => {
      if (code !== 0) {
        sendProgress(`\x1B[31m[rev] Build failed (${code})\x1B[0m
`);
        resolve({ ok: false, output });
        return;
      }
      sendProgress(`\x1B[32m[rev] Build succeeded — copying to /Applications...\x1B[0m
`);
      const cp = spawn("cp", ["-R", path.join(osDir, "dist", "mac", "Revelations.app"), "/Applications/Revelations.app"]);
      cp.on("close", (cpCode) => {
        if (cpCode === 0) {
          sendProgress(`\x1B[32m[rev] Revelations.app updated in /Applications. Restart to apply.\x1B[0m
`);
          resolve({ ok: true, output: output + "\nInstalled to /Applications/Revelations.app" });
        } else {
          sendProgress(`\x1B[31m[rev] Copy failed — try: sudo cp -R ~/revelations-os/dist/mac/Revelations.app /Applications/\x1B[0m
`);
          resolve({ ok: false, output });
        }
      });
      cp.on("error", (e) => resolve({ ok: false, output: e.message }));
    });
    build.on("error", (e) => resolve({ ok: false, output: e.message }));
    setTimeout(() => {
      build.kill();
      resolve({ ok: false, output: "Build timed out" });
    }, 6e5);
  });
});
app.on("web-contents-created", (_, contents) => {
  const type = contents.getType();
  if (type !== "webview") {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!url.startsWith("http://localhost") && !url.startsWith("file://")) {
        event.preventDefault();
      }
    });
  }
  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb) => {
    const allowed = ["clipboard-read", "notifications", "fullscreen"];
    cb(allowed.includes(permission));
  });
});
app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
