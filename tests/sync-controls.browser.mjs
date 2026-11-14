import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let value = '';
    request.on('data', chunk => { value += chunk; });
    request.on('end', () => resolve(value));
    request.on('error', reject);
  });
}

function makeMockServer() {
  const state = {
    offsetMs: -120,
    syncGetDelay: 0,
    syncFailure: '',
    obsFailure: '',
    obs: { connected: true, recording: false, streaming: false, correctScene: true },
    syncPosts: [],
    stageCommands: [],
    appPosts: []
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/api/stage/command' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      state.stageCommands.push(body);
      return json(response, { status: { ready: true, effectsVersion: 2, camera: false, mic: false, audio: false, player: 'idle', devices: { inputs: [], outputs: [] } } });
    }
    if (path === '/api/obs/status') {
      if (state.obsFailure) return json(response, { connected: false, error: state.obsFailure }, 503);
      return json(response, state.obs);
    }
    if (path === '/api/obs/sync') {
      if (request.method === 'GET') {
        if (state.syncGetDelay) await new Promise(resolve => setTimeout(resolve, state.syncGetDelay));
        if (state.syncFailure) return json(response, { connected: false, error: state.syncFailure }, 503);
        return json(response, { offsetMs: state.offsetMs, applied: true, message: 'Saved lip-sync setting loaded.' });
      }
      const body = JSON.parse(await readBody(request));
      if (state.syncFailure) return json(response, { connected: false, error: state.syncFailure }, 503);
      if (state.obs.recording || state.obs.streaming) return json(response, { connected: true, error: 'Stop the current OBS recording or stream before setting lip sync.' }, 503);
      state.offsetMs = body.offsetMs;
      state.syncPosts.push(body);
      return json(response, { offsetMs: state.offsetMs, applied: true, message: 'Lip-sync setting saved.' });
    }
    if (path === '/api/app/show-recording' && request.method === 'POST') {
      state.appPosts.push(JSON.parse(await readBody(request) || '{}'));
      return json(response, { ok: true });
    }
    if (path.startsWith('/api/obs/')) return json(response, { ...state.obs, savedPath: path.endsWith('/record') ? '/tmp/Karaoke.mkv' : undefined });
    const relative = path === '/' ? '/control.html' : path;
    try {
      const content = await readFile(join(publicDir, relative));
      response.writeHead(200, { 'content-type': mime[extname(relative)] || 'application/octet-stream' });
      response.end(content);
    } catch { response.writeHead(404); response.end('not found'); }
  });
  return { server, state };
}

async function launch(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  return { browser, url: `http://127.0.0.1:${address.port}/control.html` };
}

async function setAmount(page, value) {
  await page.locator('#syncAmount').evaluate((node, next) => { node.value = next; node.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
}

test('lip-sync controls use signed OBS offsets and preserve the Stage boundary', async () => {
  const { server, state } = makeMockServer();
  let browser;
  try {
    const launched = await launch(server);
    browser = launched.browser;
    const page = await browser.newPage();
    await page.goto(launched.url);
    await page.locator('#syncDetails summary').click();
    await page.waitForTimeout(300);
    await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('loaded'), null, { timeout: 2000 });
    assert.equal(await page.locator('#syncDirection').inputValue(), 'voice-first');
    assert.equal(await page.locator('#syncAmount').inputValue(), '120');
    const stageCount = state.stageCommands.length;

    await page.locator('#syncDirection').selectOption('picture-first');
    await setAmount(page, 230);
    await page.locator('#applySync').click();
    await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('saved'));
    assert.equal(state.syncPosts.at(-1).offsetMs, 230);

    await page.locator('#syncDirection').selectOption('voice-first');
    await setAmount(page, 120);
    await page.locator('#applySync').click();
    await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('saved'));
    assert.equal(state.syncPosts.at(-1).offsetMs, -120);
    assert.equal(state.stageCommands.length, stageCount, 'sync UI must not send Stage commands');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('loaded'));
    await page.locator('#syncDetails summary').click();
    assert.equal(await page.locator('#syncDirection').inputValue(), 'voice-first');
    assert.equal(await page.locator('#syncAmount').inputValue(), '120');
    const afterReloadStageCount = state.stageCommands.length;
    await page.locator('#resetSync').click();
    await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('reset') || document.querySelector('#syncStatus')?.textContent.includes('saved'));
    assert.equal(state.syncPosts.at(-1).offsetMs, 0);
    assert.equal(state.stageCommands.length, afterReloadStageCount, 'reset must not send a Stage command');
    assert.equal(await page.locator('#syncDirection').inputValue(), 'aligned');
    assert.equal(await page.locator('#syncAmount').inputValue(), '0');

    assert.equal(await page.locator('#showRecording').isHidden(), true);
    await page.locator('#record').click();
    await assert.doesNotReject(page.waitForFunction(() => !document.querySelector('#showRecording')?.hidden));
    await page.locator('#showRecording').click();
    assert.equal(state.appPosts.length, 1, 'saved recording opens through the app route');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('lip-sync editor does not overwrite an edit, blocks busy OBS, and surfaces failures', async () => {
  const { server, state } = makeMockServer();
  state.offsetMs = 300;
  state.syncGetDelay = 180;
  let browser;
  try {
    const launched = await launch(server);
    browser = launched.browser;
    const page = await browser.newPage();
    await page.goto(launched.url);
    await page.locator('#syncDetails summary').click();
    await page.locator('#syncDirection').selectOption('picture-first');
    await setAmount(page, 40);
    await page.waitForTimeout(260);
    assert.equal(await page.locator('#syncDirection').inputValue(), 'picture-first', 'late GET must not replace a user edit');
    assert.equal(await page.locator('#syncAmount').inputValue(), '40');

    state.obs.recording = true;
    await page.waitForTimeout(1050);
    assert.equal(await page.locator('#applySync').isDisabled(), true);
    assert.match(await page.locator('#syncStatus').textContent(), /recording/i);
    assert.equal(state.syncPosts.length, 0, 'busy OBS must block the sync POST');

    await page.evaluate(() => {
      const channel = new BroadcastChannel('karaoke-live-v1');
      channel.postMessage({ type: 'status', data: { ready: true, effectsVersion: 2, recording: false, streaming: false, camera: false, mic: false, audio: false, player: 'idle' } });
      channel.close();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#applySync').isDisabled(), true, 'Stage heartbeat must not clear OBS recording block');

    state.obs.recording = false;
    state.syncFailure = 'OBS sync is unavailable.';
    await page.waitForTimeout(1050);
    await page.locator('#applySync').click();
    await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('unavailable'));
    assert.equal(state.syncPosts.length, 0);
    assert.match(await page.locator('#syncStatus').textContent(), /not applied/i);

    state.syncFailure = '';
    state.obsFailure = 'OBS connection lost.';
    await page.waitForTimeout(1050);
    assert.equal(await page.locator('#applySync').isDisabled(), true, 'poll failure must clear stale Apply availability');
    assert.match(await page.locator('#syncStatus').textContent(), /unavailable/i);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
