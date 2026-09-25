import PptxGenJS from 'pptxgenjs';
import PDFDocument from 'pdfkit';

export async function makeExport(input) {
  if (!input || !['pdf', 'pptx'].includes(input.format) || !Array.isArray(input.pages) || !input.pages.length || input.pages.length > 100) throw new Error('Export requires 1–100 pages.');
  const images = input.pages.map(page => {
    if (typeof page.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(page.image) || page.image.length > 8 * 1024 * 1024) throw new Error('Invalid page image.');
    const buffer = Buffer.from(page.image.split(',')[1], 'base64');
    if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || buffer.readUInt32BE(16) !== 1920 || buffer.readUInt32BE(20) !== 1080) throw new Error('Page images must be 1920 × 1080 PNGs.');
    return buffer;
  });
  const title = typeof input.title === 'string' ? input.title.slice(0, 80) : 'Field document';
  if (input.format === 'pptx') {
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; pptx.title = title; pptx.author = 'Field'; pptx.subject = 'Whiteboard pages';
    input.pages.forEach((page, index) => {
      const slide = pptx.addSlide();
      slide.addImage({ data: `image/png;base64,${images[index].toString('base64')}`, x: 0, y: 0, w: 13.333333, h: 7.5 });
      slide.addNotes(typeof page.title === 'string' ? page.title.slice(0, 80) : `Page ${index + 1}`);
    });
    return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await pptx.write({ outputType: 'nodebuffer', compression: true }) };
  }
  const doc = new PDFDocument({ autoFirstPage: false, info: { Title: title, Author: 'Field' } });
  const output = new Promise((resolve, reject) => { const chunks = []; doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  try {
    images.forEach(image => { doc.addPage({ size: [960, 540], margin: 0 }); doc.image(image, 0, 0, { width: 960, height: 540 }); });
    doc.end();
  } catch (error) { doc.destroy(error); }
  return { mime: 'application/pdf', buffer: await output };
}
