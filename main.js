const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const auth = require('./auth');
const pipe = require('./pipe');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const CACHE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'AntiBot', 'modules');
const TARGET_PROCESS = 'RocketLeague.exe';
const STEAM_APPID = '252950';
const DLL_FILENAME = 'AntiBot.dll';
// The launcher downloads the current DLL from the URL returned by
// /api/releases/current (which proxies an R2 object). The cached copy
// lives at %APPDATA%\AntiBot\modules\AntiBot.dll.

// Baked-in identifiers. Set these before shipping a build.
//   DISCORD_CLIENT_ID — the public Discord application ID used for the
//   PKCE sign-in flow. Create an application at
//   https://discord.com/developers/applications and paste its Client ID.
//   API_URL          — the origin of your anticlanker deployment, for
//   example https://your-project.vercel.app (no trailing slash).
const DISCORD_CLIENT_ID = '';
const API_URL = '';

let win;
let config = {
  launcher: 'steam',
  discordAccessToken: null,
};

// In-memory only. Session tokens (5 min) are never persisted to disk — if
// the launcher restarts, the user logs in again.
// Shape: { sessionToken, expiresAt, user, discordAccessToken }.
let session = null;

// Once we've injected into a live RL process, we periodically refresh the
// 5-minute launcher session and push it to the DLL via the pipe. The
// interval lives until the target process exits or the user logs out.
let refreshTimer = null;
let injectedPid = null;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...data };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

loadConfig();

async function trySilentReauth() {
  if (!config.discordAccessToken) return;
  console.log('[auth] existing token found; attempting silent reauth');
  try {
    const result = await auth.refreshLauncherSession({
      apiUrl: API_URL,
      discordAccessToken: config.discordAccessToken,
    });
    session = { ...result, discordAccessToken: config.discordAccessToken };
    console.log('[auth] silent reauth successful for:', result.user?.username || 'user');
    startRefreshLoop();
  } catch (e) {
    console.warn('[auth] silent reauth failed:', e.message || e);
    // On reauth failure, it might be a net blip; we don't clear the token
    // here, but we don't start the refresh loop either.
  }
}

// Kick off re-auth immediately.
trySilentReauth();

function createWindow() {
  win = new BrowserWindow({
    width: 1024,
    height: 680,
    frame: false,
    backgroundColor: '#05070a',
    icon: path.join(__dirname, 'logo.png'),
    resizable: true,
    minWidth: 880,
    minHeight: 580,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  // Kick off the release sync right away so the DLL is ready by the time
  // the user lands on the injector screen. Silent; state is exposed via
  // the dll:status IPC handler.
  syncDll({ force: false }).catch(() => { /* surfaced in dllState */ });
});
function log(msg, type = 'info') {
  if (win && !win.isDestroyed()) {
    win.webContents.send('discovery-log', {
      timestamp: new Date().toLocaleTimeString(),
      msg,
      type,
    });
  }
}

app.on('window-all-closed', () => app.quit());

// ---------- window controls ----------
ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('win:close', () => win?.close());

ipcMain.handle('settings:get', () => config);
ipcMain.handle('settings:set', (_e, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig();
  return config;
});
// (settings:pickDll is no longer required but kept for API stability if needed)
ipcMain.handle('settings:pickDll', () => null);

// ---------- process detection ----------
function findProcess(name) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = stdout.split(/\r?\n/).find(l => l.toLowerCase().includes(name.toLowerCase()));
      if (!line) return resolve(null);
      const parts = line.split('","').map(s => s.replace(/^"|"$/g, ''));
      const pid = parseInt(parts[1], 10);
      if (!Number.isFinite(pid)) return resolve(null);
      resolve({ name: parts[0], pid });
    });
  });
}

ipcMain.handle('proc:find', () => findProcess(TARGET_PROCESS));
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

// ---------- launch game ----------
ipcMain.handle('game:launch', async () => {
  try {
    const launcher = config.launcher || 'steam';
    if (launcher === 'steam') {
      log('Launching Rocket League via Steam...', 'info');
      await shell.openExternal(`steam://rungameid/${STEAM_APPID}`);
    } else {
      log('Launching Rocket League via Epic Games...', 'info');
      await shell.openExternal(`com.epicgames.launcher://apps/Sugar?action=launch&silent=true`);
    }
    return { ok: true };
  } catch (e) {
    log(`Launch failed: ${e}`, 'error');
    return { ok: false, error: String(e) };
  }
});

// ---------- auth ----------
function sessionPayload() {
  if (!session) return { authenticated: false };
  if (Date.now() >= session.expiresAt) {
    session = null;
    return { authenticated: false };
  }
  return {
    authenticated: true,
    expiresAt: session.expiresAt,
    user: session.user,
  };
}

ipcMain.handle('auth:status', () => sessionPayload());

ipcMain.handle('auth:login', async () => {
  try {
    const result = await auth.login({
      apiUrl: API_URL,
      discordClientId: DISCORD_CLIENT_ID,
    });
    session = result;
    // Persist for silent re-auth on next launch.
    config.discordAccessToken = result.discordAccessToken;
    saveConfig();
    startRefreshLoop();
    return { ok: true, ...sessionPayload() };
  } catch (e) {
    const message = typeof e?.message === 'string' ? e.message : String(e);
    const bannedInfo = e?.status === 403 && e?.body?.error === 'banned'
      ? { bannedAt: e.body.bannedAt ?? null, bannedReason: e.body.bannedReason ?? null }
      : null;
    return { ok: false, error: message, banned: bannedInfo };
  }
});

ipcMain.handle('auth:logout', () => {
  session = null;
  config.discordAccessToken = null;
  saveConfig();
  stopRefreshLoop();
  return { ok: true };
});

// ---------- session refresh ----------

// ---------- Diagnostics ----------
function runDiagCommand(cmd) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], (err, stdout) => {
      resolve(stdout ? stdout.trim() : '');
    });
  });
}

function sourceDllInfo() {
  const rootDir = __dirname;
  const possiblePaths = [
    path.join(rootDir, 'modules', DLL_FILENAME),
    path.join(rootDir, DLL_FILENAME),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return { path: p, hash: sha256File(p) };
    }
  }
  return null;
}

ipcMain.handle('diag:run', async () => {
  const results = {
    vcredist: false,
    admin: false,
    integrity: false,
    arch: process.arch,
  };

  // 1. Check VC++ Redist (2015-2022 x64)
  const vcredistCheck = await runDiagCommand(`
    $kp = 'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
    if (Test-Path $kp) {
      (Get-ItemProperty -Path $kp).Installed
    } else { 0 }
  `);
  results.vcredist = vcredistCheck === '1';

  // 2. Check Admin Rights
  const adminCheck = await runDiagCommand('([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")');
  results.admin = adminCheck === 'True';

  // 3. Check Defender Exclusions (Requires Admin)
  if (results.admin) {
    const modulesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'AntiBot').toLowerCase();
    const exclusions = await runDiagCommand('(Get-MpPreference).ExclusionPath');
    results.defenderExcluded = exclusions.toLowerCase().includes(modulesDir);
  } else {
    results.defenderExcluded = false;
  }

  // 4. Integrity Check
  const src = sourceDllInfo();
  const cached = sha256File(cachedDllPath());
  results.integrity = !!cached && (dllState?.ok && !dllState.error);

  return results;
});

ipcMain.handle('diag:fix-defender', async () => {
  const modulesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'AntiBot');
  await runDiagCommand(`Add-MpPreference -ExclusionPath "${modulesDir}"`);
  return { ok: true };
});

function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  injectedPid = null;
}

function isProcessAlive(pid) {
  try {
    // Signal 0 is a liveness probe on both POSIX and Node-on-Windows.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function refreshAndPush() {
  if (!session || !session.discordAccessToken) {
    stopRefreshLoop();
    return;
  }

  try {
    const fresh = await auth.refreshLauncherSession({
      apiUrl: API_URL,
      discordAccessToken: session.discordAccessToken,
    });
    session = { ...session, ...fresh };
    console.log('[refresh] session refreshed');

    // If we are currently injected into a process, also push to the DLL.
    if (injectedPid) {
      if (isProcessAlive(injectedPid)) {
        await pipe.handoff(injectedPid, {
          sessionToken: fresh.sessionToken,
          apiUrl: API_URL,
        }, { timeoutMs: 5_000 });
        console.log('[refresh] pushed fresh session to DLL');
      } else {
        console.log('[refresh] target process gone; cleared injectedPid');
        injectedPid = null;
      }
    }
  } catch (e) {
    console.warn('[refresh] failed:', e.message || e);
  }
}

function startRefreshLoop(pid) {
  if (pid) injectedPid = pid;

  // If already running, don't double up.
  if (refreshTimer) return;

  // Refresh every 4 minutes (assuming 5-min sessions).
  refreshTimer = setInterval(refreshAndPush, 4 * 60 * 1000);
}

// ---------- dll cache / versioning / download ----------

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function sha256File(p) {
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function cachedDllPath() {
  return path.join(CACHE_DIR, DLL_FILENAME);
}

// Strips trailing ".0" segments so "1.0.3" and "1.0.3.0" compare equal.
// Admins type the version they care about; the PE FileVersion is often
// padded out to four parts.
function normalizeVersion(v) {
  if (!v) return '';
  const parts = String(v).trim().split('.');
  while (parts.length > 1 && parts[parts.length - 1] === '0') parts.pop();
  return parts.join('.');
}

// Reads the FileVersion metadata off a PE file via PowerShell. Returns
// null if the file doesn't exist or the read failed.
function readDllVersion(p) {
  return new Promise((resolve) => {
    if (!fs.existsSync(p)) return resolve(null);
    const script = `(Get-Item -LiteralPath '${p.replace(/'/g, "''")}').VersionInfo.FileVersion`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    ps.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const trimmed = out.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

// Downloads a URL to an absolute path. Follows a few layers of redirects
// (R2 presigned URLs come in through a 302 from the API). Throws with a
// specific `dll_in_use` code when Windows refuses to overwrite the target
// because Rocket League still has the current DLL mapped into memory.
function downloadTo(url, dst) {
  return new Promise((resolve, reject) => {
    const tmp = dst + '.part';
    const file = fs.createWriteStream(tmp);
    const cleanup = (err) => {
      try { file.close(); } catch { /* noop */ }
      try { fs.unlinkSync(tmp); } catch { /* noop */ }
      reject(err);
    };
    const finalize = () => {
      // Try the atomic rename first. If the destination is locked (our DLL
      // loaded in RL) Windows returns EPERM/EBUSY. Retry via unlink+rename
      // in case the file is just stale; bail with a clear error otherwise.
      try {
        fs.renameSync(tmp, dst);
        return resolve();
      } catch (e) {
        if ((e.code === 'EPERM' || e.code === 'EBUSY') && fs.existsSync(dst)) {
          try {
            fs.unlinkSync(dst);
            fs.renameSync(tmp, dst);
            return resolve();
          } catch (e2) {
            if (e2.code === 'EPERM' || e2.code === 'EBUSY') {
              return cleanup(new Error('dll_in_use'));
            }
            return cleanup(e2);
          }
        }
        return cleanup(e);
      }
    };
    const get = (target, redirectsLeft) => {
      https
        .get(target, (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            res.resume();
            return get(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return cleanup(new Error(`download_http_${res.statusCode}`));
          }
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => finalize());
          });
        })
        .on('error', cleanup);
    };
    get(url, 5);
  });
}

async function fetchCurrentRelease() {
  const res = await fetch(`${API_URL}/api/releases/current`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`releases_http_${res.status}`);
  return res.json();
}

// Last-known state for the renderer. Populated by syncDll. Shape:
//   { ok, downloaded, localVersion, serverVersion, error, releaseAt }
let dllState = { ok: false, error: 'pending', localVersion: null, serverVersion: null };

// Returns true if the cached DLL is present and matches the latest release.
// Downloads a fresh copy otherwise. Silent on success; any failure goes in
// dllState.error so the UI can show it.
async function syncDll({ force = false } = {}) {
  ensureCacheDir();
  const dst = cachedDllPath();
  try {
    const release = await fetchCurrentRelease();
    const wantVersion = release?.dll?.version ?? null;
    const wantSha = release?.dll?.sha256 ?? null;
    const downloadUrl = release?.dll?.downloadUrl ?? null;
    const localVersion = await readDllVersion(dst);

    if (!downloadUrl) {
      throw new Error('no_release_published');
    }

    const needDownload =
      force ||
      !fs.existsSync(dst) ||
      (wantVersion && normalizeVersion(localVersion) !== normalizeVersion(wantVersion));

    if (!needDownload) {
      dllState = {
        ok: true,
        downloaded: false,
        localVersion,
        serverVersion: wantVersion,
        error: null,
      };
      return dllState;
    }

    log('Downloading latest module version...', 'info');
    try {
      await downloadTo(downloadUrl, dst);
      log('Module updated successfully.', 'success');
    } catch (e) {
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      // If the DLL is loaded in RL right now we can't overwrite it. If we
      // already have a cached copy, keep using it — the next launch will
      // pick up the new version once the user closes the game.
      if (msg === 'dll_in_use') {
        if (fs.existsSync(dst)) {
          log('Module update deferred: close Rocket League to install.', 'warn');
          dllState = {
            ok: true,
            downloaded: false,
            localVersion,
            serverVersion: wantVersion,
            error: null,
            updatePending: true,
          };
          return dllState;
        }
        throw new Error('dll_in_use_no_cache');
      }
      log(`Module download failed: ${msg}`, 'error');
      throw e;
    }

    if (wantSha) {
      const gotSha = sha256File(dst);
      if (gotSha !== wantSha.toLowerCase()) {
        try { fs.unlinkSync(dst); } catch { /* noop */ }
        throw new Error(`sha256_mismatch:${gotSha}`);
      }
    }

    const newLocalVersion = await readDllVersion(dst);
    dllState = {
      ok: true,
      downloaded: true,
      localVersion: newLocalVersion,
      serverVersion: wantVersion,
      error: null,
    };
    return dllState;
  } catch (e) {
    const msg = typeof e?.message === 'string' ? e.message : String(e);
    dllState = {
      ok: false,
      downloaded: false,
      localVersion: await readDllVersion(dst).catch(() => null),
      serverVersion: null,
      error: msg,
    };
    return dllState;
  }
}

ipcMain.handle('dll:status', () => dllState);
ipcMain.handle('dll:sync', () => syncDll({ force: false }));
ipcMain.handle('dll:update', () => syncDll({ force: true }));

// ---------- injection ----------
function quoteForPs(s) {
  return s.replace(/'/g, "''");
}

function buildInjectorScript(pid, dllPath) {
  const safePid = Number.parseInt(String(pid), 10);
  if (!Number.isFinite(safePid) || safePid <= 0) {
    throw new Error('invalid_pid');
  }
  return `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace W -Name N -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(uint a, bool b, uint pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr addr, uint size, uint type, uint prot);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, uint size, out IntPtr written);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Ansi)]
public static extern IntPtr GetProcAddress(IntPtr mod, string name);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Ansi)]
public static extern IntPtr GetModuleHandleA(string name);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr CreateRemoteThread(IntPtr h, IntPtr attr, uint stack, IntPtr addr, IntPtr param, uint flags, out IntPtr tid);
[DllImport("kernel32.dll")]
public static extern uint WaitForSingleObject(IntPtr h, uint ms);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr h);
'@
$pidTarget = ${safePid}
$dll = '${quoteForPs(dllPath)}'
$bytes = [System.Text.Encoding]::Unicode.GetBytes($dll + [char]0)
$h = [W.N]::OpenProcess(0x1F0FFF, $false, $pidTarget)
if ($h -eq [IntPtr]::Zero) { throw "OpenProcess failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$addr = [W.N]::VirtualAllocEx($h, [IntPtr]::Zero, [uint32]$bytes.Length, 0x3000, 0x04)
if ($addr -eq [IntPtr]::Zero) { throw "VirtualAllocEx failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$written = [IntPtr]::Zero
$ok = [W.N]::WriteProcessMemory($h, $addr, $bytes, [uint32]$bytes.Length, [ref]$written)
if (-not $ok) { throw "WriteProcessMemory failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$k32 = [W.N]::GetModuleHandleA('kernel32.dll')
$loadLib = [W.N]::GetProcAddress($k32, 'LoadLibraryW')
if ($loadLib -eq [IntPtr]::Zero) { throw "GetProcAddress LoadLibraryW failed" }
$tid = [IntPtr]::Zero
$th = [W.N]::CreateRemoteThread($h, [IntPtr]::Zero, 0, $loadLib, $addr, 0, [ref]$tid)
if ($th -eq [IntPtr]::Zero) { throw "CreateRemoteThread failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[void][W.N]::WaitForSingleObject($th, 5000)
[void][W.N]::CloseHandle($th)
[void][W.N]::CloseHandle($h)
Write-Output ("THREAD=" + $tid.ToString())
Write-Output ("REMOTE=" + $addr.ToString())
`;
}

function runInjector(pid, dllPath) {
  return new Promise((resolve) => {
    let script;
    try {
      script = buildInjectorScript(pid, dllPath);
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e) });
    }
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d.toString());
    ps.stderr.on('data', d => err += d.toString());
    ps.on('close', (code) => {
      if (code === 0) {
        const thread = (out.match(/THREAD=(\S+)/) || [])[1];
        const remote = (out.match(/REMOTE=(\S+)/) || [])[1];
        resolve({ ok: true, thread, remote });
      } else {
        resolve({ ok: false, error: (err || out).trim() });
      }
    });
  });
}

ipcMain.handle('inject:run', async (_evt, { pid }) => {
  const status = sessionPayload();
  if (!status.authenticated) {
    return { ok: false, error: 'not_authenticated' };
  }

  // Make sure the cached DLL matches the published release before we attach.
  // If the startup sync already finished this is a cheap no-op; if it
  // failed transiently we get a second shot before raising an error.
  log('Syncing module before attach...', 'info');
  const sync = await syncDll({ force: false });
  if (!sync.ok) {
    log(`Module sync failed: ${sync.error}`, 'error');
    return { ok: false, error: `dll_sync_failed:${sync.error || 'unknown'}` };
  }
  const dllPath = cachedDllPath();
  if (!fs.existsSync(dllPath)) {
    return { ok: false, error: 'dll_missing_after_sync' };
  }

  log(`Attaching to Rocket League (PID ${pid})...`, 'info');
  const injected = await runInjector(pid, dllPath);
  if (!injected.ok) {
    log(`Injection failed: ${injected.error}`, 'error');
    return injected;
  }

  try {
    log('DLL attached. Handing off session...', 'info');
    await pipe.handoff(pid, {
      sessionToken: session.sessionToken,
      apiUrl: API_URL,
    }, { timeoutMs: 10_000 });
    log('Handoff successful. Mod unlocked.', 'success');
  } catch (e) {
    log(`Handoff failed: ${e.message || e}`, 'error');
    return {
      ok: false,
      injected: true,
      error: `handoff_failed:${e.message || e}`,
      thread: injected.thread,
      remote: injected.remote,
    };
  }

  startRefreshLoop(pid);

  return {
    ok: true,
    thread: injected.thread,
    remote: injected.remote,
    sessionExpiresAt: session.expiresAt,
  };
});
