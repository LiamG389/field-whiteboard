import test from 'node:test';
import assert from 'node:assert/strict';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { importPptx } from './pptx-import.js';
import { makeExport } from './exports.js';
import { testPageImage } from './png-fixture.js';
import './public/model.js';

test('PowerPoint imports ordered slides, editable text formatting, images, shapes, and background', async () => {
  const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE';
  const first = deck.addSlide(); first.background = { color: 'AABBCC' };
  first.addText([{ text: 'Bold', options: { bold: true } }, { text: ' italic', options: { italic: true } }], { x: 1, y: 1, w: 4, h: 1, fontSize: 24, color: '112233' });
  first.addImage({ data: testPageImage(), x: 6, y: 1, w: 4, h: 2 });
  first.addShape(deck.ShapeType.ellipse, { x: 1, y: 4, w: 2, h: 1, fill: { color: 'FFCC00' } });
  deck.addSlide().addText('Second slide', { x: 1, y: 1, w: 4, h: 1 });
  const imported = await importPptx(await deck.write({ outputType: 'nodebuffer' }), 'Example.pptx');
  assert.equal(imported.pages.length, 2); assert.equal(imported.title, 'Example');
  assert.equal(imported.pages[0].background.toLowerCase(), '#aabbcc');
  const text = imported.pages[0].strokes.find(s => s.kind === 'text');
  assert.equal(text.text, 'Bold italic'); assert.ok(text.formats.some(f => f.bold)); assert.ok(text.formats.some(f => f.italic));
  assert.ok(imported.pages[0].strokes.some(s => s.kind === 'image'));
  assert.ok(imported.pages[0].strokes.some(s => s.kind === 'shape' && s.shape === 'ellipse'));
  assert.equal(imported.pages[1].strokes.find(s => s.kind === 'text').text, 'Second slide');
  for (const page of imported.pages) for (const item of page.strokes) assert.ok(globalThis.FieldModel.validItem(item), JSON.stringify(item).slice(0, 200));
});

test('a Field-exported PowerPoint round-trips all page images in order', async () => {
  const pages = [{ title: 'One', image: testPageImage() }, { title: 'Two', image: testPageImage(200, 50, 80) }];
  const pptx = await makeExport({ format: 'pptx', title: 'Field', pages });
  const imported = await importPptx(pptx.buffer);
  assert.equal(imported.pages.length, 2);
  assert.equal(imported.pages[0].strokes.find(s => s.kind === 'image').data, pages[0].image);
  assert.equal(imported.pages[1].strokes.find(s => s.kind === 'image').data, pages[1].image);
});

test('PowerPoint importer rejects invalid archives and XML entity declarations', async () => {
  await assert.rejects(importPptx(Buffer.from('not a pptx')));
  const zip = new JSZip(); zip.file('ppt/presentation.xml', '<!DOCTYPE presentation [<!ENTITY bad "x">]><presentation/>');
  await assert.rejects(importPptx(await zip.generateAsync({ type: 'nodebuffer' })), /Unsupported XML/);
});
