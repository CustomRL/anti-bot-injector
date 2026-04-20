// Named-pipe handoff of the 5-minute launcher session token to the injected
// DLL. The DLL creates the pipe server on attach (name is `antibot-<pid>`);
// the launcher, which knows the PID it just injected, connects and writes
// the token. DLL reads one line and closes.
//
// The DLL's init thread doesn't start until after DllMain returns, which
// in turn happens after LoadLibraryW completes inside CreateRemoteThread.
// That means there's always a brief window where the pipe isn't listening
// yet. `handoff` retries until the pipe appears or the timeout fires.

const net = require('net');

function pipePathForPid(pid) {
  return `\\\\.\\pipe\\antibot-${pid}`;
}

function tryConnect(pipePath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: pipePath });
    const done = (err) => {
      sock.removeAllListeners();
      if (err) {
        try { sock.destroy(); } catch { /* noop */ }
        reject(err);
      } else {
        resolve(sock);
      }
    };
    sock.once('connect', () => done());
    sock.once('error', (err) => done(err));
  });
}

async function handoff(pid, { sessionToken, apiUrl }, { timeoutMs = 10_000, retryMs = 120 } = {}) {
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('invalid_pid');
  if (!sessionToken || typeof sessionToken !== 'string') throw new Error('invalid_token');
  if (!apiUrl || typeof apiUrl !== 'string') throw new Error('invalid_api_url');

  const pipePath = pipePathForPid(pid);
  const deadline = Date.now() + timeoutMs;
  let lastErr;

  // Single JSON object, newline-terminated. DLL ReadFile's until '\n'.
  const payload = JSON.stringify({
    session_token: sessionToken,
    api_url: apiUrl.replace(/\/$/, ''),
  }) + '\n';

  while (Date.now() < deadline) {
    try {
      const sock = await tryConnect(pipePath);
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.end(payload, 'utf8', () => resolve());
      });
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }

  const msg = lastErr ? String(lastErr.message || lastErr) : 'timed_out';
  throw new Error(`pipe_handoff_failed:${msg}`);
}

module.exports = { handoff, pipePathForPid };
