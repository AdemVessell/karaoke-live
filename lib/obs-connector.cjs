const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function obsConfigPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.KARAOKE_OBS_CONFIG) return env.KARAOKE_OBS_CONFIG;
  const config = ['obs-studio', 'plugin_config', 'obs-websocket', 'config.json'];
  if (platform === 'win32') {
    const roaming = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(roaming, ...config);
  }
  return path.join(home, 'Library', 'Application Support', ...config);
}

const DEFAULT_CONFIG_PATH = obsConfigPath();
const safeError = message => new Error(String(message).replace(/[\r\n]+/g, ' ').slice(0, 180));

async function readConfig(configPath = DEFAULT_CONFIG_PATH, fsImpl = fs) {
  let raw;
  try { raw = await fsImpl.readFile(configPath, 'utf8'); }
  catch { throw safeError('OBS WebSocket configuration was not found. Enable OBS WebSocket and retry.'); }
  let config;
  try { config = JSON.parse(raw); } catch { throw safeError('OBS WebSocket configuration is invalid.'); }
  if (!config || config.server_enabled === false) throw safeError('Enable OBS WebSocket in OBS WebSocket Server Settings.');
  const port = Number(config.server_port || 4455);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw safeError('OBS WebSocket port is invalid.');
  return { port, password: typeof config.server_password === 'string' ? config.server_password : '' };
}

function authentication(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(`${password}${salt}`).digest('base64');
  return crypto.createHash('sha256').update(`${secret}${challenge}`).digest('base64');
}

async function connectObs({ configPath = DEFAULT_CONFIG_PATH, fsImpl = fs, webSocketFactory = null, timeoutMs = 4000, config = null } = {}) {
  const settings = config ? await (async () => {
    if (config.server_enabled === false) throw safeError('Enable OBS WebSocket in OBS WebSocket Server Settings.');
    const port = Number(config.server_port || config.port || 4455);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw safeError('OBS WebSocket port is invalid.');
    return { port, password: typeof config.server_password === 'string' ? config.server_password : (typeof config.password === 'string' ? config.password : '') };
  })() : await readConfig(configPath, fsImpl);
  const WS = webSocketFactory || globalThis.WebSocket;
  if (typeof WS !== 'function') throw safeError('This Node/Electron runtime does not provide WebSocket.');
  const socket = new WS(`ws://127.0.0.1:${settings.port}`);
  const pending = new Map();
  let closed = false;
  const failPending = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { socket.close(); } catch {} reject(safeError('OBS did not respond. Open OBS and retry.')); }, timeoutMs);
    const onOpen = () => {};
    const onMessage = event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.op === 0) {
        const auth = message.d?.authentication;
        const identify = { rpcVersion: 1, eventSubscriptions: 0 };
        if (auth) identify.authentication = authentication(settings.password, auth.salt, auth.challenge);
        try { socket.send(JSON.stringify({ op: 1, d: identify })); } catch { reject(safeError('OBS connection failed.')); }
      } else if (message.op === 2) { clearTimeout(timer); resolve(); }
      else if (message.op === 7) {
        const item = pending.get(message.d?.requestId); if (!item) return;
        pending.delete(message.d.requestId); clearTimeout(item.timer);
        if (message.d.requestStatus?.result) item.resolve(message.d.responseData || {});
        else item.reject(safeError(message.d.requestStatus?.comment || 'OBS request failed.'));
      }
    };
    socket.onopen = onOpen; socket.onmessage = onMessage;
    socket.onerror = () => { clearTimeout(timer); reject(safeError('OBS is unavailable. Open OBS and retry.')); };
    socket.onclose = () => { clearTimeout(timer); failPending(safeError('OBS disconnected.')); if (!closed) reject(safeError('OBS disconnected.')); };
  });
  await ready;
  const request = (requestType, requestData = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(safeError('OBS connection is closed.'));
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(safeError('OBS request timed out.')); }, 5000);
    pending.set(requestId, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(safeError('OBS request failed.')); }
  });
  return { request, close() { if (closed) return; closed = true; failPending(safeError('OBS connection closed.')); try { socket.close(); } catch {} } };
}

module.exports = { DEFAULT_CONFIG_PATH, obsConfigPath, readConfig, connectObs, authentication };
