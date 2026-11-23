import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../public/common.js';
import { VOCAL_PRESETS } from '../public/vocal-presets.js';
import commandContract from '../lib/stage-commands.cjs';
import { chromium } from 'playwright';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function makeMockServer(runStageCommand) {
  const commands = [];
  const obsCommands = [];
  let obsState = { connected: true, recording: false, streaming: false, correctScene: true, websiteScene: false };
  const status = {
    ready: true, effectsVersion: 2, camera: false, mic: false, audio: false, player: 'idle',
    ...DEFAULTS, inputDeviceId: '', outputDeviceId: '', micDb: -Infinity, clip: false,
    devices: { inputs: [{ id: 'mic-a', label: 'USB microphone' }], outputs: [{ id: 'out-a', label: 'Headphones' }] }
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/api/stage/command' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      commands.push(body);
      if (!commandContract.SUPPORTED_STAGE_COMMANDS.has(body.command)) { response.writeHead(503, {'content-type':'application/json'}); response.end(JSON.stringify({error:'Unknown stage command.'})); return; }
      if (runStageCommand) return json(response, { status: await runStageCommand(body) });
      if (body.command === 'setDevices') {
        status.inputDeviceId = body.payload.inputDeviceId || '';
        status.outputDeviceId = body.payload.outputDeviceId || '';
      }
      return json(response, { status });
    }
    if (path.startsWith('/api/obs/')) {
      if (request.method === 'POST') {
        const payload = JSON.parse(await readBody(request));
        obsCommands.push({ path, payload });
        if (path === '/api/obs/website-windows') return json(response, { windows: [{ id: 62, title: 'Example Track | Suno' }] });
        if (path === '/api/obs/setup' || payload.action === 'start') obsState = { ...obsState, websiteScene: payload.mode === 'website', correctScene: payload.mode !== 'website' };
        if (payload.action === 'start') obsState.recording = true;
        if (payload.action === 'stop') {
          obsState.recording = false;
          return json(response, { ...obsState, savedPath: '/tmp/website-test.mkv' });
        }
      }
      return json(response, obsState);
    }
    const relative = path === '/' ? '/control.html' : path;
    try {
      const content = await readFile(join(publicDir, relative));
      response.writeHead(200, { 'content-type': mime[extname(relative)] || 'application/octet-stream' });
      response.end(content);
    } catch { response.writeHead(404); response.end('not found'); }
  });
  return { server, commands, status, obsCommands };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let value = '';
    request.on('data', chunk => { value += chunk; });
    request.on('end', () => resolve(value));
    request.on('error', reject);
  });
}

function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

test('control uses the actual Stage field and device contract', async () => {
  const { server, commands } = makeMockServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/control.html`);
    await page.waitForFunction(() => document.querySelector('#micDevice option[value="mic-a"]'));

    const actualFields = ['compressionAmount', 'compressionThreshold', 'compressionRatio', 'compressionMakeup', 'compressionAttack', 'compressionRelease', 'reverbDecay', 'reverbPredelay', 'reverbTone', 'delayMix', 'delayMs', 'limiterDb'];
    assert.deepEqual(await page.locator('[data-advanced-effect]').evaluateAll(nodes => nodes.map(node => node.id)), actualFields);
    assert.equal(await page.locator('#cameraDevice').count(), 0);
    assert.equal(await page.locator('#micDevice').count(), 1);
    assert.equal(await page.locator('#outputDevice').count(), 1);
    assert.equal(await page.locator('label[for="outputDevice"]').textContent(), 'Voice monitoring output');
    assert.ok((await page.locator('body').textContent()).includes('YouTube follows macOS sound output'));
    assert.equal(await page.locator('#reverbTone').getAttribute('min'), '2000');
    assert.equal(await page.locator('#reverbTone').getAttribute('max'), '12000');

    const lastVoiceChange = page.waitForResponse(response => response.url().endsWith('/api/stage/command') && response.request().postDataJSON().command === 'compression');
    for (const [id, value] of [['compressionAmount', '62'], ['compressionThreshold', '-28'], ['compressionRatio', '4'], ['compressionMakeup', '3'], ['compressionAttack', '8'], ['compressionRelease', '180'], ['reverbDecay', '1.8'], ['reverbPredelay', '24'], ['reverbTone', '10000'], ['delayMix', '12'], ['delayMs', '300'], ['limiterDb', '-6']]) {
      await page.locator(`#${id}`).evaluate((node, next) => { node.value = next; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    }
    await page.locator('#compression').uncheck();
    await page.locator('#micDevice').selectOption('mic-a');
    await page.locator('#outputDevice').selectOption('out-a');
    await page.locator('#applyDevices').click();
    await page.locator('#refreshDevices').click();
    await lastVoiceChange;

    for (const entry of commands) assert(commandContract.SUPPORTED_STAGE_COMMANDS.has(entry.command), `HTTP bridge rejects ${entry.command}`);
    const names = commands.map(item => item.command);
    for (const name of ['compressionAmount', 'compressionThreshold', 'compressionRatio', 'compressionMakeup', 'compressionAttack', 'compressionRelease', 'reverbDecay', 'reverbPredelay', 'reverbTone', 'delayMix', 'delayMs', 'limiterDb', 'compression', 'setDevices', 'refreshDevices']) assert.ok(names.includes(name), `missing command ${name}`);
    const payloads = Object.fromEntries(commands.filter(item => item.command !== 'syncSettings').map(item => [item.command, item.payload]));
    assert.equal(payloads.compressionThreshold.value, -28);
    assert.equal(payloads.reverbTone.value, 10000);
    assert.deepEqual(payloads.setDevices, { inputDeviceId: 'mic-a', outputDeviceId: 'out-a' });
    assert.ok(!commands.some(item => JSON.stringify(item).includes('cameraDevice')));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Website mode binds the chosen Chrome window for recording and returns to YouTube setup', async () => {
  const { server, obsCommands } = makeMockServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/control.html`);
    await page.locator('#websiteMode').click();
    await page.locator('#websiteWindow').selectOption('62');
    assert.equal(await page.locator('#youtubeSource').isHidden(), true);
    assert.equal(await page.locator('#backingTrackLevel').isHidden(), true);
    await page.locator('#obsSetup').click();
    await page.waitForFunction(() => document.querySelector('#obsStatus').textContent.includes('Website ready'));
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record').textContent === 'Stop & save');
    assert.equal(await page.locator('#karaokeMode').isDisabled(), true);
    await page.locator('#record').click();
    await page.locator('#showRecording').waitFor({ state: 'visible' });
    await page.locator('#karaokeMode').click();
    assert.equal(await page.locator('#youtubeSource').isVisible(), true);
    const setupBack = page.waitForResponse(response => response.url().endsWith('/api/obs/setup'));
    await page.locator('#obsSetup').click();
    await setupBack;
    assert.deepEqual(obsCommands, [
      { path: '/api/obs/website-windows', payload: {} },
      { path: '/api/obs/setup', payload: { mode: 'website', windowId: 62 } },
      { path: '/api/obs/record', payload: { action: 'start', mode: 'website', windowId: 62 } },
      { path: '/api/obs/record', payload: { action: 'stop' } },
      { path: '/api/obs/setup', payload: {} }
    ]);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('six presets update the running Stage, save edits separately and preserve the backing track', async () => {
  let stage;
  const { server, commands } = makeMockServer(body => stage.evaluate(({ command, payload }) => {
    window.__karaoke.execute(command, payload);
    return window.__karaoke.getStatus();
  }, body));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {})
    });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const key = 'karaoke-live-settings';
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ voiceDb: 9, reverb: 18, music: 72 }));
    });
    stage = await context.newPage();
    await stage.goto(`${url}/stage.html`);
    await stage.waitForFunction(() => window.__karaoke?.getStatus().ready);
    const control = await context.newPage();
    await control.setViewportSize({ width: 400, height: 660 });
    await control.goto(`${url}/control.html`);
    await stage.waitForFunction(() => window.__karaoke.getStatus().music === 72);
    assert.ok(await control.locator('.vocal-presets').evaluate(panel => panel.scrollWidth <= panel.clientWidth));
    const select = id => control.locator(`[data-vocal-preset="${id}"]`).click();
    const expectStage = expected => stage.waitForFunction(fields => {
      const state = window.__karaoke.getStatus();
      return Object.entries(fields).every(([key, value]) => state[key] === value);
    }, expected, { timeout: 3000 });

    await expectStage({ voiceDb: 9, reverbMix: 18, music: 72 });
    await control.locator('#enableMedia').click();
    await expectStage({ mic: true, camera: true, audio: true });
    for (const [id, profile] of Object.entries(VOCAL_PRESETS)) {
      await select(id);
      await expectStage({ ...profile.settings, music: 72, mic: true, camera: true });
      assert.equal(await control.locator('[data-vocal-preset][aria-pressed="true"]').getAttribute('data-vocal-preset'), id);
      assert.equal(await control.locator('#music').inputValue(), '72');
    }
    await control.locator('.voice-effects summary').click();
    await control.locator('#delayMix').evaluate(input => {
      input.value = '13';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expectStage({ delayMix: 13 });
    await select('male-rap');
    await expectStage({ delayMix: 0 });
    await select('female-pop');
    await expectStage({ delayMix: 13 });
    await control.reload();
    assert.equal(await control.locator('[data-vocal-preset][aria-pressed="true"]').getAttribute('data-vocal-preset'), 'female-pop');
    assert.equal(await control.locator('#delayMix').inputValue(), '13');
    await stage.reload();
    await stage.waitForFunction(() => window.__karaoke?.getStatus().ready);
    await control.reload();
    await expectStage({ delayMix: 13, mic: false, music: 72 });
    await control.locator('#resetVocalPreset').click();
    await expectStage({ delayMix: VOCAL_PRESETS['female-pop'].settings.delayMix });
    await select('manual');
    await expectStage({ voiceDb: 9, reverbMix: 18, music: 72 });
    const presetPayloads = commands.filter(({ command, payload }) => command === 'syncSettings' && !Object.hasOwn(payload, 'videoUrl'));
    assert.ok(presetPayloads.length >= 10);
    for (const { payload } of presetPayloads) {
      for (const key of ['music', 'inputDeviceId', 'outputDeviceId', 'videoId', 'videoUrl']) assert.ok(!Object.hasOwn(payload, key));
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
