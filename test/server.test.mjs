import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

test('Linux adapter: authentication, generated module, storage and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gps-test-'));
  const token = 'test-only-secret-0123456789';
  const options = { token, dataDir, port: 0, publicUrl: 'https://gps.example.com', amapKey: '</script><script>alert(1)</script>' };
  let server = await startServer(options);
  const request = (path, options = {}, authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
  try {
    for (const path of ['/verify', '/set', '/loc.json', '/favorites', '/favorites/abc', '/ios-location-spoofer.sgmodule']) {
      assert.equal((await request(path, {}, false)).status, 401, path);
    }
    assert.equal((await request('/verify?token=wrong', {}, false)).status, 401);
    assert.equal((await request(`/verify?token=${token}`, {}, false)).status, 200);
    const page = await request('/');
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    const html = await page.text();
    assert.match(html, /"hasToken":true/);
    assert.ok(!html.includes(token));
    assert.ok(!html.includes('</script><script>alert(1)</script>'));
    assert.match(await (await request('/healthz')).text(), /"ok":true/);
    const module = await (await request('/ios-location-spoofer.sgmodule')).text();
    assert.ok(module.includes(`configUrl=https://gps.example.com/loc.json?token=${token}`));
    assert.ok(module.includes('script-path=https://gps.example.com/location-spoofer.js'));
    assert.ok(!module.includes('你的'));
    const defaults = await (await request('/loc.json')).json();
    assert.equal(defaults.latitude, 39.90872);
    const berlin = { latitude: 52.52, longitude: 13.405, altitude: 34, horizontalAccuracy: 10, verticalAccuracy: 20 };
    assert.deepEqual(await (await post('/set', berlin)).json(), berlin);
    assert.equal((await post('/set', { latitude: 91 })).status, 400);
    assert.equal((await post('/favorites', { name: 'missing coords' })).status, 400);
    assert.equal((await post('/favorites', { ...berlin, name: {} })).status, 400);
    assert.equal((await post('/set', null)).status, 400);
    assert.equal((await request('/set', { method: 'POST', body: '{bad' })).status, 400);
    const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => post('/favorites', { ...berlin, name: `place ${i}` }).then(r => r.json())));
    assert.equal(new Set(entries.map(entry => entry.id)).size, 12);
    assert.equal((await (await request('/favorites')).json()).length, 12);
    assert.equal((await request(`/favorites/${entries[0].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await request('/favorites')).json()).length, 11);
    assert.equal((await request('/.env')).status, 404);
    assert.equal((await request('/%2eenv')).status, 404);
    assert.equal((await request('/package.json')).status, 404);
    assert.equal((await request('/location-spoofer.js')).status, 200);
    assert.equal((await request('/manifest.json')).status, 200);
    assert.equal((await request('/verify', { method: 'POST' })).status, 405);
    await new Promise(resolve => server.close(resolve));
    server = await startServer(options);
    assert.deepEqual(await (await request('/loc.json')).json(), berlin);
    assert.equal((await (await request('/favorites')).json()).length, 11);
    assert.equal((await post('/set', { latitude: 0, longitude: 0, altitude: 0 })).status, 200);
    assert.equal((await (await request('/loc.json')).json()).latitude, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('refuses to start without a strong token', async () => {
  await assert.rejects(startServer({ token: '', publicUrl: 'https://gps.example.com' }), /TOKEN/);
});

test('starts from a current-release directory symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gps-launch-'));
  await symlink(fileURLToPath(new URL('..', import.meta.url)), join(directory, 'current'), 'dir');
  const child = spawn(process.execPath, [join(directory, 'current/server.mjs')], {
    env: { ...process.env, TOKEN: 'test-only-secret-0123456789', PUBLIC_URL: 'https://gps.example.com', HOST: '127.0.0.1', PORT: '0', DATA_DIR: join(directory, 'data') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup timed out: ' + errors)), 5000);
      child.stdout.once('data', chunk => {
        clearTimeout(timeout);
        try { assert.match(String(chunk), /GPS server listening on 127\.0\.0\.1:/); accept(); }
        catch (error) { reject(error); }
      });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Exited before startup: ${code}; ${errors}`)); });
    });
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
