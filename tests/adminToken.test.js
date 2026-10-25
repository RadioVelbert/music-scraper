import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createApiApp } from '../src/api.js';

const servers = [];

async function start(token) {
  const previous = process.env.ADMIN_TOKEN;
  if (token === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = token;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-scraper-token-test-'));
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(configPath, 'stations: []\n');
  const app = createApiApp({ configPath, dbPath: path.join(dir, 'test.sqlite'), logger: pino({ level: 'silent' }) });
  if (previous === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previous;
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  servers.push({ server, app });
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  for (const { server, app } of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    app.locals.closeApiDb?.();
  }
});

describe('ADMIN_TOKEN', () => {
  it('leaves the admin area open when no token is configured', async () => {
    const base = await start(undefined);
    expect((await fetch(`${base}/api/admin/overview`)).status).toBe(200);
  });

  it('rejects admin and job requests without or with a wrong token', async () => {
    const base = await start('s3cret');
    for (const url of ['/api/admin/overview', '/api/admin/settings', '/api/jobs/evaluate-daily']) {
      const res = await fetch(base + url, { method: url.includes('/jobs/') ? 'POST' : 'GET' });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('admin_token_required');
    }
    const wrong = await fetch(`${base}/api/admin/overview`, { headers: { 'X-Admin-Token': 'nope' } });
    expect(wrong.status).toBe(401);
    expect((await fetch(`${base}/api/admin/merge-tracks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/admin/tracks/abc`, { method: 'DELETE' })).status).toBe(401);
  });

  it('accepts the token as X-Admin-Token or Bearer header', async () => {
    const base = await start('s3cret');
    expect((await fetch(`${base}/api/admin/overview`, { headers: { 'X-Admin-Token': 's3cret' } })).status).toBe(200);
    expect((await fetch(`${base}/api/admin/overview`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
  });

  it('keeps pages, health and the normal API open', async () => {
    const base = await start('s3cret');
    for (const url of ['/dashboard', '/admin', '/favorites', '/api/health', '/api/favorites', '/api/stations']) {
      expect((await fetch(base + url)).status, url).toBe(200);
    }
  });
});
