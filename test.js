'use strict';

const assert = require('assert');
const axios = require('axios');
const { app, startServer } = require('./index');
const { archiveClient, SUPPORTED_VIDEO_EXTS } = require('./archive');
const { manifest } = require('./addon');

async function runTests() {
  console.log('============================================');
  console.log(' Starting Internet Archive Addon Test Suite');
  console.log('============================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  // 1. Manifest Specification Tests
  console.log('--- 1. Manifest Specification Compliance ---');
  test('Manifest declares supported resources: catalog, stream', () => {
    assert.deepStrictEqual(manifest.resources, ['catalog', 'stream']);
  });

  test('Manifest declares types: movie, series, other', () => {
    assert.deepStrictEqual(manifest.types, ['movie', 'series', 'other']);
  });

  test('Manifest has catalogs defined with search support', () => {
    assert(manifest.catalogs.length >= 3, 'Expected at least 3 catalogs');
    manifest.catalogs.forEach((c) => {
      const hasSearch = c.extra && c.extra.some((e) => e.name === 'search');
      assert(hasSearch, `Catalog ${c.id} must support search extra`);
    });
  });

  // 2. Authentication Header Generation Tests
  console.log('\n--- 2. Authentication Header Generation ---');
  test('S3 Keys produce Authorization: LOW <access_key>:<secret_key>', () => {
    const headers = archiveClient.getAuthHeaders({ access_key: 'KEY123', secret_key: 'SEC456' });
    assert.strictEqual(headers['Authorization'], 'LOW KEY123:SEC456');
  });

  test('Session cookies produce Cookie: logged_in_user=...; logged_in_sig=...', () => {
    const headers = archiveClient.getAuthHeaders({ logged_in_user: 'user@test.org', logged_in_sig: 'SIG789' });
    assert.strictEqual(headers['Cookie'], 'logged_in_user=user%40test.org; logged_in_sig=SIG789');
  });

  test('Proxy headers return correct Authorization format for Stremio', () => {
    const proxy = archiveClient.getProxyHeaders({ access_key: 'MY_KEY', secret_key: 'MY_SECRET' });
    assert.deepStrictEqual(proxy, { Authorization: 'LOW MY_KEY:MY_SECRET' });
  });

  test('Proxy headers return correct Cookie format for Stremio', () => {
    const proxy = archiveClient.getProxyHeaders({ logged_in_user: 'user@archive.org', logged_in_sig: 'sig_abc' });
    assert.deepStrictEqual(proxy, { Cookie: 'logged_in_user=user%40archive.org; logged_in_sig=sig_abc' });
  });

  // 3. Quality Detection and Format Heuristics
  console.log('\n--- 3. Quality & Format Detection ---');
  test('Detects 1080p from height attribute', () => {
    const q = archiveClient.detectQuality({ height: '1080', name: 'film.mp4' });
    assert.strictEqual(q.label, '1080p');
    assert.strictEqual(q.rank, 5);
  });

  test('Detects 720p from height attribute', () => {
    const q = archiveClient.detectQuality({ height: '720', name: 'film.mp4' });
    assert.strictEqual(q.label, '720p');
    assert.strictEqual(q.rank, 4);
  });

  test('Detects 240p for 512Kb derivative formats', () => {
    const q = archiveClient.detectQuality({ height: '240', format: '512Kb MPEG4', name: 'film_512kb.mp4' });
    assert.strictEqual(q.label, '240p');
  });

  test('Supported video extensions includes .mp4, .mkv, .webm, .ogv', () => {
    ['.mp4', '.mkv', '.webm', '.ogv'].forEach((ext) => {
      assert(SUPPORTED_VIDEO_EXTS.includes(ext), `Expected ${ext} in supported formats`);
    });
  });

  // 4. Live Server HTTP Endpoints
  console.log('\n--- 4. Live HTTP Endpoint Tests ---');
  const server = await startServer(0, '127.0.0.1');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  await testAsync('GET /health returns 200 with status ok', async () => {
    const res = await axios.get(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'ok');
  });

  await testAsync('GET /configure serves HTML configuration page', async () => {
    const res = await axios.get(`${baseUrl}/configure`);
    assert.strictEqual(res.status, 200);
    assert(res.data.includes('Internet Archive Stremio Addon'));
    assert(res.data.includes('accessKey'));
  });

  await testAsync('POST /api/validate-auth handles guest verification', async () => {
    const res = await axios.post(`${baseUrl}/api/validate-auth`, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.valid, true);
  });

  await testAsync('GET /manifest.json returns valid manifest', async () => {
    const res = await axios.get(`${baseUrl}/manifest.json`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, 'org.archive.stremio.addon');
    assert.deepStrictEqual(res.data.resources, ['catalog', 'stream']);
  });

  const sampleAuthConfig = { access_key: 'test_access', secret_key: 'test_secret' };
  const b64Auth = Buffer.from(JSON.stringify(sampleAuthConfig)).toString('base64');

  await testAsync('GET /:config/manifest.json decodes base64 and removes configurationRequired', async () => {
    const res = await axios.get(`${baseUrl}/${b64Auth}/manifest.json`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.id, 'org.archive.stremio.addon');
    assert.strictEqual(res.data.behaviorHints.configurationRequired, undefined);
  });

  await testAsync('GET /catalog/movie/archive_movies.json returns catalog items', async () => {
    const res = await axios.get(`${baseUrl}/catalog/movie/archive_movies.json`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data.metas));
    assert(res.data.metas.length > 0, 'Catalog should contain items');
    assert(res.data.metas[0].id.startsWith('archive:'));
    assert(res.data.metas[0].poster.includes('https://archive.org/services/img/'));
  });

  await testAsync('GET /:config/stream/movie/Night.Of.The.Living.Dead_1080p.json returns authenticated streams', async () => {
    const res = await axios.get(`${baseUrl}/${b64Auth}/stream/movie/Night.Of.The.Living.Dead_1080p.json`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data.streams));
    assert(res.data.streams.length > 0, 'Expected at least 1 stream');

    const firstStream = res.data.streams[0];
    assert(firstStream.title.startsWith('[Archive.org]'));
    assert(firstStream.url.startsWith('https://archive.org/download/'));
    assert.strictEqual(firstStream.behaviorHints.notSupported, false);
    assert.strictEqual(firstStream.behaviorHints.proxyHeaders.request.Authorization, 'LOW test_access:test_secret');
  });

  await testAsync('GET /stream/movie/tt0063350.json resolves IMDb title and returns streams', async () => {
    const res = await axios.get(`${baseUrl}/stream/movie/tt0063350.json`);
    assert.strictEqual(res.status, 200);
    assert(Array.isArray(res.data.streams));
    assert(res.data.streams.length > 0, 'Expected streams resolved from IMDb ID');
    assert(res.data.streams[0].title.includes('Night of the Living Dead'));
  });

  console.log('\n============================================');
  console.log(` Test Summary: ${passed} passed, ${failed} failed`);
  console.log('============================================\n');

  // Close server and exit
  server.close(() => {
    process.exit(failed > 0 ? 1 : 0);
  });
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
