'use strict';
const $ = id => document.getElementById(id);
const uid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
let boardId = new URLSearchParams(location.search).get('board');
if (!/^[a-f0-9]{32}$/.test(boardId || '')) {
  try { boardId = localStorage.getItem('field-last-board'); } catch {}
  if (!/^[a-f0-9]{32}$/.test(boardId || '')) boardId = uid();
  history.replaceState(null, '', '?board=' + boardId);
}
try { localStorage.setItem('field-last-board', boardId); } catch {}
const storageKey = 'field-' + boardId;
let clientId = uid(), displayName = 'Guest';
try { clientId = sessionStorage.getItem('field-client') || clientId; sessionStorage.setItem('field-client', clientId); displayName = localStorage.getItem('field-name') || 'Guest'; } catch {}
let connectedUsers = [], followedId = null, followTarget = null, followGoal = null;
const followers = new Map();
let focusMode = false, focusAnimation = null, focusInputUntil = 0;
const writerPositions = new Map(), activityWriters = new Set();
const model = globalThis.FieldModel;
let currentPageId = model.FIRST_PAGE;
try { currentPageId = localStorage.getItem(storageKey + '-page') || currentPageId; } catch {}
const pageCameras = new Map();
let editingText = null, editingImage = null;
const imageAssets = new Map();
let followMode = 'both', followZoom = false, lastSentZoom = null;
try { followZoom = localStorage.getItem('field-follow-zoom') === 'true'; } catch {}
let compactMenus = { header: true, pages: true, palette: false, bottom: true, hints: true };
try { compactMenus = { ...compactMenus, ...JSON.parse(localStorage.getItem('field-compact-menus') || '{}') }; followMode = localStorage.getItem('field-follow-mode') || 'both'; } catch {}
if (!['pointer', 'slide', 'both'].includes(followMode)) followMode = 'both';
let localActivity = null, activityDirty = true, activitySending = false;
// Keep the current board and any queued edits open while starting a fresh one.
$('new-board').href = '/?board=' + uid();
$('new-board').onclick = () => { $('new-board').href = '/?board=' + uid(); };
const canvas = $('board'), ctx = canvas.getContext('2d');
const inkCache = document.createElement('canvas'), inkCtx = inkCache.getContext('2d');
let inkKey = '';
const submittedEdits = new Set();
let state = { title: 'Untitled board', strokes: {}, revision: 0 }, pending = [];
try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved) { state = saved.state; pending = saved.pending || []; } } catch {}
model.normalize(state);
let online = false, pumping = false, participants = 1, renderQueued = false;
let camera = { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
let autoFit = false;
let compactMode = false, compactExpanded = false;
try { compactMode = localStorage.getItem('field-compact-mode') === 'true'; } catch {}
try { autoFit = localStorage.getItem(storageKey + '-auto-fit') === 'true'; } catch {}
let tool = 'pen', color = '#263b36', width = 3, space = false;
let active = null, pan = null, dirtyDraft = false, draftSending = false;
const remote = new Map(), undoStack = [], redoStack = [];
let cacheTimer, toastTimer, storageFailed = false, restoringCache = true;
let incomingSnapshot = null;
const receivedEdits = new Set();
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500); }
async function restoreCache() {
  try {
    const saved = await globalThis.FieldCache?.read(storageKey);
    if (saved) {
      if (!online && state.revision === 0) state = model.normalize(saved.state);
      const known = new Set([...pending.map(op => op.id), ...(state.receipts || []), ...receivedEdits]);
      pending.unshift(...(saved.pending || []).filter(op => !known.has(op.id)));
    }
  } catch { /* The host remains authoritative when browser storage is unavailable. */ }
  restoringCache = false; cache(); status(); redraw(); pump();
}
function cache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(async () => {
    if (active || pan || restoringCache || incomingSnapshot) { cache(); return; }
    try {
      if (!globalThis.FieldCache) return;
      await FieldCache.write(storageKey, { state, pending });
      // Remove the old bulky cache only after its replacement is safely saved.
      localStorage.removeItem(storageKey); storageFailed = false;
    } catch {
      if (!storageFailed && pending.length) toast('Browser backup unavailable. Keep this tab open until your edits are saved on the host.');
      storageFailed = true;
    }
  }, 1500);
}
function apply(target, op) {
  model.apply(target, op);
}
function view() {
  const result = { ...state, pages: state.pages.map(p => ({ ...p })), strokes: { ...state.strokes } };
  pending.forEach(op => apply(result, op));
  return result;
}
function pageView() {
  const result = view();
  result.strokes = Object.fromEntries(Object.entries(result.strokes).filter(([, item]) => model.pageOf(item) === currentPageId));
  return result;
}
const pageDrafts = () => [...remote.values()].filter(d => model.pageOf(d.stroke) === currentPageId);
function status() {
  $('dot').classList.toggle('online', online);
  $('status').textContent = online ? `${participants === 1 ? 'Just you' : participants + ' people'} · Local network` : 'Offline · edits queued';
  $('save').textContent = pending.length ? `${pending.length} unsaved edit${pending.length === 1 ? '' : 's'}` : online ? 'Saved on host' : 'On this device';
  $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length;
  updatePages();
}
function enqueue(op) {
  pending.push({ ...op, id: uid() });
  if (op.type === 'title') $('title').value = view().title;
  cache(); status(); redraw(); pump();
}
async function post(route, data) {
  const response = await fetch(`/api/${route}?board=${boardId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, clientId }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error((await response.json()).error || 'Could not save edit');
  return response.json();
}
function pauseImport() { return new Promise(resolve => setTimeout(resolve, 40)); }
async function pump() {
  if (pumping || !online || restoringCache) return;
  pumping = true;
  try {
    while (online) {
      const op = pending.find(item => !submittedEdits.has(item.id));
      if (!op) break;
      const waitingPage = pending.find(item => item.importPage && submittedEdits.has(item.id))?.importPage;
      if (waitingPage && op.importPage && waitingPage !== op.importPage) break;
      // HTTP acknowledgement allows the next upload; only the ordered SSE echo
      // removes optimistic content. Large imports need not wait for each echo.
      await post('edit', op);
      if (op.importPage) {
        // Pace imported objects, and finish this slide before uploading the next.
        await pauseImport();
      }
      if (pending.some(item => item.id === op.id)) submittedEdits.add(op.id);
    }
  } catch (error) { toast('Edits are queued. ' + error.message); }
  finally { pumping = false; status(); }
}
const events = new EventSource(`/api/events?board=${boardId}&clientId=${clientId}&name=${encodeURIComponent(displayName)}&sync=2`);
events.addEventListener('sync-checkpoint', event => {
  const { token } = JSON.parse(event.data);
  const acknowledge = () => post('sync-ack', { token }).catch(() => setTimeout(acknowledge, 1000));
  acknowledge();
});
function acceptSnapshot(snapshot) {
  incomingSnapshot = null;
  submittedEdits.clear(); activityWriters.clear(); followers.clear(); updateFocusControl();
  state = model.normalize(snapshot);
  pending = pending.filter(op => !snapshot.receipts.includes(op.id));
  remote.clear(); online = true;
  if (document.activeElement !== $('title')) $('title').value = view().title;
  cache(); status(); redraw(); pump();
  post('profile', { name: displayName }).catch(() => {}); queueActivity(null);
}
events.addEventListener('snapshot', event => acceptSnapshot(JSON.parse(event.data)));
events.addEventListener('snapshot-start', event => {
  incomingSnapshot = { ...JSON.parse(event.data), strokes: {} };
  online = false; status();
});
events.addEventListener('snapshot-page', event => {
  const page = JSON.parse(event.data);
  if (incomingSnapshot) $('status').textContent = `Receiving slide ${page.index + 1} of ${incomingSnapshot.pages.length}…`;
});
events.addEventListener('snapshot-item', event => {
  const item = JSON.parse(event.data);
  if (incomingSnapshot) incomingSnapshot.strokes[item.id] = item;
});
events.addEventListener('snapshot-end', () => { if (incomingSnapshot) acceptSnapshot(incomingSnapshot); });
events.addEventListener('edit', event => {
  const op = JSON.parse(event.data);
  if (op.revision > state.revision) { apply(state, op); state.revision = op.revision; }
  receivedEdits.add(op.id);
  submittedEdits.delete(op.id);
  pending = pending.filter(item => item.id !== op.id);
  remote.delete(op.stroke?.id || op.strokeId);
  if (op.type === 'put') noteWriter(op.clientId, op.stroke);
  if (document.activeElement !== $('title')) $('title').value = view().title;
  cache(); status(); redraw(); pump();
});
events.addEventListener('draft', event => {
  const draft = JSON.parse(event.data);
  if (draft.stroke && draft.id !== active?.stroke?.id && !view().strokes[draft.id]) remote.set(draft.id, { stroke: draft.stroke, time: Date.now() });
  else remote.delete(draft.id);
  if (draft.stroke) noteWriter(draft.clientId, draft.stroke);
  redraw();
});
events.addEventListener('presence', event => {
  const data = JSON.parse(event.data); participants = data.count; connectedUsers = data.users || [];
  if (followedId && !connectedUsers.some(user => user.id === followedId)) { followGoal = null; followTarget = null; }
  updateFollowControls(); status(); redraw();
});
events.onerror = () => { incomingSnapshot = null; online = false; followGoal = null; followTarget = null; updateFollowControls(); status(); };
setInterval(() => { if (online) pump(); for (const [id, d] of remote) if (Date.now() - d.time > 16000) { remote.delete(id); redraw(); } }, 2000);

function world(e) { return [(e.clientX - camera.x) / camera.z, (e.clientY - camera.y) / camera.z, e.pressure || .5]; }
function stroke(ctx, s, alpha = 1) {
  if (s.kind === 'image') { const asset = imageAsset(s.data); if (asset.image.complete && asset.image.naturalWidth) { ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(asset.image, s.x, s.y, s.imageWidth, s.imageHeight); ctx.restore(); } return; }
  if (s.kind === 'shape') {
    ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = s.fill; ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
    if (s.shape === 'ellipse') ctx.ellipse(s.x+s.imageWidth/2,s.y+s.imageHeight/2,s.imageWidth/2,s.imageHeight/2,0,0,Math.PI*2);
    else if (s.shape === 'line') { ctx.moveTo(s.x,s.y);ctx.lineTo(s.x+s.imageWidth,s.y+s.imageHeight); }
    else ctx.rect(s.x,s.y,s.imageWidth,s.imageHeight);
    if (s.fill !== 'transparent' && s.shape !== 'line') ctx.fill(); ctx.stroke(); ctx.restore(); return;
  }
  if (s.kind === 'text') { drawText(ctx, s, alpha); return; }
  ctx.globalAlpha = alpha; ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.points.length === 1) { const p = s.points[0]; ctx.beginPath(); ctx.arc(p[0], p[1], s.width * (.4 + p[2] * .6) / 2, 0, Math.PI * 2); ctx.fill(); }
  for (let i = 1; i < s.points.length; i++) {
    const a = s.points[i - 1], b = s.points[i];
    ctx.lineWidth = s.width * (.4 + (a[2] + b[2]) * .3);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function redraw() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(render); } }
function render() {
  renderQueued = false;
  if (!stepFocusAnimation()) updateAutoFollow();
  updateAutoFit();
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(innerWidth * dpr) || canvas.height !== Math.round(innerHeight * dpr)) { canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = pageBackground(); ctx.fillRect(0, 0, innerWidth, innerHeight);
  let grid = 24 * camera.z;
  while (grid < 14) grid *= 4;
  while (grid > 90) grid /= 4;
  ctx.fillStyle = '#dce2d5';
  for (let x = ((camera.x % grid) + grid) % grid; x < innerWidth; x += grid) for (let y = ((camera.y % grid) + grid) % grid; y < innerHeight; y += grid) { ctx.beginPath(); ctx.arc(x, y, .8, 0, Math.PI * 2); ctx.fill(); }
  ctx.translate(camera.x, camera.y); ctx.scale(camera.z, camera.z);
  const visible = pageView();
  // Like vocab.html, cache settled ink so fast pen samples only draw active ink.
  // Camera changes invalidate the bitmap; world coordinates remain unbounded.
  const key = [currentPageId, active?.text ? JSON.stringify(active.text) : '', state.revision, ...pending.map(op => op.id), camera.x, camera.y, camera.z, canvas.width, canvas.height].join('|');
  if (key !== inkKey) {
    inkKey = key; inkCache.width = canvas.width; inkCache.height = canvas.height;
    inkCtx.setTransform(dpr * camera.z, 0, 0, dpr * camera.z, dpr * camera.x, dpr * camera.y);
    Object.values(visible.strokes).forEach(s => { if (s.id !== active?.text?.id) stroke(inkCtx, s); });
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(inkCache, 0, 0); ctx.restore();
  for (const { stroke: s } of pageDrafts()) stroke(ctx, s, .6);
  if (active?.text) stroke(ctx, active.text);
  if (active?.stroke) stroke(ctx, active.stroke);
  $('empty').hidden = !!(Object.keys(visible.strokes).length || active?.stroke || pageDrafts().length);
  $('zoom').textContent = Math.round(camera.z * 100) + '%';
}
function changeZoom(z, x = innerWidth / 2, y = innerHeight / 2) {
  stopFollowing();
  setAutoFit(false);
  const next = Math.max(.05, Math.min(8, z));
  camera.x = x - (x - camera.x) * next / camera.z; camera.y = y - (y - camera.y) * next / camera.z; camera.z = next; redraw();
}
function choose(next) { finish(); pan = null; tool = next; document.querySelectorAll('[data-tool]').forEach(b => { const selected = b.dataset.tool === tool; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected); }); canvas.style.cursor = tool === 'hand' ? 'grab' : 'crosshair'; }
function record(forward, backward) { enqueue(forward); undoStack.push({ forward, backward }); redoStack.length = 0; status(); }
function finish(discard = false) {
  if (penEngine.currentStroke) {
    if (discard) penEngine._discardActiveStroke(); else penEngine._finishActiveStroke();
    return;
  }
  if (!active) return;
  const old = active; active = null; dirtyDraft = false;
  if (old.text && old.moved && !discard) record({ type: 'put', stroke: old.text }, { type: 'put', stroke: old.original });
  if (old.stroke) {
    remote.delete(old.stroke.id);
    if (!discard) record({ type: 'put', stroke: old.stroke }, { type: 'delete', strokeId: old.stroke.id });
    // Chain cancellation after an in-flight preview so it cannot reappear.
    const cancel = () => post('draft', { id: old.stroke.id }).catch(() => {});
    if (online) { if (draftSending) draftSending.finally(cancel); else cancel(); }
  }
  if (old.erased?.length) {
    undoStack.push({ group: old.erased }); redoStack.length = 0; status();
  }
  redraw();
}
function erase(point) {
  for (const s of Object.values(pageView().strokes)) {
    if (['text', 'image', 'shape'].includes(s.kind)) {
      if (textHit(s, point)) { active.erased.push({ forward: { type: 'delete', strokeId: s.id }, backward: { type: 'put', stroke: s } }); enqueue({ type: 'delete', strokeId: s.id }); }
      continue;
    }
    const r = 12 / camera.z + s.width / 2;
    const hit = s.points.some((b, i) => {
      const a = s.points[Math.max(0, i - 1)], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) <= r;
    });
    if (hit) { active.erased.push({ forward: { type: 'delete', strokeId: s.id }, backward: { type: 'put', stroke: s } }); enqueue({ type: 'delete', strokeId: s.id }); }
  }
}

// Adapted from vocab.html StrokeCanvas: stylus Touch Events take precedence,
// palms never enter the ink stream, and missing pen-down events self-heal.
// The input methods themselves are inherited unchanged from vocab-pen.js.
// This adapter translates coordinates and completed ink into document objects.
const penEngine = Object.create(StrokeCanvas.prototype);
Object.assign(penEngine, { canvas, tool: 'pen', strokes: [], currentStroke: null, activePointerId: null, drawing: false, erasing: false });
const penObjects = new WeakMap();
penEngine._toNorm = (x, y) => ({ x: (x - camera.x) / camera.z, y: (y - camera.y) / camera.z });
function penObject(s) {
  if (!penObjects.has(s)) penObjects.set(s, { id: uid(), pageId: currentPageId, color, width, points: [] });
  const result = penObjects.get(s);
  for (let i = result.points.length; i < s.points.length; i++) { const p = s.points[i]; result.points.push([p.x, p.y, p.p]); }
  return result;
}
function syncPenPreview() {
  if (penEngine.currentStroke) {
    active = { id: penEngine.activePointerId, source: penEngine.activeInputSource, started: penEngine.activeInputStartedAt, stroke: penObject(penEngine.currentStroke), legacy: true };
    dirtyDraft = true;
  } else if (active?.legacy) finish(true);
}
penEngine.redraw = () => { syncPenPreview(); redraw(); };
penEngine._appendStrokeToBase = () => {};
penEngine.onStrokeComplete = s => {
  active = { stroke: penObject(s), legacy: true };
  penEngine.strokes = []; finish();
};
const useStylusTouchEvents = !!(window.Touch && 'touchType' in window.Touch.prototype);
function down(e) {
  if ($('text-dialog').open || $('pages-dialog').open || $('download-dialog').open || $('share-dialog').open || $('follow-dialog').open || $('view-dialog').open || $('image-dialog').open) return;
  if (focusMode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const point = world(e); focusMode = false; focusInputUntil = Date.now() + 250; updateFocusControl();
    post('focus', { pageId: currentPageId, x: point[0], y: point[1], zoom: camera.z }).then(() => toast('Focused your followers.')).catch(error => toast(error.message));
    return;
  }
  if (Date.now() < focusInputUntil) return;
  if (tool === 'pen' && !space && e.button !== 1) {
    pan = null; penEngine._down(e); syncPenPreview(); redraw(); return;
  }
  if (e.pointerType === 'touch') {
    // Finger navigation is deliberately opt-in to preserve vocab's palm rejection.
    if (!['hand', 'text', 'select'].includes(tool) || active) return;
  } else if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
  const source = e.fromStylusTouch ? 'stylus-touch' : 'pointer';
  if (source === 'pointer' && active?.source === 'stylus-touch' && e.timeStamp - active.started < 80) return;
  if (source === 'stylus-touch' && active?.source === 'pointer' && e.timeStamp - active.lastSample < 80) {
    // Both streams describe this contact: transfer ownership without losing ink.
    active.id = e.pointerId; active.source = source; active.lastSample = e.timeStamp;
    e.preventDefault(); return;
  }
  e.preventDefault();
  if (tool === 'hand' || space || e.button === 1) {
    stopFollowing();
    setAutoFit(false);
    if (active) finish();
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    if (!e.fromStylusTouch) try { canvas.setPointerCapture(e.pointerId); } catch {}
    return;
  }
  pan = null;
  finish();
  if (!e.fromStylusTouch) try { canvas.setPointerCapture(e.pointerId); } catch {}
  active = { id: e.pointerId, source, started: e.timeStamp, lastSample: e.timeStamp };
  if (tool === 'text' || tool === 'select') {
    const point = world(e), hit = Object.values(pageView().strokes).reverse().find(s => (tool === 'text' ? s.kind === 'text' : ['text', 'image', 'shape'].includes(s.kind)) && textHit(s, point));
    if (hit) { active.text = { ...hit }; active.original = hit; active.startPoint = point; }
    else if (tool === 'select') active = null;
    else { active = null; openText({ id: uid(), pageId: currentPageId, kind: 'text', color, background: '#edf3df', fontSize: 28, boxWidth: 320, text: '', x: point[0], y: point[1] }); }
  }
  else if (tool === 'pen') { active.stroke = { id: uid(), pageId: currentPageId, color, width, points: [world(e)] }; dirtyDraft = true; }
  else { active.erased = []; erase(world(e)); }
  redraw();
}
function move(e) {
  if (Date.now() < focusInputUntil) return;
  if (pan?.id === e.pointerId) { camera.x += e.clientX - pan.x; camera.y += e.clientY - pan.y; pan.x = e.clientX; pan.y = e.clientY; redraw(); return; }
  if (tool === 'pen' && !pan && !space) {
    if ($('text-dialog').open || $('pages-dialog').open || $('download-dialog').open || $('share-dialog').open || $('follow-dialog').open || $('view-dialog').open || $('image-dialog').open) return;
    penEngine._move(e); syncPenPreview(); redraw(); return;
  }
  if (!active || e.pointerId !== active.id) return;
  active.lastSample = e.timeStamp;
  e.preventDefault();
  if (active.text) {
    const point = world(e), dx = point[0] - active.startPoint[0], dy = point[1] - active.startPoint[1];
    if (Math.hypot(dx, dy) * camera.z > 4) active.moved = true;
    if (active.moved) { active.text.x = active.original.x + dx; active.text.y = active.original.y + dy; redraw(); }
  } else if (active.stroke) {
    const samples = e.getCoalescedEvents?.() || [];
    for (const sample of samples.length ? samples : [e]) {
      const p = world(sample), points = active.stroke.points, last = points.at(-1);
      if (Math.hypot(last[0] - p[0], last[1] - p[1]) > .01) points.push(p);
      if (points.length >= 19000) { finish(); down(e); break; }
    }
    dirtyDraft = true; redraw();
  } else erase(world(e));
}
function up(e) {
  if (Date.now() < focusInputUntil) return;
  if (penEngine.activePointerId != null && e.pointerId === penEngine.activePointerId) { penEngine._up(e); syncPenPreview(); redraw(); return; }
  if (pan?.id === e.pointerId) { pan = null; return; }
  if (e.pointerId !== active?.id) return;
  const clickedText = active.text && !active.moved && !['pointercancel', 'lostpointercapture', 'touchcancel'].includes(e.type) ? active.text : null;
  if (active.stroke && !['pointercancel', 'lostpointercapture', 'touchcancel'].includes(e.type)) {
    const p = world(e), last = active.stroke.points.at(-1);
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > .01) active.stroke.points.push(p);
  }
  finish();
  if (clickedText) { if (clickedText.kind === 'image' || clickedText.kind === 'shape') openImage(clickedText); else openText(clickedText); }
}
canvas.addEventListener('pointerdown', down);
canvas.addEventListener('pointermove', move);
canvas.addEventListener('pointerrawupdate', move);
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
canvas.addEventListener('lostpointercapture', up);
window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
if (useStylusTouchEvents) {
  // Reuse the original touch filtering/conversion verbatim too. Route tools
  // outside the engine so text editing and panning remain separate from ink.
  const touchRouter = Object.create(StrokeCanvas.prototype);
  Object.defineProperty(touchRouter, 'activePointerId', { get: () => penEngine.activePointerId ?? active?.id ?? pan?.id });
  Object.assign(touchRouter, { _down: down, _move: move, _up: up });
  canvas.addEventListener('touchstart', e => touchRouter._touchStart(e), { passive: false });
  canvas.addEventListener('touchmove', e => touchRouter._touchMove(e), { passive: false });
  window.addEventListener('touchend', e => touchRouter._touchEnd(e), { passive: false });
  window.addEventListener('touchcancel', e => touchRouter._touchEnd(e), { passive: false });
}

setInterval(() => {
  if (!online || !dirtyDraft || !active?.stroke || draftSending) return;
  dirtyDraft = false;
  draftSending = post('draft', { id: active.stroke.id, stroke: active.stroke }).catch(() => {}).finally(() => { draftSending = false; });
}, 60);
canvas.addEventListener('wheel', e => { e.preventDefault(); if (!active) changeZoom(camera.z * Math.exp(-e.deltaY * .002), e.clientX, e.clientY); }, { passive: false });
window.addEventListener('resize', redraw);
window.addEventListener('blur', () => { finish(); pan = null; space = false; });
window.addEventListener('beforeunload', e => { if (pending.length || active?.stroke) { e.preventDefault(); e.returnValue = ''; } });

document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => choose(b.dataset.tool));
function setColor(value) { color = value; $('color').value = value; document.querySelectorAll('#colors button').forEach(b => { b.classList.toggle('active', b.dataset.color === color); b.setAttribute('aria-pressed', b.dataset.color === color); }); }
for (const [value, name] of [['#263b36', 'Graphite'], ['#71915d', 'Moss'], ['#6385b8', 'Blue'], ['#cc816e', 'Terracotta'], ['#b49bc3', 'Lavender']]) {
  const b = document.createElement('button'); b.dataset.color = value; b.style.background = value; b.title = name; b.setAttribute('aria-label', name + ' ink'); b.onclick = () => setColor(value); $('colors').append(b);
}
setColor(color);
$('color').oninput = e => setColor(e.target.value);
$('width').onclick = () => { const sizes = [1.5, 3, 6, 10]; width = sizes[(sizes.indexOf(width) + 1) % sizes.length]; $('width').innerHTML = `●<small>${width}</small>`; $('width').setAttribute('aria-label', 'Stroke width: ' + width); };
function historyAction(from, to, reverse) {
  finish(); const entry = from.pop(); if (!entry) return;
  if (entry.forwardOps) {
    for (const op of reverse ? entry.backwardOps : entry.forwardOps) enqueue(op);
    to.push(entry); status(); return;
  }
  const ops = entry.group || [entry];
  for (const item of reverse ? [...ops].reverse() : ops) enqueue(reverse ? item.backward : item.forward);
  to.push(entry); status();
}
$('undo').onclick = () => historyAction(undoStack, redoStack, true);
$('redo').onclick = () => historyAction(redoStack, undoStack, false);
$('in').onclick = () => changeZoom(camera.z * 1.25);
$('out').onclick = () => changeZoom(camera.z / 1.25);
$('zoom').onclick = () => changeZoom(1);
function bounds(strokes) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of strokes) {
    if (s.kind === 'image' || s.kind === 'shape') { x1 = Math.min(x1,s.x); y1 = Math.min(y1,s.y); x2 = Math.max(x2,s.x+s.imageWidth); y2 = Math.max(y2,s.y+s.imageHeight); }
    else if (s.kind === 'text') { const layout = textLayout(s); x1 = Math.min(x1, s.x); y1 = Math.min(y1, s.y); x2 = Math.max(x2, s.x + s.boxWidth); y2 = Math.max(y2, s.y + layout.height); }
    else for (const p of s.points) { x1 = Math.min(x1, p[0] - s.width); y1 = Math.min(y1, p[1] - s.width); x2 = Math.max(x2, p[0] + s.width); y2 = Math.max(y2, p[1] + s.width); }
  }
  return { x1, y1, x2, y2 };
}
function fitCamera(strokes, maxZoom = 8) {
  if (!strokes.length) return camera;
  const b = bounds(strokes);
  // Leave room for the top bar, left tools, and bottom controls on each device.
  const { left, right, top, bottom } = viewInsets(innerWidth);
  const w = Math.max(1, innerWidth - left - right), h = Math.max(1, innerHeight - top - bottom);
  const z = Math.min(maxZoom, w / Math.max(1, b.x2 - b.x1), h / Math.max(1, b.y2 - b.y1));
  return { z, x: left + w / 2 - (b.x1 + b.x2) / 2 * z, y: top + h / 2 - (b.y1 + b.y2) / 2 * z };
}
function updateAutoFit() {
  // Moving the camera under an active pen would distort the user's next sample.
  // Other devices follow live previews; this device catches up on pen lift.
  if (!autoFit || active || pan) return;
  const strokes = [...Object.values(pageView().strokes), ...pageDrafts().map(d => d.stroke)];
  if (!strokes.length) return;
  const fitted = fitCamera(strokes);
  // Keep writing readable: Auto-fit waits for content to come back within this
  // scale instead of zooming the entire page below 42.5%.
  if (fitted.z >= .425) camera = fitted;
}
function setAutoFit(enabled) {
  if (enabled && (followMode !== 'slide' || followZoom)) stopFollowing();
  autoFit = enabled;
  $('auto-fit').setAttribute('aria-pressed', String(enabled));
  try { localStorage.setItem(storageKey + '-auto-fit', String(enabled)); } catch {}
  redraw();
}
$('auto-fit').setAttribute('aria-pressed', String(autoFit));
$('auto-fit').onclick = () => { setAutoFit(!autoFit); if (autoFit) toast('Auto-fit on for this device. Pan or zoom to turn it off.'); };
$('fit').onclick = () => {
  if (active) return;
  stopFollowing();
  const strokes = [...Object.values(pageView().strokes), ...pageDrafts().map(d => d.stroke)];
  if (!strokes.length) camera = { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
  else camera = fitCamera(strokes);
  redraw();
};
window.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select') || $('share-dialog').open || $('download-dialog').open || $('text-dialog').open || $('pages-dialog').open || $('follow-dialog').open || $('view-dialog').open || $('image-dialog').open) return;
  if (e.code === 'Space') { e.preventDefault(); space = true; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? $('redo') : $('undo')).click(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'p') choose('pen');
  if (e.key.toLowerCase() === 'e') choose('eraser');
  if (e.key.toLowerCase() === 'h') choose('hand');
  if (e.key.toLowerCase() === 't') choose('text');
  if (e.key.toLowerCase() === 'f') $('fit').click();
  if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); navigatePage(e.key === 'ArrowLeft' ? -1 : 1); }
});
window.addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
$('title').value = view().title;
$('title').onchange = () => { const title = $('title').value.trim() || 'Untitled board'; $('title').value = title; enqueue({ type: 'title', title }); };
$('share').onclick = async () => {
  $('join-qr').hidden = true; $('qr-status').textContent = 'Preparing join code…';
  $('link').value = location.href; $('share-dialog').showModal();
  try {
    const response = await fetch('/api/config'); if (!response.ok) throw new Error();
    const config = await response.json();
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const origins = [...new Set([...(local ? config.urls : [location.origin, ...config.urls])])];
    $('join-address').replaceChildren();
    origins.forEach(origin => { const option = document.createElement('option'); option.value = origin; option.textContent = origin; $('join-address').append(option); });
    $('join-address').hidden = $('join-address-label').hidden = origins.length < 2;
    $('join-address').value = origins[0] || location.origin;
    $('link').value = (origins[0] || location.origin) + '/?board=' + boardId;
    if (local && !config.urls.length) $('qr-status').textContent = 'No LAN address found. Connect this computer to Wi-Fi to share by QR code.';
    else showJoinQR();
    $('peers').replaceChildren();
    if (config.peers.length) {
      const label = document.createElement('p'); label.textContent = 'Nearby whiteboard hosts'; $('peers').append(label);
      for (const peer of config.peers) { const a = document.createElement('a'); a.href = peer.url; a.textContent = peer.alias + ' ↗'; a.target = '_blank'; a.rel = 'noopener'; $('peers').append(a); }
    }
  } catch { $('qr-status').textContent = 'Could not prepare a QR code. Check the local server is running.'; toast('Start the local server to share across devices.'); }
};
function showJoinQR() {
  $('join-qr').hidden = true; $('qr-status').textContent = 'Preparing join code…';
  $('join-qr').onload = () => { $('join-qr').hidden = false; $('qr-status').textContent = 'Scan with your phone or tablet camera on the same Wi-Fi.'; };
  $('join-qr').onerror = () => { $('join-qr').hidden = true; $('qr-status').textContent = 'QR code unavailable. Restart the updated server or copy the link below.'; };
  $('join-qr').src = `/api/qr?board=${boardId}&url=${encodeURIComponent($('link').value)}`;
}
$('join-address').onchange = () => { $('link').value = $('join-address').value + '/?board=' + boardId; showJoinQR(); };
$('copy').onclick = async () => {
  try { if (!navigator.clipboard) throw new Error(); await navigator.clipboard.writeText($('link').value); }
  catch { $('link').select(); if (!document.execCommand('copy')) { toast('Select and copy the board link.'); return; } }
  toast('Board link copied');
};
$('export').onclick = () => { finish(); $('download-dialog').showModal(); };
function download(blob, extension) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = (view().title.replace(/[^\w -]/g, '').trim() || 'Whiteboard') + extension;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function boardDocument() {
  const current = view();
  return { format: 'field-whiteboard', version: 2, title: current.title, pages: current.pages.map(page => ({ ...page, strokes: Object.values(current.strokes).filter(s => model.pageOf(s) === page.id) })) };
}
$('download-board').onclick = () => { finish(); download(new Blob([JSON.stringify(boardDocument())], { type: 'application/json' }), '.field.json'); };
$('download-png').onclick = async () => {
  finish(); const strokes = Object.values(pageView().strokes); if (!strokes.length) return toast('Add something to this page first.');
  try { await loadImages(strokes); } catch (error) { return toast(error.message); }
  const b = bounds(strokes), pad = 24, w = b.x2 - b.x1 + pad * 2, h = b.y2 - b.y1 + pad * 2;
  // Cap memory for huge infinite boards and mobile browsers.
  const scale = Math.min(2, 4096 / w, 4096 / h, Math.sqrt(12e6 / (w * h)));
  const output = document.createElement('canvas'); output.width = Math.max(1, Math.ceil(w * scale)); output.height = Math.max(1, Math.ceil(h * scale));
  const context = output.getContext('2d'); context.fillStyle = pageBackground(); context.fillRect(0, 0, output.width, output.height);
  context.setTransform(scale, 0, 0, scale, -(b.x1 - pad) * scale, -(b.y1 - pad) * scale);
  strokes.forEach(s => stroke(context, s));
  output.toBlob(blob => { if (blob) download(blob, '.png'); else toast('Could not create the image. Try SVG instead.'); }, 'image/png');
};
$('download-svg').onclick = () => {
  finish(); const strokes = Object.values(pageView().strokes); if (!strokes.length) return toast('Add something to this page first.');
  const b = bounds(strokes), pad = 24;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x1-pad} ${b.y1-pad} ${b.x2-b.x1+pad*2} ${b.y2-b.y1+pad*2}"><rect x="${b.x1-pad}" y="${b.y1-pad}" width="${b.x2-b.x1+pad*2}" height="${b.y2-b.y1+pad*2}" fill="${pageBackground()}"/>`;
  for (const s of strokes) {
    if (s.kind === 'image') { svg += `<image href="${s.data}" x="${s.x}" y="${s.y}" width="${s.imageWidth}" height="${s.imageHeight}"/>`; continue; }
    if (s.kind === 'shape') {
      const fill = s.fill === 'transparent' ? 'none' : s.fill;
      if (s.shape === 'ellipse') svg += `<ellipse cx="${s.x+s.imageWidth/2}" cy="${s.y+s.imageHeight/2}" rx="${s.imageWidth/2}" ry="${s.imageHeight/2}" fill="${fill}" stroke="${s.color}"/>`;
      else if (s.shape === 'line') svg += `<path d="M${s.x} ${s.y}L${s.x+s.imageWidth} ${s.y+s.imageHeight}" stroke="${s.color}"/>`;
      else svg += `<rect x="${s.x}" y="${s.y}" width="${s.imageWidth}" height="${s.imageHeight}" fill="${fill}" stroke="${s.color}"/>`;
      continue;
    }
    if (s.kind === 'text') {
      const layout = textLayout(s);
      if (s.background !== 'transparent') svg += `<rect x="${s.x}" y="${s.y}" width="${s.boxWidth}" height="${layout.height}" fill="${s.background}"/>`;
      layout.runLines.forEach((runs, i) => { svg += `<text xml:space="preserve" x="${s.x + 12}" y="${s.y + 12 + s.fontSize + i * layout.lineHeight}" font-family="Arial,sans-serif" font-size="${s.fontSize}" fill="${s.color}">${runs.map(run => `<tspan font-weight="${run.bold ? 'bold' : 'normal'}" font-style="${run.italic ? 'italic' : 'normal'}">${escapeXML(run.text)}</tspan>`).join('')}</text>`; });
      continue;
    }
    if (s.points.length === 1) { const p = s.points[0]; svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${s.width*(.4+p[2]*.6)/2}" fill="${s.color}"/>`; }
    for (let i = 1; i < s.points.length; i++) { const a = s.points[i-1], p = s.points[i]; svg += `<path d="M${a[0]} ${a[1]}L${p[0]} ${p[1]}" stroke="${s.color}" stroke-width="${s.width*(.4+(a[2]+p[2])*.3)}" stroke-linecap="round"/>`; }
  }
  download(new Blob([svg + '</svg>'], { type: 'image/svg+xml' }), '.svg');
};
function readBoard(text) {
  const data = JSON.parse(text);
  if (!data || data.format !== 'field-whiteboard' || ![1, 2].includes(data.version)) throw new Error('Choose a Field document (.field.json).');
  const title = value => typeof value === 'string' ? value.trim().slice(0, 80) || 'Untitled' : 'Untitled';
  const source = data.version === 1 ? [{ title: data.title, strokes: data.strokes }] : data.pages;
  if (!Array.isArray(source) || !source.length || source.length > 100) throw new Error('A document must contain 1–100 pages.');
  let count = 0;
  const pages = source.map(page => {
    if (!page || !Array.isArray(page.strokes) || (count += page.strokes.length) > 10000) throw new Error('Invalid page data or too many objects (maximum 10,000).');
    const id = uid();
    const strokes = page.strokes.map(s => {
      if (!s || !model.validItem({ ...s, id: 'import', pageId: id })) throw new Error('This file contains invalid drawing data.');
      if (s.kind === 'image' || s.kind === 'shape') return { ...s, id: uid(), pageId: id };
      return s.kind === 'text' ? { id: uid(), pageId: id, kind: 'text', color: s.color, background: s.background, text: s.text, x: s.x, y: s.y, fontSize: s.fontSize, boxWidth: s.boxWidth, formats: (s.formats || []).map(f => ({ ...f })) } : { id: uid(), pageId: id, color: s.color, width: s.width, points: s.points };
    });
    if (page.background !== undefined && !/^#[a-f0-9]{6}$/i.test(page.background)) throw new Error('Invalid page background.');
    return { id, title: title(page.title), background: page.background || '#f8f9f6', strokes };
  });
  return { title: title(data.title), pages, legacy: data.version === 1 };
}
function importBoard(data) {
  finish();
  const current = view(), group = [];
  if (!data.legacy && current.pages.length + data.pages.length > 100) throw new Error('This import would exceed 100 pages.');
  for (const page of data.pages) {
    const id = data.legacy ? currentPageId : page.id;
    if (!data.legacy) group.push({ forward: { type: 'page-add', page: { id, title: page.title, background: page.background } }, backward: { type: 'page-remove', pageId: id } });
    for (const item of page.strokes) { const s = { ...item, pageId: id }; group.push({ forward: { type: 'put', stroke: s }, backward: { type: 'delete', strokeId: s.id } }); }
  }
  if (!Object.keys(current.strokes).length) group.push({ forward: { type: 'title', title: data.title }, backward: { type: 'title', title: current.title } });
  if (!group.length) return;
  // Batch locally, then use the existing ordered sync queue for all peers.
  pending.push(...group.map(item => ({ ...item.forward, id: uid(), importPage: item.forward.page?.id || item.forward.stroke?.pageId || undefined })));
  undoStack.push({ group }); redoStack.length = 0;
  $('title').value = view().title; cache(); status(); redraw(); pump();
  if (!data.legacy) switchPage(data.pages[0].id);
  $('fit').onclick();
}
$('open-board').onclick = () => $('board-file').click();
$('board-file').onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a board file smaller than 25 MB.');
    const data = readBoard(await file.text()); importBoard(data);
    $('download-dialog').close(); toast('Document imported. Undo to remove the import.');
  } catch (error) { toast(error instanceof SyntaxError ? 'This is not a valid board file.' : error.message); }
  finally { e.target.value = ''; }
};
function escapeXML(value) { return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]); }

function textStyles(item) {
  const styles = Array.from({ length: item.text.length }, () => ({ bold: false, italic: false }));
  for (const f of item.formats || []) for (let i = f.start; i < Math.min(f.end, styles.length); i++) {
    styles[i].bold ||= !!f.bold; styles[i].italic ||= !!f.italic;
  }
  return styles;
}
function styleRanges(styles) {
  const ranges = [];
  styles.forEach((style, index) => {
    if (!style.bold && !style.italic) return;
    const last = ranges.at(-1);
    if (last && last.end === index && last.bold === style.bold && last.italic === style.italic) last.end++;
    else ranges.push({ start: index, end: index + 1, bold: style.bold, italic: style.italic });
  });
  return ranges;
}
function textFont(size, style) { return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}px Arial, sans-serif`; }
function textRuns(chars) {
  const runs = [];
  for (const char of chars) {
    const last = runs.at(-1);
    if (last && last.bold === char.bold && last.italic === char.italic) last.text += char.text;
    else runs.push({ ...char });
  }
  return runs;
}
function textLayout(item) {
  const styles = textStyles(item), max = item.boxWidth - 24, runLines = [];
  const measure = chars => textRuns(chars).reduce((sum, run) => { ctx.font = textFont(item.fontSize, run); return sum + ctx.measureText(run.text).width; }, 0);
  let line = [], spaces = [];
  const flush = () => { runLines.push(textRuns(line)); line = []; spaces = []; };
  for (const match of item.text.matchAll(/\n|[^\S\n]+|\S+/g)) {
    const token = match[0];
    if (token === '\n') { flush(); continue; }
    let offset = match.index;
    const chars = Array.from(token, char => { const value = { text: char, ...styles[offset] }; offset += char.length; return value; });
    if (/^\s+$/.test(token)) { if (line.length) spaces.push(...chars); continue; }
    if (line.length && measure([...line, ...spaces, ...chars]) > max) flush();
    if (measure(chars) <= max) { line.push(...spaces, ...chars); spaces = []; continue; }
    // A word wider than the entire box is the only case that splits letters.
    for (const char of chars) {
      if (line.length && measure([...line, char]) > max) flush();
      line.push(char);
    }
  }
  flush();
  const lineHeight = item.fontSize * 1.3;
  return { lines: runLines.map(runs => runs.map(run => run.text).join('')), runLines, lineHeight, height: runLines.length * lineHeight + 24 };
}
function drawText(context, item, alpha = 1) {
  const layout = textLayout(item);
  context.save(); context.globalAlpha = alpha;
  if (item.background !== 'transparent') { context.fillStyle = item.background; context.fillRect(item.x, item.y, item.boxWidth, layout.height); }
  context.textBaseline = 'alphabetic'; context.fillStyle = item.color;
  layout.runLines.forEach((runs, i) => {
    let x = item.x + 12;
    for (const run of runs) { context.font = textFont(item.fontSize, run); context.fillText(run.text, x, item.y + 12 + item.fontSize + i * layout.lineHeight); x += context.measureText(run.text).width; }
  });
  context.restore();
}
function syncTextEditor() {
  if (!editingText) return;
  const before = editingText.text, after = $('text-content').value;
  if (before !== after) {
    let start = 0, tail = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    const styles = textStyles(editingText), inherited = styles[start] || styles[start - 1] || { bold: false, italic: false };
    const inserted = Array.from({ length: after.length - start - tail }, () => ({ ...inherited }));
    editingText.formats = styleRanges([...styles.slice(0, start), ...inserted, ...styles.slice(before.length - tail)]);
    editingText.text = after;
  }
}
function previewText() {
  if (!editingText) return;
  $('text-preview').replaceChildren();
  const styles = textStyles(editingText);
  let index = 0;
  const chars = Array.from(editingText.text, text => { const char = { text, ...styles[index] }; index += text.length; return char; });
  for (const run of textRuns(chars)) {
    const span = document.createElement('span'); span.textContent = run.text;
    span.style.fontWeight = run.bold ? '700' : '400'; span.style.fontStyle = run.italic ? 'italic' : 'normal';
    $('text-preview').append(span);
  }
}
function toggleTextStyle(style) {
  syncTextEditor(); if (!editingText) return;
  const input = $('text-content'), start = input.selectionStart, end = input.selectionEnd;
  if (start === end) return toast('Select the words you want to format first.');
  const styles = textStyles(editingText), enabled = !styles.slice(start, end).every(s => s[style]);
  for (let i = start; i < end; i++) styles[i][style] = enabled;
  editingText.formats = styleRanges(styles); previewText(); input.focus(); input.setSelectionRange(start, end);
}
$('text-bold').onclick = () => toggleTextStyle('bold');
$('text-italic').onclick = () => toggleTextStyle('italic');
// Keep the textarea selection when pressing the formatting buttons.
for (const id of ['text-bold', 'text-italic']) $(id).onmousedown = event => event.preventDefault();
$('text-content').oninput = () => { syncTextEditor(); previewText(); };
$('text-content').onkeydown = event => {
  if ((event.ctrlKey || event.metaKey) && ['b', 'i'].includes(event.key.toLowerCase())) { event.preventDefault(); toggleTextStyle(event.key.toLowerCase() === 'b' ? 'bold' : 'italic'); }
};
function textHit(item, point) { if (item.kind === 'image' || item.kind === 'shape') return point[0] >= item.x && point[0] <= item.x+item.imageWidth && point[1] >= item.y && point[1] <= item.y+item.imageHeight; return point[0] >= item.x && point[0] <= item.x + item.boxWidth && point[1] >= item.y && point[1] <= item.y + textLayout(item).height; }
function openText(item) {
  editingText = { ...item, formats: (item.formats || []).map(f => ({ ...f })) }; $('text-content').value = item.text; $('text-color').value = item.color;
  $('text-background').value = item.background === 'transparent' ? '#edf3df' : item.background;
  $('text-transparent').checked = item.background === 'transparent'; $('text-size').value = item.fontSize; $('text-width').value = item.boxWidth;
  $('text-delete').hidden = !view().strokes[item.id]; previewText(); $('text-dialog').showModal(); $('text-content').focus();
}
$('text-save').onclick = () => {
  if (!editingText) return;
  syncTextEditor();
  const item = { ...editingText, text: $('text-content').value, color: $('text-color').value, background: $('text-transparent').checked ? 'transparent' : $('text-background').value, fontSize: Number($('text-size').value), boxWidth: Number($('text-width').value) };
  if (!item.text.trim()) return toast('Enter some text, or delete the box.');
  if (!model.validItem(item)) return toast('Use a font size of 12–144 and a box width of 80–2000.');
  const before = view().strokes[item.id];
  record({ type: 'put', stroke: item }, before ? { type: 'put', stroke: before } : { type: 'delete', strokeId: item.id });
  $('text-dialog').close(); editingText = null;
};
$('text-delete').onclick = () => { const before = view().strokes[editingText?.id]; if (before) record({ type: 'delete', strokeId: before.id }, { type: 'put', stroke: before }); $('text-dialog').close(); editingText = null; };

function fitArrivingPage() {
  const items = [...Object.values(pageView().strokes), ...pageDrafts().map(d => d.stroke)];
  camera = items.length ? fitCamera(items) : { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
  followGoal = null;
}
function switchPage(id, following = false) {
  if (!view().pages.some(p => p.id === id)) return;
  if (!following) stopFollowing();
  finish(); pan = null; space = false; pageCameras.set(currentPageId, { ...camera }); currentPageId = id;
  fitArrivingPage();
  try { localStorage.setItem(storageKey + '-page', id); } catch {}
  imageAssets.clear();
  inkKey = ''; updatePages(); redraw(); queueActivity(null);
}
function navigatePage(delta) { const pages = view().pages, i = pages.findIndex(p => p.id === currentPageId); if (pages[i + delta]) switchPage(pages[i + delta].id); }
let pageMenuKey = '';
function updatePages() {
  const pages = view().pages;
  if (!pages.some(p => p.id === currentPageId)) { currentPageId = pages[0].id; inkKey = ''; fitArrivingPage(); }
  const i = pages.findIndex(p => p.id === currentPageId);
  $('page-number').textContent = `${i + 1} / ${pages.length}`;
  $('page-number').title = pages[i].title;
  if (document.activeElement !== $('page-background')) $('page-background').value = pages[i].background || '#f8f9f6';
  $('previous-page').disabled = i === 0; $('next-page').disabled = i === pages.length - 1;
  $('add-page').disabled = $('menu-add-page').disabled = pages.length >= 100;
  if (!$('pages-dialog').open) return;
  const key = JSON.stringify(pages) + currentPageId;
  if (key === pageMenuKey) return; pageMenuKey = key;
  $('page-list').replaceChildren();
  pages.forEach((page, index) => {
    const row = document.createElement('div'); row.className = 'page-row' + (page.id === currentPageId ? ' current' : '');
    const jump = document.createElement('button'); jump.textContent = String(index + 1); jump.setAttribute('aria-label', `Go to ${page.title}`);
    jump.onclick = () => { switchPage(page.id); $('pages-dialog').close(); };
    const name = document.createElement('input'); name.value = page.title; name.maxLength = 80; name.setAttribute('aria-label', `Page ${index + 1} name`);
    name.onchange = () => { const title = name.value.trim() || `Page ${index + 1}`; enqueue({ type: 'page-title', pageId: page.id, title }); };
    const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.className = 'remove-page';
    remove.setAttribute('aria-label', `Remove ${page.title}`); remove.disabled = pages.length === 1;
    remove.title = pages.length === 1 ? 'Keep at least one page in the document' : 'Remove page (can be undone)';
    remove.onclick = () => removePage(page.id);
    row.append(jump, name, remove); $('page-list').append(row);
  });
}
function removePage(id) {
  finish();
  const current = view(), index = current.pages.findIndex(page => page.id === id);
  if (index < 0 || current.pages.length === 1) return;
  const page = current.pages[index], items = Object.values(current.strokes).filter(item => model.pageOf(item) === id);
  const forwardOps = [{ type: 'page-remove', pageId: id }];
  const backwardOps = [{ type: 'page-add', page: { ...page }, index }, ...items.map(item => ({ type: 'put', stroke: item }))];
  if (currentPageId === id) switchPage(current.pages[index + 1]?.id || current.pages[index - 1].id);
  for (const [key, draft] of remote) if (model.pageOf(draft.stroke) === id) remote.delete(key);
  enqueue(forwardOps[0]); undoStack.push({ forwardOps, backwardOps }); redoStack.length = 0; status();
  toast('Page removed for everyone. Use Undo to restore it.');
}
function addPage() {
  const pages = view().pages; if (pages.length >= 100) return toast('A document can have up to 100 pages.');
  finish(); const page = { id: uid(), title: `Page ${pages.length + 1}` };
  enqueue({ type: 'page-add', page }); switchPage(page.id); $('pages-dialog').close();
}
$('pages-menu').onclick = () => { $('pages-dialog').showModal(); pageMenuKey = ''; updatePages(); };
$('add-page').onclick = $('menu-add-page').onclick = addPage;
$('previous-page').onclick = () => navigatePage(-1); $('next-page').onclick = () => navigatePage(1);

async function exportDocument(format) {
  finish(); const data = boardDocument(), pages = [];
  const buttons = [$('download-pdf'), $('download-pptx')]; buttons.forEach(b => b.disabled = true);
  try {
    for (const [i, page] of data.pages.entries()) {
      toast(`Preparing page ${i + 1} of ${data.pages.length}…`);
      const output = document.createElement('canvas'); output.width = 1920; output.height = 1080;
      const context = output.getContext('2d'); context.fillStyle = page.background || '#f8f9f6'; context.fillRect(0, 0, 1920, 1080);
      await loadImages(page.strokes);
      if (page.strokes.length) {
        const b = bounds(page.strokes), z = Math.min(1800 / Math.max(1, b.x2 - b.x1), 960 / Math.max(1, b.y2 - b.y1));
        context.setTransform(z, 0, 0, z, 960 - (b.x1 + b.x2) / 2 * z, 540 - (b.y1 + b.y2) / 2 * z);
        page.strokes.forEach(s => stroke(context, s));
      }
      pages.push({ title: page.title, image: output.toDataURL('image/png') });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const response = await fetch(`/api/export?board=${boardId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, title: data.title, pages }), signal: AbortSignal.timeout(120000) });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Export failed'); }
    download(await response.blob(), '.' + format); toast('Your document is ready.');
  } catch (error) { toast(`Could not export: ${error.message}. Check that the updated server is running.`); }
  finally { buttons.forEach(b => b.disabled = false); }
}
$('download-pdf').onclick = () => exportDocument('pdf'); $('download-pptx').onclick = () => exportDocument('pptx');
function noteWriter(id, item) {
  if (!id || id === clientId || !item || activityWriters.has(id)) return;
  const point = item.kind === 'image' || item.kind === 'shape' ? [item.x+item.imageWidth/2,item.y+item.imageHeight/2] : item.kind === 'text' ? [item.x + item.boxWidth / 2, item.y + textLayout(item).height / 2] : item.points.at(-1);
  if (!point) return;
  const target = { x: point[0], y: point[1], pageId: model.pageOf(item) };
  writerPositions.set(id, target);
  if (id === followedId) { followTarget = target; redraw(); }
}
function stopFollowing() {
  const wasFollowing = followedId;
  followedId = null; followTarget = null; followGoal = null;
  if (wasFollowing) post('follow', { targetId: null }).catch(() => {});
  $('auto-follow').setAttribute('aria-pressed', 'false'); $('auto-follow').textContent = 'Follow';
  updateFollowControls();
}
function startFollowing(id) {
  if (!connectedUsers.some(user => user.id === id && id !== clientId)) return toast('Choose someone who is currently connected.');
  if (followMode !== 'slide' || followZoom) setAutoFit(false);
  followedId = id; followTarget = writerPositions.get(id) || null; followGoal = null;
  post('follow', { targetId: id, followZoom }).catch(() => {});
  $('auto-follow').setAttribute('aria-pressed', 'true'); $('auto-follow').textContent = 'Following';
  updateFollowControls(); redraw();
}
function followDestination(viewport, point, screenWidth = innerWidth, screenHeight = innerHeight) {
  const margins = viewInsets(screenWidth), left = margins.left, right = screenWidth - margins.right, top = margins.top, bottom = screenHeight - margins.bottom;
  const w = Math.max(1, right - left), h = Math.max(1, bottom - top);
  const x = point.x * viewport.z + viewport.x, y = point.y * viewport.z + viewport.y;
  const next = { ...viewport };
  // A central safe area avoids chasing every letter. Pan only when writing
  // approaches an edge, leaving room ahead without changing the zoom level.
  if (x < left + w * .18 || x > left + w * .82) next.x = left + w * .5 - point.x * viewport.z;
  if (y < top + h * .18 || y > top + h * .82) next.y = top + h * .5 - point.y * viewport.z;
  return next;
}
function followFraming(viewport, point) {
  const items = [...Object.values(pageView().strokes), ...pageDrafts().map(d => d.stroke)];
  if (!items.length) return followDestination(viewport, point);
  const b = bounds(items);
  b.x1 = Math.min(b.x1, point.x); b.x2 = Math.max(b.x2, point.x);
  b.y1 = Math.min(b.y1, point.y); b.y2 = Math.max(b.y2, point.y);
  const margins = viewInsets(innerWidth), pad = 12;
  const left = margins.left + pad, top = margins.top + pad;
  const w = Math.max(1, innerWidth - margins.left - margins.right - pad * 2);
  const h = Math.max(1, innerHeight - margins.top - margins.bottom - pad * 2);
  const fit = Math.min(w / Math.max(1, b.x2 - b.x1), h / Math.max(1, b.y2 - b.y1));
  // Favor including more content, but stop before writing becomes unreadable.
  const sizes = items.filter(item => item.kind === 'text').map(item => item.fontSize).sort((a,b) => a-b);
  const floor = sizes.length ? Math.max(.625, Math.min(1, 10 / sizes[Math.floor(sizes.length / 2)])) : .625;
  const z = Math.min(8, Math.max(floor, fit));
  if (fit >= floor) {
    // Use the largest scale that includes all content, even after a smaller page
    // replaces a wide one or content is erased. Never retain a stale zoom-out.
    return { z, x: left + w / 2 - (b.x1 + b.x2) / 2 * z, y: top + h / 2 - (b.y1 + b.y2) / 2 * z };
  }
  // At the readability limit, allow clipping and keep the writer in view.
  const cx = left + w / 2, cy = top + h / 2;
  return followDestination({ z, x: cx - (cx - viewport.x) / viewport.z * z, y: cy - (cy - viewport.y) / viewport.z * z }, point);
}
function updateAutoFollow() {
  if (focusAnimation || !followedId || !followTarget || active || pan || !online || !connectedUsers.some(user => user.id === followedId)) return;
  if (!view().pages.some(page => page.id === followTarget.pageId)) return;
  if (currentPageId !== followTarget.pageId) {
    if (followMode === 'pointer') return;
    switchPage(followTarget.pageId, true);
    // Show the arrival framing first; subsequent updates resume the chosen follow mode.
    return;
  }
  if (followZoom) {
    // Match the remote scale exactly; neither local fit nor readability rules apply.
    const z = followTarget.zoom;
    if (Number.isFinite(z) && z > 0 && z <= 8) {
      const cx = innerWidth / 2, cy = innerHeight / 2;
      camera = { z, x: cx - (cx - camera.x) / camera.z * z, y: cy - (cy - camera.y) / camera.z * z };
    }
    if (followMode !== 'slide' && Number.isFinite(followTarget.x) && Number.isFinite(followTarget.y)) {
      const destination = followDestination(camera, followTarget);
      const dx = destination.x - camera.x, dy = destination.y - camera.y;
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) { camera.x += dx * .2; camera.y += dy * .2; redraw(); }
    }
    return;
  }
  if (followMode === 'slide' || followTarget.x === null || followTarget.y === null) return;
  const desired = followFraming(camera, followTarget);
  if (!followGoal || desired.x !== camera.x || desired.y !== camera.y || desired.z !== camera.z) followGoal = desired;
  const dx = followGoal.x - camera.x, dy = followGoal.y - camera.y, dz = followGoal.z - camera.z;
  if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(dz) < .0005) { camera = { ...followGoal }; return; }
  const easing = dz > 0 ? .08 : .2;
  camera.x += dx * easing; camera.y += dy * easing; camera.z += dz * easing;
  redraw();
}
function updateFollowControls() {
  const select = $('follow-person'), previous = select.value || followedId;
  select.replaceChildren();
  const others = connectedUsers.filter(user => user.id !== clientId);
  for (const user of others) {
    const option = document.createElement('option'); option.value = user.id; option.textContent = `${user.name} · ${user.id.slice(0, 4)}`; select.append(option);
  }
  if (!others.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'No other people connected'; select.append(option); }
  if (others.some(user => user.id === previous)) select.value = previous;
  else if (others.length) select.value = others[0].id;
  $('start-follow').disabled = !others.length; $('stop-follow').disabled = !followedId;
  const writer = connectedUsers.find(user => user.id === followedId);
  $('follow-status').textContent = followedId ? writer ? `Following ${writer.name}. Waiting for their next writing if they haven’t started.` : 'The selected person disconnected. Choose another person, or wait for them to reconnect.' : others.length ? 'Choose whose writing to follow on this device.' : 'Share the QR code so someone else can join.';
}
function updateFocusControl() {
  const button = $('focus'), available = followers.size > 0;
  const reZoom = $('re-zoom'), canReZoom = available && [...followers.values()].every(value => !value);
  if (!available) focusMode = false;
  button.hidden = !available;
  reZoom.hidden = !canReZoom;
  button.setAttribute('aria-pressed', String(focusMode));
  button.textContent = focusMode ? 'Tap canvas' : 'Focus';
  canvas.style.cursor = focusMode ? 'cell' : tool === 'hand' ? 'grab' : 'crosshair';
}
function stepFocusAnimation(now = Date.now()) {
  if (!focusAnimation) return false;
  const animation = focusAnimation, t = Math.min(1, (now - animation.started) / animation.duration), ease = 1 - (1 - t) ** 3;
  camera = { x: animation.from.x + (animation.to.x - animation.from.x) * ease, y: animation.from.y + (animation.to.y - animation.from.y) * ease, z: animation.from.z + (animation.to.z - animation.from.z) * ease };
  if (t < 1) redraw(); else focusAnimation = null;
  return true;
}
function receiveFocus(focus) {
  if (focus.clientId === clientId || focus.clientId !== followedId || !view().pages.some(page => page.id === focus.pageId)) return;
  if (currentPageId !== focus.pageId) switchPage(focus.pageId, true);
  const { left, right, top, bottom } = viewInsets(innerWidth), centerX = left + (innerWidth - left - right) / 2, centerY = top + (innerHeight - top - bottom) / 2;
  focusAnimation = { from: { ...camera }, to: { z: focus.zoom, x: centerX - focus.x * focus.zoom, y: centerY - focus.y * focus.zoom }, started: Date.now(), duration: 450 };
  followGoal = null; redraw();
}
function receiveReZoom(rezoom) {
  if (rezoom.clientId === clientId || rezoom.clientId !== followedId) return;
  const centerX = innerWidth / 2, centerY = innerHeight / 2;
  focusAnimation = { from: { ...camera }, to: { z: rezoom.zoom, x: centerX - (centerX - camera.x) / camera.z * rezoom.zoom, y: centerY - (centerY - camera.y) / camera.z * rezoom.zoom }, started: Date.now(), duration: 450 };
  followGoal = null; redraw();
}
$('focus').onclick = () => {
  if (!followers.size) return;
  focusMode = !focusMode; updateFocusControl();
  if (focusMode) toast('Tap a point to focus everyone following you.');
};
$('re-zoom').onclick = () => {
  if (!followers.size || [...followers.values()].some(value => value)) return;
  post('rezoom', { zoom: camera.z }).then(() => toast('Matched your followers to this zoom.')).catch(error => toast(error.message));
};
$('your-name').value = displayName;
$('your-name').onchange = async () => {
  displayName = $('your-name').value.trim().slice(0, 40) || 'Guest'; $('your-name').value = displayName;
  try { localStorage.setItem('field-name', displayName); } catch {}
  try { await post('profile', { name: displayName }); } catch { toast('Name saved on this device; reconnect to share it.'); }
};
$('auto-follow').onclick = () => { updateFollowControls(); $('follow-dialog').showModal(); };
$('start-follow').onclick = () => { startFollowing($('follow-person').value); if (followedId) $('follow-dialog').close(); };
$('stop-follow').onclick = () => { stopFollowing(); $('follow-dialog').close(); };
function pageBackground() { return view().pages.find(page => page.id === currentPageId)?.background || '#f8f9f6'; }
function viewInsets(screenWidth) {
  const hidden = name => compactMode && !compactExpanded && compactMenus[name];
  return { left: hidden('palette') ? 24 : screenWidth <= 640 ? 80 : 110, right: 30,
    top: !hidden('pages') ? screenWidth <= 640 ? 172 : 152 : !hidden('header') ? screenWidth <= 640 ? 118 : 100 : 24,
    bottom: hidden('bottom') ? 60 : 120 };
}
function imageAsset(data) {
  if (imageAssets.has(data)) return imageAssets.get(data);
  const image = new Image();
  const promise = new Promise((resolve, reject) => { image.onload = () => { inkKey = ''; redraw(); resolve(image); }; image.onerror = () => reject(new Error('This image could not be decoded.')); });
  promise.catch(() => {}); image.src = data;
  const asset = { image, promise }; imageAssets.set(data, asset); return asset;
}
async function loadImages(items) { await Promise.all(items.filter(item => item.kind === 'image').map(item => imageAsset(item.data).promise)); }
function readDataURL(file) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(new Error('Could not read the file.')); reader.readAsDataURL(file); }); }
async function compactImage(data) {
  const image = await imageAsset(data).promise;
  if (image.naturalWidth * image.naturalHeight > 80000000) throw new Error('Choose an image smaller than 80 megapixels.');
  let scale = Math.min(1,1800/image.naturalWidth,1800/image.naturalHeight), encoded;
  const canvas = document.createElement('canvas');
  for (let i=0;i<8;i++) {
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale)); canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    encoded=canvas.toDataURL(data.startsWith('data:image/jpeg')?'image/jpeg':'image/png',.88);
    if (encoded.length<=1800000) { imageAssets.delete(data); return { data:encoded,width:canvas.width,height:canvas.height }; }
    scale*=.75;
  }
  throw new Error('This image is too large to sync. Try a smaller image.');
}
$('insert-image').onclick=()=>$('image-file').click();
$('image-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  const pageId=currentPageId, x=(innerWidth/2-camera.x)/camera.z, y=(innerHeight/2-camera.y)/camera.z;
  try {
    if(file.size>20*1024*1024)throw new Error('Choose an image smaller than 20 MB.');
    const image=await compactImage(await readDataURL(file));
    if(!view().pages.some(p=>p.id===pageId))throw new Error('That page was removed. Choose another page.');
    const scale=Math.min(1,640/image.width,480/image.height), imageWidth=image.width*scale,imageHeight=image.height*scale;
    const item={id:uid(),pageId,kind:'image',color:'#263b36',data:image.data,x:x-imageWidth/2,y:y-imageHeight/2,imageWidth,imageHeight};
    record({type:'put',stroke:item},{type:'delete',strokeId:item.id});choose('select');toast('Image added. Drag to move; click to resize.');
  }catch(error){toast(error.message);}finally{event.target.value='';}
};
function openImage(item){editingImage={...item};$('image-preview').hidden=item.kind!=='image';if(item.data)$('image-preview').src=item.data;$('image-width').value=Math.round(item.imageWidth);$('image-dialog').showModal();}
$('image-save').onclick=()=>{
  if(!editingImage)return;const before=view().strokes[editingImage.id];if(!before)return $('image-dialog').close();
  const imageWidth=Number($('image-width').value),imageHeight=editingImage.imageHeight*imageWidth/editingImage.imageWidth;
  const item={...editingImage,imageWidth,imageHeight};if(!model.validItem(item))return toast('Use dimensions between 1 and 20,000.');
  record({type:'put',stroke:item},{type:'put',stroke:before});$('image-dialog').close();editingImage=null;
};
$('image-delete').onclick=()=>{const before=view().strokes[editingImage?.id];if(before)record({type:'delete',strokeId:before.id},{type:'put',stroke:before});$('image-dialog').close();editingImage=null;};
$('page-background').onchange=()=>{const page=view().pages.find(p=>p.id===currentPageId);record({type:'page-background',pageId:page.id,color:$('page-background').value},{type:'page-background',pageId:page.id,color:page.background||'#f8f9f6'});};
$('import-pptx').onclick=()=>$('pptx-file').click();
$('pptx-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;$('import-pptx').disabled=true;$('import-report').textContent='Reading PowerPoint…';
  try{
    if(file.size>25*1024*1024)throw new Error('Choose a PowerPoint smaller than 25 MB.');
    const dataURL=await readDataURL(file);
    const response=await fetch(`/api/import-pptx?board=${boardId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,data:dataURL.split(',')[1]}),signal:AbortSignal.timeout(120000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not import PowerPoint.');
    const compressed=new Map();
    for(const page of result.pages)for(const item of page.strokes)if(item.kind==='image'){
      if(!compressed.has(item.data))compressed.set(item.data,await compactImage(item.data));
      item.data=compressed.get(item.data).data;
    }
    const imported=readBoard(JSON.stringify(result));importBoard(imported);
    $('import-report').textContent=`Imported ${result.pages.length} slides. Text uses Field’s fonts and wrapping; advanced PowerPoint styles may differ. `+(result.warnings.length?result.warnings.join('; '):'Text, pictures, and basic shapes imported.');
    toast(`Imported ${result.pages.length} slides. Use Undo to remove the import.`);
  }catch(error){$('import-report').textContent=error.message;toast(error.message);}finally{$('import-pptx').disabled=false;event.target.value='';}
};
function queueActivity(event){
  if(event?.pointerType==='touch'&&tool!=='hand'&&tool!=='select')return;
  const point=event?world(event):null;
  localActivity={pageId:currentPageId,x:point?point[0]:null,y:point?point[1]:null};activityDirty=true;
  if (!event) flushActivity();
}
async function flushActivity(){
  if (camera.z !== lastSentZoom) activityDirty = true;
  if(!online||!activityDirty||activitySending)return;
  const activity={...(localActivity?.pageId === currentPageId ? localActivity : {pageId:currentPageId,x:null,y:null}),zoom:camera.z};activityDirty=false;activitySending=true;
  try{await post('activity',activity);lastSentZoom=activity.zoom;}catch{activityDirty=true;}finally{activitySending=false;}
}
canvas.addEventListener('pointermove',queueActivity);
canvas.addEventListener('pointerdown',queueActivity);
setInterval(flushActivity,100);
function receiveActivity(activity){
  if(activity.clientId===clientId)return;
  activityWriters.add(activity.clientId);
  const previous=writerPositions.get(activity.clientId);
  const target=activity.x===null&&previous?.pageId===activity.pageId?{...previous,pageId:activity.pageId}:{x:activity.x,y:activity.y,pageId:activity.pageId};
  target.zoom = activity.zoom ?? previous?.zoom;
  writerPositions.set(activity.clientId,target);
  if(activity.clientId===followedId){followTarget=target;followGoal=null;redraw();}
}
events.addEventListener('activity',event=>receiveActivity(JSON.parse(event.data)));
events.addEventListener('following', event => {
  const relation = JSON.parse(event.data);
  if (relation.targetId === clientId) followers.set(relation.clientId, relation.followZoom === true); else followers.delete(relation.clientId);
  updateFocusControl();
});
events.addEventListener('focus', event => receiveFocus(JSON.parse(event.data)));
events.addEventListener('rezoom', event => receiveReZoom(JSON.parse(event.data)));
$('follow-zoom').checked=followZoom;
$('follow-zoom').onchange=()=>{
  followZoom=$('follow-zoom').checked;followGoal=null;
  if(followZoom&&followedId)setAutoFit(false);
  if(followedId)post('follow',{targetId:followedId,followZoom}).catch(()=>{});
  try{localStorage.setItem('field-follow-zoom',String(followZoom));}catch{}
  redraw();
};
$('follow-mode').value=followMode;
$('follow-mode').onchange=()=>{followMode=$('follow-mode').value;followGoal=null;if(followedId&&(followMode!=='slide'||followZoom))setAutoFit(false);try{localStorage.setItem('field-follow-mode',followMode);}catch{}redraw();};
$('view-settings').onclick=()=>{$('view-dialog').showModal();};
for(const name of ['header','pages','palette','bottom','hints']){
  $('compact-'+name).checked=!!compactMenus[name];
  $('compact-'+name).onchange=()=>{compactMenus[name]=$('compact-'+name).checked;try{localStorage.setItem('field-compact-menus',JSON.stringify(compactMenus));}catch{}updateCompactMode();};
}
function updateCompactMode() {
  document.body.classList.toggle('compact-mode', compactMode);
  document.body.classList.toggle('controls-collapsed', compactMode && !compactExpanded);
  for (const name of ['header','pages','palette','bottom','hints']) document.body.classList.toggle('hide-'+name, compactMode && !compactExpanded && !!compactMenus[name]);
  $('compact-mode').setAttribute('aria-pressed', String(compactMode));
  $('compact-mode').title = compactMode ? 'Turn off compact mode' : 'Turn on compact mode';
  $('reveal-controls').hidden = !compactMode;
  $('reveal-controls').textContent = compactExpanded ? '<' : '>';
  $('reveal-controls').setAttribute('aria-expanded', String(compactExpanded));
  $('reveal-controls').setAttribute('aria-label', compactExpanded ? 'Hide controls' : 'Show controls');
  followGoal = null; redraw();
}
$('compact-mode').onclick = () => {
  compactMode = !compactMode; compactExpanded = false;
  try { localStorage.setItem('field-compact-mode', String(compactMode)); } catch {}
  updateCompactMode();
};
$('reveal-controls').onclick = () => { compactExpanded = !compactExpanded; updateCompactMode(); };
updateCompactMode(); status(); redraw();

restoreCache();
