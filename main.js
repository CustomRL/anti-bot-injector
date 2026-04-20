const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_DLL_PATH = '';
const CACHE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'AntiBot', 'modules');
const TARGET_PROCESS = 'RocketLeague.exe';
const STEAM_APPID = '252950';

let win;
let config = {
  dllPath: DEFAULT_DLL_PATH
};

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
$pidTarget = ${pid}
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

ipcMain.handle('inject:run', async (_evt, { pid, dllPath }) => {
  return new Promise((resolve) => {
    const script = buildInjectorScript(pid, dllPath);
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
});
