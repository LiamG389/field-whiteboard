import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { makeExport } from './exports.js';
import { testPageImage } from './png-fixture.js';

test('PowerPoint export embeds every page in order at widescreen dimensions', async () => {
  const pages = [{ title: 'First', image: testPageImage() }, { title: 'Second', image: testPageImage(180, 80, 40) }];
  const result = await makeExport({ title: 'Two pages', format: 'pptx', pages });
  const zip = await JSZip.loadAsync(result.buffer);
  assert.equal(Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length, 2);
  const presentation = await zip.file('ppt/presentation.xml').async('string');
  assert.match(presentation, /cx="12192000" cy="6858000"/);
  const media = await Promise.all(Object.keys(zip.files).filter(f => /^ppt\/media\/.*\.png$/.test(f)).map(f => zip.file(f).async('nodebuffer')));
  assert.equal(media.length, 2);
  for (const page of pages) assert.ok(media.some(buffer => buffer.equals(Buffer.from(page.image.split(',')[1], 'base64'))));
  assert.match(await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'), /First/);
  assert.match(await zip.file('ppt/notesSlides/notesSlide2.xml').async('string'), /Second/);
});

test('PDF export creates one landscape page per whiteboard, including blank pages', async () => {
  const result = await makeExport({ title: 'PDF pages', format: 'pdf', pages: [{ image: testPageImage() }, { image: testPageImage(255, 255, 255) }] });
  const pdf = result.buffer.toString('latin1');
  assert.ok(pdf.startsWith('%PDF-'));
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 2);
  assert.equal((pdf.match(/\/MediaBox \[0 0 960 540\]/g) || []).length, 2);
  assert.equal((pdf.match(/\/Subtype \/Image/g) || []).length, 2);
  assert.match(pdf, /%%EOF/);
});

test('export validation rejects external resources, malformed images, and unsupported formats', async () => {
  for (const input of [{ format: 'exe', pages: [{}] }, { format: 'pdf', pages: [] }, { format: 'pptx', pages: [{ image: 'http://example.com/private.png' }] }, { format: 'pdf', pages: [{ image: 'data:image/png;base64,AAAA' }] }]) await assert.rejects(makeExport(input));
});
