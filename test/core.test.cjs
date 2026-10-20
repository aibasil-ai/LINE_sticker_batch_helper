'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const core = require('../core.cjs');

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const typeBytes = Buffer.from(type);
  const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([typeBytes, bytes])));
  return Buffer.concat([head, typeBytes, bytes, tail]);
}
function png(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name), compressed = zlib.deflateRawSync(content);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(content), 14);
    lh.writeUInt32LE(compressed.length, 18); lh.writeUInt32LE(content.length, 22); lh.writeUInt16LE(nameBytes.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(content), 16); ch.writeUInt32LE(compressed.length, 20); ch.writeUInt32LE(content.length, 24); ch.writeUInt16LE(nameBytes.length, 28); ch.writeUInt32LE(offset, 42);
    const local = Buffer.concat([lh, nameBytes, compressed]); locals.push(local); central.push(Buffer.concat([ch, nameBytes])); offset += local.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function runTests() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'line-sticker-test-'));
  const outcomes = [];
  const check = (name, fn) => { fn(); outcomes.push(name); };
  try {
    const sample = core.readJSON(path.join(__dirname, 'fixtures', 'items.json'));
    const configFile = path.join(temp, 'items.json');
    const entries = [['main.png', png(240, 240)], ['tab.png', png(96, 74)], ...Array.from({ length: 32 }, (_, i) => [String(i + 1).padStart(2, '0') + '.png', png(370, 320)])];
    const archive = path.join(temp, 'custom-name.zip'); fs.writeFileSync(archive, zip(entries));
    core.writeJSON(configFile, sample);
    check('三語計數與提供的文案一致', () => assert.deepEqual(Object.values(sample.items[0].languages).map(v => [core.textUnits(v.title), core.textUnits(v.description)]), [[22, 90], [29, 155], [24, 118]]));
    check('相對路徑相對清單而非終端機目錄', () => assert.equal(core.loadConfig(configFile).items[0].zipAbsolutePath, path.resolve(temp, sample.items[0].zip)));
    check('允許單組覆寫任意 ZIP 檔名與位置', () => assert.equal(core.loadConfig(configFile, { id: 'ibusuki-002', zip: archive }).items[0].zipAbsolutePath, archive));
    check('拒絕未指定組別的 ZIP 覆寫', () => assert.throws(() => core.parseArgs(['--zip', archive]), /--id/));
    check('拒絕重複組別 ID', () => { const clone = structuredClone(sample); clone.items.push(structuredClone(clone.items[0])); core.writeJSON(configFile, clone); assert.throws(() => core.loadConfig(configFile), /重複/); core.writeJSON(configFile, sample); });
    check('拒絕過長文案', () => { const clone = structuredClone(sample); clone.items[0].languages.en.title = 'A'.repeat(41); core.writeJSON(configFile, clone); assert.throws(() => core.loadConfig(configFile), /上限/); core.writeJSON(configFile, sample); });
    check('拒絕無完成訊號的自動驗證模式', () => { const clone = structuredClone(sample); clone.verification.mode = 'selector'; core.writeJSON(configFile, clone); assert.throws(() => core.loadConfig(configFile), /readySelector/); core.writeJSON(configFile, sample); });
    check('通過標準 32 張 + 主圖 + 標籤 ZIP', () => assert.equal(core.inspectZip(archive, 32).imageCount, 34));
    check('拒絕缺圖 ZIP', () => { const file = path.join(temp, 'missing.zip'); fs.writeFileSync(file, zip(entries.slice(1))); assert.throws(() => core.inspectZip(file, 32), /缺少/); });
    check('拒絕圖片放在巢狀資料夾', () => { const file = path.join(temp, 'nested.zip'); fs.writeFileSync(file, zip(entries.map(([n, b]) => ['folder/' + n, b]))); assert.throws(() => core.inspectZip(file, 32), /根目錄/); });
    check('拒絕主圖尺寸錯誤', () => { const file = path.join(temp, 'wrong-size.zip'); fs.writeFileSync(file, zip([['main.png', png(100, 100)], ...entries.slice(1)])); assert.throws(() => core.inspectZip(file, 32), /尺寸不符/); });
    check('拒絕遭截斷 ZIP', () => { const file = path.join(temp, 'broken.zip'); fs.writeFileSync(file, fs.readFileSync(archive).subarray(0, -4)); assert.throws(() => core.inspectZip(file, 32), /結構/); });
    check('檔名與路徑更動不改變續跑識別', () => { const item = core.loadConfig(configFile).items[0], hash = core.inspectZip(archive, 32).hash; const moved = { ...item, zip: 'different.zip', zipAbsolutePath: 'D:/new/different.zip' }; assert.equal(core.fingerprint(item, hash), core.fingerprint(moved, hash)); });
    check('文案異動會改變續跑識別', () => { const item = core.loadConfig(configFile).items[0]; const changed = structuredClone(item); changed.languages.en.title += '!'; assert.notEqual(core.fingerprint(item, 'hash'), core.fingerprint(changed, 'hash')); });
    check('只接受 LINE 官方商品管理網址', () => { assert.equal(core.productFromURL('https://creator.line.me/my/123/sticker/4567890/image').id, '4567890'); assert.equal(core.productFromURL('https://other.example/sticker/4567890'), null); });
    return { passed: outcomes.length, tests: outcomes };
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'line-sticker-test-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { runTests, png, zip };
if (require.main === module) console.log(JSON.stringify(runTests(), null, 2));
