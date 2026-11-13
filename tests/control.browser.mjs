import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../public/common.js';
import commandContract from '../lib/stage-commands.cjs';
import { chromium } from 'playwright';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function makeMockServer() {
  const commands = [];
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
      if (body.command === 'setDevices') {
        status.inputDeviceId = body.payload.inputDeviceId || '';
        status.outputDeviceId = body.payload.outputDeviceId || '';
      }
      return json(response, { status });
    }
    if (path.startsWith('/api/obs/')) return json(response, { recording: false, streaming: false, correctScene: true });
    const relative = path === '/' ? '/control.html' : path;
    try {
      const content = await readFile(join(publicDir, relative));
      response.writeHead(200, { 'content-type': mime[extname(relative)] || 'application/octet-stream' });
      response.end(content);
    } catch { response.writeHead(404); response.end('not found'); }
  });
  return { server, commands, status };
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
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
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

    for (const [id, value] of [['compressionAmount', '62'], ['compressionThreshold', '-28'], ['compressionRatio', '4'], ['compressionMakeup', '3'], ['compressionAttack', '8'], ['compressionRelease', '180'], ['reverbDecay', '1.8'], ['reverbPredelay', '24'], ['reverbTone', '10000'], ['delayMix', '12'], ['delayMs', '300'], ['limiterDb', '-6']]) {
      await page.locator(`#${id}`).evaluate((node, next) => { node.value = next; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    }
    await page.locator('#compression').uncheck();
    await page.locator('#micDevice').selectOption('mic-a');
    await page.locator('#outputDevice').selectOption('out-a');
    await page.locator('#applyDevices').click();
    await page.locator('#refreshDevices').click();
    await page.waitForTimeout(50);

    for (const entry of commands) assert(commandContract.SUPPORTED_STAGE_COMMANDS.has(entry.command), `HTTP bridge rejects ${entry.command}`);
    const names = commands.map(item => item.command);
    for (const name of ['compressionAmount', 'compressionThreshold', 'compressionRatio', 'compressionMakeup', 'compressionAttack', 'compressionRelease', 'reverbDecay', 'reverbPredelay', 'reverbTone', 'delayMix', 'delayMs', 'limiterDb', 'compression', 'setDevices', 'refreshDevices']) assert.ok(names.includes(name), `missing command ${name}`);
    const payloads = Object.fromEntries(commands.filter(item => item.command !== 'syncSettings').map(item => [item.command, item.payload]));
    assert.equal(payloads.compressionThreshold.value, -28);
    assert.equal(payloads.reverbTone.value, 10000);
    assert.deepEqual(payloads.setDevices, { inputDeviceId: 'mic-a', outputDeviceId: 'out-a' });
    assert.ok(!commands.some(item => JSON.stringify(item).includes('cameraDevice')));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
