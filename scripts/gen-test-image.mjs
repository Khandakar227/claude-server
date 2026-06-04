// Generates a solid-color PNG and prints its base64 (no deps). Used to test
// multimodal attachments. Usage: node scripts/gen-test-image.mjs [r] [g] [b]
import zlib from "node:zlib";

const [r = 255, g = 0, b = 0] = process.argv.slice(2).map(Number);
const W = 64, H = 64;

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type: truecolor RGB

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const off = y * (1 + W * 3);
  raw[off] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const p = off + 1 + x * 3;
    raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
  }
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
process.stdout.write(png.toString("base64"));
