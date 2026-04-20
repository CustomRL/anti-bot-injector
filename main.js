const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const auth = require('./auth');
const pipe = require('./pipe');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_DLL_PATH = '';
const CACHE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'AntiBot', 'modules');
const TARGET_PROCESS = 'RocketLeague.exe';
const STEAM_APPID = '252950';

// Baked-in identifiers. Change + rebuild the launcher for other environments.
const DISCORD_CLIENT_ID = '1495830551184277564';
const API_URL = 'https://antibot-mu.vercel.app';

let win;
let config = {
  dllPath: DEFAULT_DLL_PATH,
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
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- window controls ----------
ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('win:close', () => win?.close());

// ---------- settings ----------
ipcMain.handle('settings:get', () => config);
ipcMain.handle('settings:set', (_e, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig();
  return config;
});
ipcMain.handle('settings:pickDll', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Dynamic Link Library', extensions: ['dll'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

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
    await shell.openExternal(`steam://rungameid/${STEAM_APPID}`);
    return { ok: true };
  } catch (e) {
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
  stopRefreshLoop();
  return { ok: true };
});

// ---------- session refresh ----------

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
  if (!session || !injectedPid) return;
  if (!isProcessAlive(injectedPid)) {
    console.log('[refresh] target process gone; stopping refresh loop');
    stopRefreshLoop();
    return;
  }
  if (!session.discordAccessToken) {
    console.warn('[refresh] no discord_access_token cached; cannot refresh');
    stopRefreshLoop();
    return;
  }
  try {
    const fresh = await auth.refreshLauncherSession({
      apiUrl: API_URL,
      discordAccessToken: session.discordAccessToken,
    });
    session = { ...session, ...fresh };
    await pipe.handoff(injectedPid, {
      sessionToken: fresh.sessionToken,
      apiUrl: API_URL,
    }, { timeoutMs: 5_000 });
    console.log('[refresh] pushed fresh session to DLL');
  } catch (e) {
    console.warn('[refresh] failed:', e.message || e);
    // Don't stop the loop on one failure; try again at the next tick.
    // If the discord token itself is dead, the next tick will also fail
    // and the user can re-login manually.
  }
}

function startRefreshLoop(pid) {
  stopRefreshLoop();
  injectedPid = pid;
  // Refresh 60s before the 5-min session would expire.
  refreshTimer = setInterval(refreshAndPush, 4 * 60 * 1000);
}

// ---------- dll cache / update ----------
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function sha256File(p) {
  const crypto = require('crypto');
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function currentCachedDll() {
  ensureCacheDir();
  const dllName = path.basename(config.dllPath);
  const target = path.join(CACHE_DIR, dllName);
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  return { path: target, mtime: stat.mtimeMs, size: stat.size, hash: sha256File(target) };
}

function sourceDllInfo() {
  const src = config.dllPath;
  if (!fs.existsSync(src)) return null;
  const stat = fs.statSync(src);
  return { path: src, mtime: stat.mtimeMs, size: stat.size, hash: sha256File(src) };
}

ipcMain.handle('dll:status', () => {
  const src = sourceDllInfo();
  const cached = currentCachedDll();
  return {
    source: src,
    cached,
    updateAvailable: !!src && (!cached || src.hash !== cached.hash),
  };
});

ipcMain.handle('dll:update', async () => {
  const src = sourceDllInfo();
  if (!src) return { ok: false, error: 'source dll not found' };
  ensureCacheDir();
  const dllName = path.basename(config.dllPath);
  const dst = path.join(CACHE_DIR, dllName);
  fs.copyFileSync(src.path, dst);
  return { ok: true, path: dst, hash: sha256File(dst) };
});

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

ipcMain.handle('inject:run', async (_evt, { pid, dllPath }) => {
  const status = sessionPayload();
  if (!status.authenticated) {
    return { ok: false, error: 'not_authenticated' };
  }

  const injected = await runInjector(pid, dllPath);
  if (!injected.ok) return injected;

  try {
    await pipe.handoff(pid, {
      sessionToken: session.sessionToken,
      apiUrl: API_URL,
    }, { timeoutMs: 10_000 });
  } catch (e) {
    // DLL is loaded but never got the session. The DLL will fail its gate
    // and refuse to unlock. Surface the specific failure so the UI can
    // explain it rather than showing a generic success.
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
