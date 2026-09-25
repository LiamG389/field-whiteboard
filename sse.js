// Serialize snapshots a slide at a time; never create one presentation-sized JSON event.
export function* snapshotEvents(state) {
  const { strokes, ...metadata } = state;
  yield ['snapshot-start', metadata];
  const pages = new Map(state.pages.map(page => [page.id, []]));
  for (const item of Object.values(strokes)) pages.get(item.pageId || 'page-1')?.push(item);
  for (const [index, page] of state.pages.entries()) {
    yield ['snapshot-page', { id: page.id, index }];
    for (const item of pages.get(page.id)) yield ['snapshot-item', item];
    yield ['snapshot-page-end', { id: page.id }];
  }
  yield ['snapshot-end', { revision: state.revision }];
}
export function createEventWriter(response, snapshot, recovery = () => [], paged = false, streamId = 'stream') {
  let queue = [], queuedBytes = 0, iterator = null, active = null, offset = 0, blocked = false, closed = false, awaitingAck = null, checkpoint = 0, activeCheckpoint = null;
  const encode = (event, data) => Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  function* frames(event, data) {
    if (event === 'snapshot' && paged) {
      for (const frame of snapshotEvents(data)) {
        yield frame;
        if (frame[0] === 'snapshot-page-end') yield ['sync-checkpoint', { token: `${streamId}-${++checkpoint}` }];
      }
    } else {
      yield [event, data];
      if (paged && event === 'edit' && data.importPage) yield ['sync-checkpoint', { token: `${streamId}-${++checkpoint}` }];
    }
  }
  const entry = (event, data) => ({ frames: frames(event, data), bytes: event === 'snapshot' ? 0 : Buffer.byteLength(JSON.stringify(data)) });
  function flush() {
    if (closed || blocked || awaitingAck) return;
    while (active || iterator || queue.length) {
      if (!active) {
        if (!iterator) { const next = queue.shift(); queuedBytes -= next.bytes; iterator = next.frames; }
        const frame = iterator.next();
        if (frame.done) { iterator = null; continue; }
        active = encode(...frame.value); offset = 0;
        activeCheckpoint = frame.value[0] === 'sync-checkpoint' ? frame.value[1].token : null;
      }
      const end = Math.min(offset + 64 * 1024, active.length);
      const chunk = active.subarray(offset, end); offset = end;
      if (offset === active.length) { active = null; awaitingAck = activeCheckpoint; }
      if (!response.write(chunk)) { blocked = true; return; }
      if (awaitingAck) return;
    }
  }
  response.on('drain', () => { blocked = false; flush(); });
  response.on('close', () => { closed = true; queue = []; iterator = null; active = null; queuedBytes = 0; });
  const send = (event, data) => {
    if (closed) return;
    if (queuedBytes > 4 * 1024 * 1024) {
      // Finish the active snapshot/event, then replace waiting edits with current state.
      queue = [entry('snapshot', snapshot()), ...recovery().map(([name, value]) => entry(name, value))];
      queuedBytes = queue.reduce((size, message) => size + message.bytes, 0);
    }
    const message = entry(event, data);
    queue.push(message); queuedBytes += message.bytes; flush();
  };
  send.ack = token => { if (token === awaitingAck) { awaitingAck = null; flush(); } };
  return send;
}
