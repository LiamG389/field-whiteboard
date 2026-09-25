import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { testPageImage } from './png-fixture.js';
import jsQR from 'jsqr';
import { makeExport } from './exports.js';
import { PNG } from 'pngjs';

test('LAN sync: live previews, concurrent edits, retries, isolation, persistence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'field-test-'));
  const port = 54329, origin = `http://127.0.0.1:${port}`;
  const board = 'a'.repeat(32), other = 'b'.repeat(32);
  let child;
  const controllers = [];
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT: String(port), DATA_DIR: directory, DISCOVERY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('Server exited: ' + code))); });
  }
  async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  async function stream(id = board, clientId = 'client-' + controllers.length, name = 'Guest', paged = false) {
    const controller = new AbortController(); controllers.push(controller);
    const res = await fetch(`${origin}/api/events?board=${id}&clientId=${clientId}&name=${encodeURIComponent(name)}${paged ? "&sync=2" : ""}`, { signal: controller.signal });
    assert.equal(res.status, 200);
    const messages = [], decoder = new TextDecoder(); let buffer = '', assembly;
    (async () => { try { for await (const chunk of res.body) { buffer += decoder.decode(chunk, { stream: true }); let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const part = buffer.slice(0, end); buffer = buffer.slice(end + 2); const match = part.match(/^event: (.+)\ndata: (.+)$/); if (match) {
          const event = match[1], data = JSON.parse(match[2]);
          if (event === 'snapshot-start') assembly = { ...data, strokes: {} };
          if (event === 'snapshot-item') assembly.strokes[data.id] = data;
          if (event === 'snapshot-end') messages.push({ event: 'snapshot', data: assembly });
          if (event === 'sync-checkpoint') await send('sync-ack', { clientId, token: data.token }, id);
          messages.push({ event, data });
        } } } } catch {} })();
    return async (event, predicate = () => true) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) { const item = messages.find(m => m.event === event && predicate(m.data)); if (item) return item.data; await new Promise(r => setTimeout(r, 10)); }
      throw new Error('Timed out waiting for ' + event);
    };
  }
  const send = (route, value, id = board, extra = {}) => fetch(`${origin}/api/${route}?board=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  const stroke = id => ({ id, color: '#263b36', width: 3, points: [[-20, 12, .5], [12, 24, .8]] });
  try {
    await start();
    for (const file of ['/', '/app.js', '/model.js', '/vocab-pen.js', '/style.css', '/favicon.svg', '/favicon.png', '/cache.js']) assert.equal((await fetch(origin + file)).status, 200);
    const a = await stream(board, 'writer-a', 'Alice'), b = await stream(board, 'writer-b', 'Bob', true), isolated = await stream(other);
    assert.equal((await a('snapshot')).revision, 0);
    assert.equal((await isolated('snapshot')).revision, 0);
    assert.deepEqual((await a('presence', p => p.count === 2)).users.map(user => user.name), ['Alice', 'Bob']);
    assert.equal((await send('profile', { clientId: 'writer-a', name: 'Alice’s iPad' })).status, 200);
    assert.equal((await b('presence', p => p.users.some(user => user.name === 'Alice’s iPad'))).users[0].id, 'writer-a');
    const joinURL = `http://192.168.68.107:53318/?board=${board}`;
    const qr = await fetch(`${origin}/api/qr?board=${board}&url=${encodeURIComponent(joinURL)}`);
    assert.equal(qr.status, 200); assert.equal(qr.headers.get('content-type'), 'image/png');
    const png = PNG.sync.read(Buffer.from(await qr.arrayBuffer()));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.equal(decoded.data, joinURL);
    assert.equal((await fetch(`${origin}/api/qr?board=${board}&url=${encodeURIComponent('javascript:alert(1)')}`)).status, 400);
    assert.equal((await send('draft', { id: 's1', clientId: 'writer-a', stroke: stroke('s1') })).status, 200);
    assert.equal((await b('draft')).stroke.id, 's1');
    assert.equal((await b('draft')).clientId, 'writer-a');
    const op1 = { id: 'op1', clientId: 'writer-a', type: 'put', stroke: stroke('s1') }, op2 = { id: 'op2', type: 'put', stroke: stroke('s2') };
    const results = await Promise.all([send('edit', op1), send('edit', op2)]);
    assert.ok(results.every(r => r.status === 200));
    await a('edit', e => e.id === 'op2'); assert.equal((await b('edit', e => e.id === 'op1')).clientId, 'writer-a');
    assert.equal((await (await send('edit', op1)).json()).revision, 2);
    assert.equal((await send('edit', { id: 'bad', type: 'put', stroke: { ...stroke('bad'), points: [[null, 0, .5]] } })).status, 400);
    assert.equal((await send('edit', { id: 'cross', type: 'title', title: 'No' }, board, { Origin: 'http://elsewhere.example' })).status, 403);
    assert.equal((await fetch(origin + '/api/events?board=../../etc/passwd')).status, 400);
    assert.equal((await send('edit', { id: 'delete1', type: 'delete', strokeId: 's1' })).status, 200);
    assert.equal((await send('edit', { id: 'restore1', type: 'put', stroke: stroke('s1') })).status, 200);
    assert.equal((await send('edit', { id: 'title1', type: 'title', title: 'Test board' })).status, 200);
    assert.equal((await send('edit', { id: 'page-add', type: 'page-add', page: { id: 'page2', title: 'Second page' } })).status, 200);
    await b('edit', op => op.type === 'page-add');
    const box = { id: 'text1', pageId: 'page2', kind: 'text', text: 'Colored text\nSecond line', formats: [{ start: 0, end: 7, bold: true }, { start: 13, end: 19, italic: true }], color: '#cc816e', background: '#edf3df', fontSize: 28, boxWidth: 320, x: -500, y: 900 };
    assert.equal((await send('edit', { id: 'text-put', type: 'put', stroke: box })).status, 200);
    assert.equal((await a('edit', op => op.id === 'text-put')).stroke.pageId, 'page2');
    assert.equal((await send('draft', { id: 'page2draft', stroke: { ...stroke('page2draft'), pageId: 'page2' } })).status, 200);
    assert.equal((await b('draft', draft => draft.id === 'page2draft')).stroke.pageId, 'page2');
    assert.equal((await send('edit', { id: 'bad-page', type: 'put', stroke: { ...box, pageId: 'missing' } })).status, 400);
    assert.equal((await send('edit', { id: 'bad-text', type: 'put', stroke: { ...box, fontSize: -1 } })).status, 400);
    const photo = { id: 'photo', pageId: 'page2', kind: 'image', color: '#000000', x: 20, y: 30, imageWidth: 640, imageHeight: 360, data: testPageImage() };
    assert.equal((await send('edit', { id: 'photo-put', type: 'put', stroke: photo })).status, 200);
    assert.equal((await b('edit', op => op.id === 'photo-put')).stroke.data, photo.data);
    assert.equal((await send('edit', { id: 'background', type: 'page-background', pageId: 'page2', color: '#ddeeaa' })).status, 200);
    assert.equal((await send('edit', { id: 'bad-image', type: 'put', stroke: { ...photo, data: 'https://example.com/image.png' } })).status, 400);
    const activity = { clientId: 'writer-a', pageId: 'page2', x: 800, y: -120, zoom: 2.5 };
    assert.equal((await send('activity', activity)).status, 200);
    assert.deepEqual(await b('activity', item => item.x === 800), activity);
    assert.equal((await send('activity', { ...activity, zoom: -1 })).status, 400);
    assert.equal((await send('activity', { ...activity, pageId: 'page-1', x: null, y: null })).status, 200);
    assert.equal((await b('activity', item => item.x === null)).pageId, 'page-1');
    assert.equal((await send('activity', { ...activity, pageId: 'missing' })).status, 400);
    assert.equal((await send('follow', { clientId: 'writer-b', targetId: 'writer-a', followZoom: false })).status, 200);
    assert.deepEqual(await a('following', relation => relation.clientId === 'writer-b'), { clientId: 'writer-b', targetId: 'writer-a', followZoom: false });
    const focus = { clientId: 'writer-a', pageId: 'page2', x: 240, y: -90, zoom: 1.75 };
    assert.equal((await send('focus', focus)).status, 200);
    assert.deepEqual(await b('focus', item => item.clientId === 'writer-a'), focus);
    assert.equal((await send('focus', { ...focus, zoom: 9 })).status, 400);
    const rezoom = { clientId: 'writer-a', zoom: 2.25 };
    assert.equal((await send('rezoom', rezoom)).status, 200);
    assert.deepEqual(await b('rezoom', item => item.clientId === 'writer-a'), rezoom);
    assert.equal((await send('follow', { clientId: 'writer-b', targetId: 'writer-a', followZoom: true })).status, 200);
    assert.equal((await send('rezoom', rezoom)).status, 400);
    const presentation = await makeExport({ format: 'pptx', title: 'Import test', pages: [{ image: testPageImage() }] });
    const imported = await send('import-pptx', { name: 'Import test.pptx', data: presentation.buffer.toString('base64') });
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).pages.length, 1);
    const pdf = await send('export', { format: 'pdf', title: 'Test board', pages: [{ image: testPageImage() }] });
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).toString('latin1').startsWith('%PDF-'));
    controllers[1].abort();
    await a('presence', p => p.count === 1 && p.users[0].name === 'Alice’s iPad');
    controllers.forEach(c => c.abort()); await stop(); await start();
    const resumed = await stream(); const snapshot = await resumed('snapshot');
    assert.equal(snapshot.title, 'Test board'); assert.equal(snapshot.revision, 9);
    assert.deepEqual(Object.keys(snapshot.strokes).sort(), ['photo', 's1', 's2', 'text1']);
    assert.equal(snapshot.pages.length, 2); assert.deepEqual(snapshot.strokes.text1, box);
    assert.equal(snapshot.pages[1].background, '#ddeeaa'); assert.deepEqual(snapshot.strokes.photo, photo);
    const otherStream = await stream(other); assert.deepEqual((await otherStream('snapshot')).strokes, {});
    assert.equal((await (await send('edit', op1)).json()).revision, 9);
    // Reconnecting tablets receive a presentation larger than localStorage's quota
    // in individual acknowledged slides, not a single multi-megabyte SSE event.
    for (let i = 0; i < 6; i++) {
      const pageId = 'large-page-' + i;
      assert.equal((await send('edit', { id: 'large-add-' + i, type: 'page-add', page: { id: pageId, title: 'Slide ' + i } }, other)).status, 200);
      const image = { ...photo, id: 'large-image-' + i, pageId, data: 'data:image/png;base64,' + 'A'.repeat(1000000) };
      assert.equal((await send('edit', { id: 'large-put-' + i, type: 'put', stroke: image, importPage: pageId }, other)).status, 200);
    }
    const tablet = await stream(other, 'tablet', 'Tablet', true);
    const large = await tablet('snapshot');
    assert.equal(Object.keys(large.strokes).length, 6);
    assert.equal(large.strokes['large-image-5'].data.length, 1000022);
    assert.equal((await send('edit', { id: 'after-large', type: 'title', title: 'Still connected' }, other)).status, 200);
    await tablet('edit', op => op.id === 'after-large');
  } finally { controllers.forEach(c => c.abort()); await stop(); await rm(directory, { recursive: true, force: true }); }
});
