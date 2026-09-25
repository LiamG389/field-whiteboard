// Shared by the plain browser app and the Node server.
(() => {
  const FIRST_PAGE = 'page-1';
  const safeId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
  const color = value => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
  const coordinate = value => Number.isFinite(value) && Math.abs(value) <= 1e9;
  const pageOf = item => item.pageId || FIRST_PAGE;
  function normalize(state) {
    state.pages ||= [{ id: FIRST_PAGE, title: 'Page 1' }];
    state.strokes ||= {};
    return state;
  }
  function validItem(s) {
    if (!s || !safeId(s.id) || !color(s.color) || (s.pageId !== undefined && !safeId(s.pageId))) return false;
    if (s.kind === 'image') return coordinate(s.x) && coordinate(s.y) && Number.isFinite(s.imageWidth) && s.imageWidth > 0 && s.imageWidth <= 20000 && Number.isFinite(s.imageHeight) && s.imageHeight > 0 && s.imageHeight <= 20000 && typeof s.data === 'string' && s.data.length <= 1800000 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s.data);
    if (s.kind === 'shape') return coordinate(s.x) && coordinate(s.y) && Number.isFinite(s.imageWidth) && s.imageWidth > 0 && s.imageWidth <= 20000 && Number.isFinite(s.imageHeight) && s.imageHeight > 0 && s.imageHeight <= 20000 && ['rect', 'ellipse', 'line'].includes(s.shape) && (s.fill === 'transparent' || color(s.fill));
    if (s.kind === 'text') return typeof s.text === 'string' && s.text.length > 0 && s.text.length <= 10000 &&
      coordinate(s.x) && coordinate(s.y) && Number.isFinite(s.fontSize) && s.fontSize >= 12 && s.fontSize <= 144 &&
      Number.isFinite(s.boxWidth) && s.boxWidth >= 80 && s.boxWidth <= 2000 && (s.background === 'transparent' || color(s.background)) &&
      (s.formats === undefined || (Array.isArray(s.formats) && s.formats.length <= 10000 && s.formats.every(f => f && Number.isInteger(f.start) && Number.isInteger(f.end) && f.start >= 0 && f.end > f.start && f.end <= s.text.length && (f.bold === undefined || typeof f.bold === 'boolean') && (f.italic === undefined || typeof f.italic === 'boolean'))));
    return (s.kind === undefined || s.kind === 'ink') && Number.isFinite(s.width) && s.width >= .1 && s.width <= 100 &&
      Array.isArray(s.points) && s.points.length > 0 && s.points.length <= 20000 &&
      s.points.every(p => Array.isArray(p) && p.length === 3 && coordinate(p[0]) && coordinate(p[1]) && Number.isFinite(p[2]) && p[2] >= 0 && p[2] <= 1);
  }
  function validEdit(state, op) {
    normalize(state);
    if (!op || !safeId(op.id)) return false;
    const hasPage = id => state.pages.some(p => p.id === id);
    const title = value => typeof value === 'string' && !!value.trim() && value.length <= 80;
    if (op.type === 'put') return validItem(op.stroke) && hasPage(pageOf(op.stroke));
    if (op.type === 'delete') return safeId(op.strokeId);
    if (op.type === 'title') return title(op.title);
    if (op.type === 'page-add') return state.pages.length < 100 && op.page && safeId(op.page.id) && !hasPage(op.page.id) && title(op.page.title) && (op.page.background === undefined || color(op.page.background)) && (op.index === undefined || (Number.isInteger(op.index) && op.index >= 0 && op.index <= 100));
    if (op.type === 'page-background') return hasPage(op.pageId) && color(op.color);
    if (op.type === 'page-title') return hasPage(op.pageId) && title(op.title);
    if (op.type === 'page-remove') return hasPage(op.pageId) && state.pages.length > 1;
    return false;
  }
  function apply(state, op) {
    normalize(state);
    if (op.type === 'put') state.strokes[op.stroke.id] = op.stroke;
    if (op.type === 'delete') delete state.strokes[op.strokeId];
    if (op.type === 'title') state.title = op.title;
    if (op.type === 'page-add' && !state.pages.some(p => p.id === op.page.id)) state.pages.splice(op.index === undefined ? state.pages.length : Math.min(op.index, state.pages.length), 0, { ...op.page });
    if (op.type === 'page-title') state.pages = state.pages.map(p => p.id === op.pageId ? { ...p, title: op.title } : p);
    if (op.type === 'page-background') state.pages = state.pages.map(p => p.id === op.pageId ? { ...p, background: op.color } : p);
    if (op.type === 'page-remove' && state.pages.length > 1) {
      state.pages = state.pages.filter(p => p.id !== op.pageId);
      for (const [id, item] of Object.entries(state.strokes)) if (pageOf(item) === op.pageId) delete state.strokes[id];
    }
  }
  globalThis.FieldModel = { FIRST_PAGE, safeId, normalize, pageOf, validItem, validEdit, apply };
})();
