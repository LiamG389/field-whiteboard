import { deflateSync } from 'node:zlib';

// Deterministic PNG fixture for checking image embedding and page order.
export function testPageImage(red = 40, green = 100, blue = 70) {
  const width = 1920, height = 1080;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 80; x < 900; x++) {
      if (y < 80 || y > 600) continue;
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = red; raw[offset + 1] = green; raw[offset + 2] = blue;
    }
  }
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), tail = Buffer.alloc(4); size.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, tail]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
