import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/index.js';

async function serve(options, check) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await check(url); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const artifact = (value, extra = {}) => ({ kind: 'json', data: Buffer.from(JSON.stringify(value)).toString('base64'), ...extra });
const post = (url, body, headers = {}) => fetch(`${url}/api/inspect-artifacts`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body),
});

test('inspection export is absent by default', async () => {
  await serve({}, async url => {
    assert.equal((await post(url, artifact({ ok: true }))).status, 404);
    assert.equal((await fetch(`${url}/api/inspect-artifacts/anything.png`)).status, 404);
  });
});

test('inspection writes generated names, supports evidence above the chat limit, and only serves its own files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'companion-inspection-'));
  try {
    await serve({ inspectionDirectory: directory }, async url => {
      const value = { capture: 'x'.repeat(600_000) };
      const response = await post(url, artifact(value));
      assert.equal(response.status, 201);
      const saved = await response.json();
      assert.equal(path.dirname(saved.path), directory);
      assert.match(path.basename(saved.path), /^inspect-\d+-[a-f0-9-]{36}\.json$/);
      assert.deepEqual(JSON.parse(await readFile(saved.path, 'utf8')), value);
      const retrieved = await fetch(`${url}${saved.url}`, { headers: { origin: url } });
      assert.equal(retrieved.status, 200);
      assert.deepEqual(await retrieved.json(), value);
      assert.equal(retrieved.headers.get('x-content-type-options'), 'nosniff');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5x8AAAAASUVORK5CYII=';
      const imageResponse = await post(url, { kind: 'png', data: png });
      assert.equal(imageResponse.status, 201);
      const image = await imageResponse.json();
      assert.ok((await readFile(image.path)).equals(Buffer.from(png, 'base64')));
      // The endpoint checks the EBML signature, not complete media decoding.
      const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
      const videoResponse = await post(url, { kind: 'webm', data: webmHeader.toString('base64') });
      assert.equal(videoResponse.status, 201);
      const video = await videoResponse.json();
      assert.match(path.basename(video.path), /^inspect-\d+-[a-f0-9-]{36}\.webm$/);
      assert.ok((await readFile(video.path)).equals(webmHeader));
      const videoRetrieved = await fetch(`${url}${video.url}`);
      assert.equal(videoRetrieved.headers.get('content-type'), 'video/webm');
      assert.ok(Buffer.from(await videoRetrieved.arrayBuffer()).equals(webmHeader));
      assert.equal((await post(url, { kind: 'webm', data: png })).status, 400);
      await writeFile(path.join(directory, 'unrelated.json'), '{}');
      assert.equal((await fetch(`${url}/api/inspect-artifacts/unrelated.json`)).status, 404);
      assert.equal((await post(url, artifact({}, { path: '../escape.json' }))).status, 400);
      assert.equal((await post(url, { kind: 'png', data: 'bm90LXBuZw==' })).status, 400);
      assert.equal((await post(url, { kind: 'json', data: 'a'.repeat(5 * 1024 * 1024) })).status, 413);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inspection remains behind the local Host and same-origin checks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'companion-inspection-'));
  try {
    const destination = path.join(directory, 'artifacts');
    await serve({ inspectionDirectory: destination }, async url => {
      assert.equal((await post(url, artifact({}), { origin: 'https://unrelated.example' })).status, 403);
      assert.equal((await post(url, artifact({}), { 'sec-fetch-site': 'cross-site' })).status, 403);
      // Node fetch rewrites Host; use HTTP directly to exercise that guard.
      const foreignHostStatus = await new Promise((resolve, reject) => {
        const req = request(`${url}/api/inspect-artifacts/anything.png`, { headers: { host: 'unrelated.example' } }, res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
      });
      assert.equal(foreignHostStatus, 403);
      assert.equal((await fetch(`${url}/api/inspect-artifacts/anything.png`, { headers: { origin: 'https://unrelated.example' } })).status, 403);
      assert.deepEqual(await readdir(directory), []);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
