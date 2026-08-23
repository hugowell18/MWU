import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'scripts', 'validation-sprint', 'server.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(base, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/`);
      if (response.ok) return;
    } catch {
      // Retry until the server binds.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('authentication test server did not start');
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [SERVER, '--port', String(port)], {
  cwd: ROOT,
  env: {
    ...process.env,
    MWU_ADMIN_USER: 'admin',
    MWU_ADMIN_PASSWORD: 'mwu2026',
    MWU_SESSION_SECRET: 'auth-test-session-secret',
  },
  stdio: 'ignore',
});

try {
  await waitForServer(base);

  const anonymousSession = await fetch(`${base}/api/auth/session`);
  assert.equal(anonymousSession.status, 401);

  const blockedApi = await fetch(`${base}/api/workspace/usage`);
  assert.equal(blockedApi.status, 401);

  const rejected = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  assert.equal(rejected.status, 401);

  const accepted = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'mwu2026' }),
  });
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get('set-cookie');
  assert.match(cookie || '', /mwu_session=/);
  assert.match(cookie || '', /HttpOnly/);
  assert.match(cookie || '', /SameSite=Strict/);

  const authenticatedSession = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(authenticatedSession.status, 200);
  assert.deepEqual(await authenticatedSession.json(), { authenticated: true, user: 'admin' });

  const allowedApi = await fetch(`${base}/api/workspace/usage`, { headers: { cookie } });
  assert.equal(allowedApi.status, 200);

  const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);

  console.log('AUTH TESTS PASSED');
} finally {
  server.kill();
}
