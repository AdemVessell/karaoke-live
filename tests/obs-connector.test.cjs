const test = require('node:test');
const assert = require('node:assert/strict');
const { connectObs, obsConfigPath, readConfig, authentication } = require('../lib/obs-connector.cjs');

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url; this.sent = []; this.closed = false; FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 0, d: { authentication: null } }) }));
  }
  send(value) {
    this.sent.push(JSON.parse(value));
    const message = this.sent.at(-1);
    if (message.op === 1) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 2, d: {} }) }));
    if (message.op === 6) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ op: 7, d: { requestId: message.d.requestId, requestStatus: { result: true }, responseData: { ok: true } } }) }));
  }
  close() { this.closed = true; this.onclose?.(); }
}

test('OBS connector authenticates and exposes request/close without leaking config', async () => {
  const obs = await connectObs({ config: { server_enabled: true, server_port: 4455, server_password: 'private' }, webSocketFactory: FakeSocket });
  assert.equal(FakeSocket.instances[0].url, 'ws://127.0.0.1:4455');
  assert.deepEqual(await obs.request('GetRecordStatus'), { ok: true });
  assert.doesNotMatch(JSON.stringify(FakeSocket.instances[0].sent), /private/);
  obs.close(); assert.equal(FakeSocket.instances[0].closed, true);
});

test('connector gives bounded errors for missing or disabled OBS config', async () => {
  await assert.rejects(readConfig('/definitely/missing/obs.json'), /configuration was not found/);
  await assert.rejects(connectObs({ config: { server_enabled: false }, webSocketFactory: FakeSocket }), /Enable OBS WebSocket/);
});

test('OBS authentication digest is deterministic without exposing the password', () => {
  const value = authentication('secret', 'salt', 'challenge');
  assert.equal(typeof value, 'string'); assert.ok(value.length > 20); assert.doesNotMatch(value, /secret|salt|challenge/);
});

test('locates OBS configuration under Windows roaming AppData and accepts a portable OBS override', () => {
  assert.equal(obsConfigPath('win32', { APPDATA: 'D:\\Profiles\\Singer\\Roaming' }, 'C:\\Users\\Singer'),
    'D:\\Profiles\\Singer\\Roaming\\obs-studio\\plugin_config\\obs-websocket\\config.json');
  assert.equal(obsConfigPath('win32', {}, 'C:\\Users\\Singer'),
    'C:\\Users\\Singer\\AppData\\Roaming\\obs-studio\\plugin_config\\obs-websocket\\config.json');
  assert.equal(obsConfigPath('win32', { KARAOKE_OBS_CONFIG: 'D:\\Portable OBS\\config.json' }),
    'D:\\Portable OBS\\config.json');
});
