import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventWriter } from './sse.js';

class SlowResponse extends EventEmitter {
  chunks = [];
  write(chunk) { this.chunks.push(chunk); return false; }
  finish() { for (let i = 0; i < 1000; i++) this.emit('drain'); }
  events() { return Buffer.concat(this.chunks).toString().trim().split('\n\n').map(message => { const [event, data] = message.split('\n'); return { event: event.slice(7), data: JSON.parse(data.slice(6)) }; }); }
}
test('a slow peer receives a snapshot larger than 4 MB and subsequent edits intact', () => {
  const response = new SlowResponse(), state = { revision: 12, image: 'a'.repeat(6 * 1024 * 1024) };
  const send = createEventWriter(response, () => state);
  send('snapshot', state); send('presence', { count: 2 }); send('edit', { revision: 13 });
  assert.equal(response.chunks.length, 1, 'waits for drain before writing more');
  response.finish();
  assert.deepEqual(response.events(), [{ event: 'snapshot', data: state }, { event: 'presence', data: { count: 2 } }, { event: 'edit', data: { revision: 13 } }]);
  assert.ok(response.chunks.every(chunk => chunk.length <= 64 * 1024));
});
test('a slow peer catches up through a snapshot without truncating an in-progress event', () => {
  const response = new SlowResponse(); let state = { revision: 0 };
  const send = createEventWriter(response, () => state);
  send('snapshot', state);
  for (let revision = 1; revision <= 12; revision++) { state = { revision }; send('edit', { revision, image: 'x'.repeat(900000) }); }
  response.finish();
  const events = response.events();
  assert.equal(events[0].data.revision, 0);
  assert.ok(events.some(event => event.event === 'snapshot' && event.data.revision > 0));
  assert.equal(events.at(-1).data.revision, 12);
});

test('paged snapshots wait for each slide acknowledgement and preserve later edits', () => {
  const response = new SlowResponse();
  const state = { revision: 8, pages: [{id:'one'}, {id:'two'}], strokes: {a:{id:'a',pageId:'one',data:'a'.repeat(1000000)},b:{id:'b',pageId:'two',data:'b'.repeat(1000000)}} };
  const send = createEventWriter(response, () => state, () => [], true);
  send('snapshot', state); send('edit', { revision: 9 }); response.finish();
  let events = response.events();
  assert.equal(events.filter(e => e.event === 'snapshot-page').length, 1);
  assert.equal(events.at(-1).event, 'sync-checkpoint');
  send.ack('wrong-token'); response.finish();
  assert.equal(response.events().length, events.length);
  send.ack(events.at(-1).data.token); response.finish();
  events = response.events();
  assert.equal(events.filter(e => e.event === 'snapshot-page').length, 2);
  assert.equal(events.some(e => e.event === 'snapshot-end'), false);
  send.ack(events.at(-1).data.token); response.finish();
  events = response.events();
  assert.equal(events.at(-2).event, 'snapshot-end');
  assert.equal(events.at(-1).data.revision, 9);
});
