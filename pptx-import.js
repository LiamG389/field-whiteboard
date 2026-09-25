import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, attributeNamePrefix: '', trimValues: false, parseTagValue: false });
const local = name => name.split(':').at(-1);
function nodes(entries = []) {
  return entries.flatMap(entry => Object.entries(entry).filter(([key]) => key !== ':@').map(([key, value]) => key === '#text' ? { name: '#text', text: String(value), attrs: {}, kids: [] } : { name: local(key), attrs: entry[':@'] || {}, kids: nodes(Array.isArray(value) ? value : []) }));
}
const child = (node, name) => node?.kids.find(k => k.name === name);
const children = (node, name) => node?.kids.filter(k => k.name === name) || [];
const find = (node, name) => node?.name === name ? node : node?.kids.map(k => find(k, name)).find(Boolean);
const content = node => node?.name === '#text' ? node.text : node?.kids.map(content).join('') || '';
const attr = (node, key, fallback = '') => node?.attrs[key] ?? fallback;
const num = (node, key, fallback = 0) => Number(attr(node, key, fallback));

export async function importPptx(buffer, filename = 'PowerPoint') {
  if (buffer.length > 25 * 1024 * 1024) throw new Error('PowerPoint files must be smaller than 25 MB.');
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > 5000 || entries.reduce((sum, file) => sum + (file._data?.uncompressedSize || 0), 0) > 100 * 1024 * 1024) throw new Error('PowerPoint expands beyond the 100 MB import limit.');
  const cache = new Map();
  async function xml(file) {
    if (!zip.file(file)) return null;
    if (cache.has(file)) return cache.get(file);
    const source = await zip.file(file).async('string');
    if (source.length > 8000000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Unsupported XML in PowerPoint.');
    const tree = { name: 'root', kids: nodes(parser.parse(source)), attrs: {} }; cache.set(file, tree); return tree;
  }
  async function rels(file) {
    const document = await xml(path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels'));
    const result = new Map();
    for (const rel of children(find(document, 'Relationships'), 'Relationship')) {
      if (attr(rel, 'TargetMode') === 'External') continue;
      const target = attr(rel, 'Target');
      const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(file), target));
      if (resolved.startsWith('../')) continue;
      result.set(attr(rel, 'Id'), { file: resolved, type: attr(rel, 'Type').split('/').at(-1) });
    }
    return result;
  }
  const presentation = await xml('ppt/presentation.xml');
  if (!presentation) throw new Error('This file is not a PowerPoint presentation.');
  const dimensions = find(presentation, 'sldSz'), cx = num(dimensions, 'cx', 12192000), cy = num(dimensions, 'cy', 6858000);
  if (!(cx > 0 && cy > 0)) throw new Error('Invalid slide dimensions.');
  const scale = 1280 / cx, height = cy * scale;
  const slideRels = await rels('ppt/presentation.xml');
  const slides = children(find(presentation, 'sldIdLst'), 'sldId');
  if (!slides.length || slides.length > 100) throw new Error('PowerPoint must contain 1–100 slides.');
  const warnings = new Set(), pages = [];
  let total = 0;
  for (const [index, slideId] of slides.entries()) {
    const file = slideRels.get(attr(slideId, 'r:id'))?.file;
    if (!file) throw new Error('Missing slide relationship.');
    const document = await xml(file), relationships = await rels(file);
    const layoutFile = [...relationships.values()].find(r => r.type === 'slideLayout')?.file;
    const layout = layoutFile ? await xml(layoutFile) : null;
    const layoutRels = layoutFile ? await rels(layoutFile) : new Map();
    const masterFile = [...layoutRels.values()].find(r => r.type === 'slideMaster')?.file;
    const master = masterFile ? await xml(masterFile) : null;
    const masterRels = masterFile ? await rels(masterFile) : new Map();
    const themeFile = [...masterRels.values()].find(r => r.type === 'theme')?.file;
    const theme = themeFile ? await xml(themeFile) : null;
    const scheme = { dk1: '#000000', lt1: '#ffffff', dk2: '#263b36', lt2: '#eeeeee', accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47', tx1: '#000000', bg1: '#ffffff' };
    for (const entry of find(theme, 'clrScheme')?.kids || []) { const rgb = find(entry, 'srgbClr') || find(entry, 'sysClr'); const value = attr(rgb, 'val') === 'windowText' || attr(rgb, 'val') === 'window' ? attr(rgb, 'lastClr') : attr(rgb, 'val'); if (/^[a-f0-9]{6}$/i.test(value)) scheme[entry.name] = '#' + value; }
    const color = (node, fallback = '#263b36') => { const rgb = find(node, 'srgbClr'), sc = find(node, 'schemeClr'); return rgb && /^[a-f0-9]{6}$/i.test(attr(rgb, 'val')) ? '#' + attr(rgb, 'val') : sc ? scheme[attr(sc, 'val')] || fallback : fallback; };
    const bg = find(document, 'bg') || find(layout, 'bg') || find(master, 'bg');
    const page = { id: randomUUID(), title: `Slide ${index + 1}`, background: color(bg, '#ffffff'), strokes: [] };
    const warn = detail => warnings.add(`Slide ${index + 1}: ${detail}`);
    if (find(bg, 'gradFill') || find(bg, 'blipFill')) warn('gradient or image background was simplified');
    const add = item => { if (++total > 10000) throw new Error('PowerPoint has more than 10,000 objects.'); page.strokes.push({ id: randomUUID(), pageId: page.id, ...item }); };
    const placeholder = node => find(node, 'ph');
    const inheritedShape = node => {
      const ph = placeholder(node); if (!ph) return null;
      return [...children(find(layout, 'spTree'), 'sp'), ...children(find(master, 'spTree'), 'sp')].find(s => {
        const other = placeholder(s); return other && (attr(other, 'idx', '0') === attr(ph, 'idx', '0'));
      });
    };
    async function visit(tree, relations, transform = { x: 0, y: 0, sx: scale, sy: scale }, decorations = false) {
      for (const node of tree?.kids || []) {
        if (decorations && placeholder(node)) continue;
        if (node.name === 'grpSp') {
          const xf = find(child(node, 'grpSpPr'), 'xfrm'), off = child(xf, 'off'), ext = child(xf, 'ext'), chOff = child(xf, 'chOff'), chExt = child(xf, 'chExt');
          const sx = transform.sx * num(ext, 'cx', 1) / (num(chExt, 'cx', 1) || 1), sy = transform.sy * num(ext, 'cy', 1) / (num(chExt, 'cy', 1) || 1);
          await visit(node, relations, { x: transform.x + num(off, 'x') * transform.sx - num(chOff, 'x') * sx, y: transform.y + num(off, 'y') * transform.sy - num(chOff, 'y') * sy, sx, sy }, decorations); continue;
        }
        if (!['sp', 'pic', 'cxnSp', 'graphicFrame'].includes(node.name)) continue;
        const inherited = inheritedShape(node), xf = find(child(node, 'spPr'), 'xfrm') || child(node, 'xfrm') || find(child(inherited, 'spPr'), 'xfrm');
        const off = child(xf, 'off'), ext = child(xf, 'ext');
        const x = transform.x + num(off, 'x') * transform.sx, y = transform.y + num(off, 'y') * transform.sy;
        const w = Math.max(1, num(ext, 'cx', cx * .7) * transform.sx), h = Math.max(1, num(ext, 'cy', cy * .15) * transform.sy);
        if (w > 20000 || h > 20000 || Math.abs(x) > 1e9 || Math.abs(y) > 1e9) { warn('an out-of-range object was skipped'); continue; }
        if (num(xf, 'rot') || attr(xf, 'flipH') === '1' || attr(xf, 'flipV') === '1') warn('rotated/flipped objects were imported without their transform');
        if (node.name === 'pic') {
          const blip = find(node, 'blip'), imageFile = relations.get(attr(blip, 'r:embed'))?.file;
          const extension = imageFile?.split('.').at(-1)?.toLowerCase(), mime = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }[extension];
          if (!mime || !zip.file(imageFile)) { warn('an unsupported or externally linked image was skipped'); continue; }
          if ((zip.file(imageFile)._data?.uncompressedSize || 0) > 8 * 1024 * 1024) { warn('an image larger than 8 MB was skipped'); continue; }
          if (find(node, 'srcRect')) warn('image crops may differ');
          add({ kind: 'image', color: '#263b36', x, y, imageWidth: w, imageHeight: h, data: `data:image/${mime};base64,${await zip.file(imageFile).async('base64')}` }); continue;
        }
        if (node.name === 'graphicFrame') { warn('a chart, table, or SmartArt object was skipped'); continue; }
        const spPr = child(node, 'spPr'), geometry = attr(child(spPr, 'prstGeom'), 'prst', 'rect'), solid = child(spPr, 'solidFill'), line = child(spPr, 'ln');
        if (solid || node.name === 'cxnSp') {
          const shape = node.name === 'cxnSp' ? 'line' : geometry === 'ellipse' ? 'ellipse' : 'rect';
          if (!['rect', 'roundRect', 'ellipse'].includes(geometry) && node.name !== 'cxnSp') warn('a custom shape was simplified to a rectangle');
          add({ kind: 'shape', shape, color: color(line, color(solid)), fill: solid ? color(solid) : 'transparent', x, y, imageWidth: w, imageHeight: h });
        }
        const body = child(node, 'txBody');
        if (!body) continue;
        let text = '', formats = [], firstProps;
        for (const [pi, paragraph] of children(body, 'p').entries()) {
          if (pi) text += '\n';
          for (const part of paragraph.kids) {
            if (part.name === 'br') { text += '\n'; continue; }
            if (!['r', 'fld'].includes(part.name)) continue;
            const value = content(child(part, 't')), props = child(part, 'rPr') || find(paragraph, 'defRPr');
            firstProps ||= props;
            const start = text.length; text += value;
            if (value && (attr(props, 'b') === '1' || attr(props, 'b') === 'true' || attr(props, 'i') === '1' || attr(props, 'i') === 'true')) formats.push({ start, end: text.length, bold: ['1', 'true'].includes(attr(props, 'b')), italic: ['1', 'true'].includes(attr(props, 'i')) });
          }
        }
        if (text.trim()) {
          if (text.length > 10000) { text = text.slice(0, 10000); formats = formats.filter(f => f.start < 10000).map(f => ({ ...f, end: Math.min(f.end, 10000) })); warn('text beyond 10,000 characters was truncated'); }
          const inheritedProps = find(inherited, 'defRPr'), fontSize = Math.max(12, Math.min(144, num(firstProps, 'sz', num(inheritedProps, 'sz', 2400)) / 100 * 12700 * scale));
          add({ kind: 'text', color: color(firstProps, '#263b36'), background: 'transparent', text, formats, x, y, fontSize, boxWidth: Math.max(80, Math.min(2000, w)) });
          if (['title', 'ctrTitle'].includes(attr(placeholder(node), 'type'))) page.title = text.trim().slice(0, 80);
        }
      }
    }
    if (attr(find(document, 'sld'), 'showMasterSp', '1') !== '0') await visit(find(master, 'spTree'), masterRels, undefined, true);
    await visit(find(layout, 'spTree'), layoutRels, undefined, true);
    await visit(find(document, 'spTree'), relationships);
    if (find(document, 'timing')) warn('animations were not imported');
    pages.push(page);
  }
  return { format: 'field-whiteboard', version: 2, title: filename.replace(/\.pptx$/i, '').slice(0, 80), pages, warnings: [...warnings], slideSize: { width: 1280, height } };
}
