// HTTP edits + SSE fan-out stay on the local network.
import http from 'node:http';
import { createEventWriter } from './sse.js';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import './public/model.js';
import { makeExport } from './exports.js';
import QRCode from 'qrcode';
import { importPptx } from './pptx-import.js';
const model = globalThis.FieldModel;

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const port = Number(process.env.PORT || 53318);
const rooms = new Map(), peers = new Map();
const fingerprint = randomUUID();
const group = '224.0.0.167';
mkdirSync(dataDir, { recursive: true });
const addresses = () => Object.values(os.networkInterfaces()).flat().filter(x => x.family === 'IPv4' && !x.internal).map(x => x.address);
function room(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Invalid board link');
  if (!rooms.has(id)) {
    const file = path.join(dataDir, `${id}.json`);
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { title: 'Untitled board', strokes: {}, revision: 0, receipts: [] };
    rooms.set(id, { state: model.normalize(state), clients: new Set(), drafts: new Map(), activity: new Map(), followers: new Map(), file });
  }
  return rooms.get(id);
}
function persist(r, next) {
  writeFileSync(r.file + '.tmp', JSON.stringify(next));
  renameSync(r.file + '.tmp', r.file);
  r.state = next;
}
const send = (res, event, data) => res.sendEvent(event, data);
function broadcast(r, event, data) {
  for (const res of r.clients) {
    send(res, event, data);
  }
}
function presence(r) {
  const users = [...new Map([...r.clients].map(res => [res.member.id, res.member])).values()];
  broadcast(r, 'presence', { count: users.length, users });
}
export function validStroke(s) {
  return model.validItem(s);
}
async function body(req, limit = 2 * 1024 * 1024) {
  let chunks = [], length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Use this server’s board link' });
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { urls: addresses().map(ip => `http://${ip}:${port}`), peers: [...peers.values()].filter(p => Date.now() - p.seen < 20000).map(({ url, alias }) => ({ url, alias })) });
    }
    if (url.pathname.startsWith('/api/')) {
      const r = room(url.searchParams.get('board'));
      if (req.method === 'POST' && url.pathname === '/api/import-pptx') {
        const input = await body(req, 36 * 1024 * 1024);
        if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(input.data)) throw new Error('Invalid PowerPoint upload');
        return json(res, 200, await importPptx(Buffer.from(input.data, 'base64'), typeof input.name === 'string' ? input.name : 'PowerPoint'));
      }
      if (req.method === 'POST' && url.pathname === '/api/sync-ack') {
        const input = await body(req);
        if (!model.safeId(input.clientId) || typeof input.token !== 'string' || input.token.length > 100) throw new Error('Invalid sync acknowledgement');
        for (const client of r.clients) if (client.member.id === input.clientId) client.sendEvent.ack(input.token);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/activity') {
        const input = await body(req);
        if (!model.safeId(input.clientId) || !r.state.pages.some(p => p.id === input.pageId) || !((input.x === null && input.y === null) || (Number.isFinite(input.x) && Math.abs(input.x) <= 1e9 && Number.isFinite(input.y) && Math.abs(input.y) <= 1e9))) throw new Error('Invalid pointer activity');
        if (input.zoom !== undefined && (!Number.isFinite(input.zoom) || input.zoom <= 0 || input.zoom > 8)) throw new Error('Invalid zoom');
        const activity = { clientId: input.clientId, pageId: input.pageId, x: input.x, y: input.y, ...(input.zoom === undefined ? {} : { zoom: input.zoom }) };
        r.activity.set(input.clientId, activity); broadcast(r, 'activity', activity);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/follow') {
        const input = await body(req);
        if (!model.safeId(input.clientId) || !(input.targetId === null || model.safeId(input.targetId)) || input.targetId === input.clientId || (input.followZoom !== undefined && typeof input.followZoom !== 'boolean')) throw new Error('Invalid follow target');
        if (input.targetId !== null && ![...r.clients].some(client => client.member.id === input.targetId)) throw new Error('Follow target is not connected');
        const relation = { clientId: input.clientId, targetId: input.targetId, followZoom: input.followZoom === true };
        if (input.targetId === null) r.followers.delete(input.clientId); else r.followers.set(input.clientId, relation);
        broadcast(r, 'following', relation);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/focus') {
        const input = await body(req);
        if (!model.safeId(input.clientId) || !r.state.pages.some(page => page.id === input.pageId) || !Number.isFinite(input.x) || !Number.isFinite(input.y) || Math.abs(input.x) > 1e9 || Math.abs(input.y) > 1e9 || !Number.isFinite(input.zoom) || input.zoom <= 0 || input.zoom > 8) throw new Error('Invalid focus point');
        broadcast(r, 'focus', { clientId: input.clientId, pageId: input.pageId, x: input.x, y: input.y, zoom: input.zoom });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/rezoom') {
        const input = await body(req);
        if (!model.safeId(input.clientId) || !Number.isFinite(input.zoom) || input.zoom <= 0 || input.zoom > 8) throw new Error('Invalid zoom');
        const followers = [...r.followers.values()].filter(relation => relation.targetId === input.clientId);
        if (!followers.length || followers.some(relation => relation.followZoom)) throw new Error('Re-Zoom requires followers who are not already following zoom');
        broadcast(r, 'rezoom', { clientId: input.clientId, zoom: input.zoom });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/qr') {
        const join = new URL(url.searchParams.get('url'));
        if (!['http:', 'https:'].includes(join.protocol) || join.username || join.password || join.pathname !== '/' || join.searchParams.get('board') !== url.searchParams.get('board') || join.href.length > 1000) throw new Error('Invalid join link');
        const png = await QRCode.toBuffer(join.href, { type: 'png', width: 320, margin: 4, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return res.end(png);
      }
      if (req.method === 'POST' && url.pathname === '/api/profile') {
        const profile = await body(req);
        if (!model.safeId(profile.clientId) || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 40) throw new Error('Invalid name');
        for (const client of r.clients) if (client.member.id === profile.clientId) client.member.name = profile.name.trim();
        presence(r); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/export') {
        const result = await makeExport(await body(req, 64 * 1024 * 1024));
        res.writeHead(200, { 'Content-Type': result.mime, 'Cache-Control': 'no-store' });
        return res.end(result.buffer);
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const requestedId = url.searchParams.get('clientId');
        res.member = { id: model.safeId(requestedId) ? requestedId : randomUUID(), name: (url.searchParams.get('name') || 'Guest').slice(0, 40) };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        res.sendEvent = createEventWriter(res, () => r.state, () => {
          const users = [...new Map([...r.clients].map(client => [client.member.id, client.member])).values()];
          return [['presence', { count: users.length, users }], ...r.followers.values()].map(value => ['following', value]).concat([...r.activity.values()].map(value => ['activity', value]), [...r.drafts.values()].map(value => ['draft', value]));
        }, url.searchParams.get('sync') === '2', randomUUID());
        r.clients.add(res);
        send(res, 'snapshot', r.state);
        for (const draft of r.drafts.values()) send(res, 'draft', draft);
        for (const relation of r.followers.values()) send(res, 'following', relation);
        for (const activity of r.activity.values()) send(res, 'activity', activity);
        presence(r);
    const timer = setInterval(() => send(res, 'keepalive', null), 15000);
        req.on('close', () => { clearInterval(timer); r.clients.delete(res); if (![...r.clients].some(client => client.member.id === res.member.id)) { r.activity.delete(res.member.id); r.followers.delete(res.member.id); broadcast(r, 'following', { clientId: res.member.id, targetId: null, followZoom: false }); } presence(r); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/edit') {
        const op = await body(req);
        if (op.clientId !== undefined && !model.safeId(op.clientId)) throw new Error('Invalid writer');
        if (!model.safeId(op.id)) throw new Error('Invalid operation');
        if (r.state.receipts.includes(op.id)) return json(res, 200, { revision: r.state.revision });
        const next = { ...r.state, pages: r.state.pages.map(p => ({ ...p })), strokes: { ...r.state.strokes }, receipts: [...r.state.receipts.slice(-19999), op.id], revision: r.state.revision + 1 };
        if (!model.validEdit(next, op)) throw new Error('Invalid edit');
        model.apply(next, op);
        persist(r, next);
        if (op.stroke) r.drafts.delete(op.stroke.id);
        if (op.strokeId) r.drafts.delete(op.strokeId);
        if (op.type === 'page-remove') {
          for (const [id, draft] of r.drafts) if (model.pageOf(draft.stroke) === op.pageId) { r.drafts.delete(id); broadcast(r, 'draft', { id }); }
        }
        broadcast(r, 'edit', { ...op, revision: next.revision });
        return json(res, 200, { revision: next.revision });
      }
      if (req.method === 'POST' && url.pathname === '/api/draft') {
        const draft = await body(req);
        if (draft.clientId !== undefined && !model.safeId(draft.clientId)) throw new Error('Invalid writer');
        if (!model.safeId(draft.id) || (draft.stroke && (draft.stroke.id !== draft.id || (draft.stroke.kind && draft.stroke.kind !== 'ink') || !validStroke(draft.stroke) || !r.state.pages.some(p => p.id === model.pageOf(draft.stroke))))) throw new Error('Invalid draft');
        if (draft.stroke && !r.state.strokes[draft.id]) {
          r.drafts.set(draft.id, { ...draft, time: Date.now() });
          broadcast(r, 'draft', draft);
        } else if (!draft.stroke) { r.drafts.delete(draft.id); broadcast(r, 'draft', draft); }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Unknown endpoint' });
    }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/model.js': ['model.js', 'text/javascript'], '/vocab-pen.js': ['vocab-pen.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/favicon.png': ['favicon.png', 'image/png'], '/cache.js': ['cache.js', 'text/javascript'] };
    const file = files[url.pathname];
    if (req.method !== 'GET' || !file) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(readFileSync(path.join(root, 'public', file[0])));
  } catch (error) {
    if (!res.headersSent) json(res, error.code ? 500 : 400, { error: error.code ? 'Could not save board on host' : error.message });
    else res.end();
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, '0.0.0.0', () => {
    console.log(`Field is running: http://localhost:${port}`);
    for (const ip of addresses()) console.log(`LAN: http://${ip}:${port}`);
    console.log(`Boards saved in ${dataDir}`);
  });
  // LocalSend's multicast discovery approach, with our own app marker and port.
  // This intentionally does not advertise compatibility with LocalSend file transfers.
  if (process.env.DISCOVERY !== '0') {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let timer;
    const announce = (reply = false) => {
      const packet = Buffer.from(JSON.stringify({ app: 'field-whiteboard', alias: os.hostname(), fingerprint, port, announce: !reply }));
      socket.send(packet, 53318, group, () => {});
    };
    socket.on('error', error => { console.warn(`Discovery unavailable (${error.message}); use the LAN link.`); clearInterval(timer); socket.close(); });
    socket.on('message', (buffer, info) => {
      try {
        const p = JSON.parse(buffer.toString());
        if (p.app !== 'field-whiteboard' || p.fingerprint === fingerprint || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || typeof p.alias !== 'string') return;
        peers.set(info.address + ':' + p.port, { alias: p.alias.slice(0, 80), url: `http://${info.address}:${p.port}`, seen: Date.now() });
        if (p.announce) announce(true);
      } catch { /* Ignore unrelated multicast packets. */ }
    });
    socket.bind(53318, () => {
      try { socket.addMembership(group); socket.setMulticastTTL(1); announce(); timer = setInterval(() => announce(), 5000); }
      catch (error) { console.warn(`Discovery unavailable (${error.message}); use the LAN link.`); socket.close(); }
    });
  }
  setInterval(() => {
    for (const r of rooms.values()) for (const [id, draft] of r.drafts) if (Date.now() - draft.time > 15000) { r.drafts.delete(id); broadcast(r, 'draft', { id }); }
    for (const [id, peer] of peers) if (Date.now() - peer.seen > 20000) peers.delete(id);
  }, 5000).unref();
}
