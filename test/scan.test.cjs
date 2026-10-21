'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../core.cjs');
const { parseListingCopy, generateItems } = require('../scan.cjs');
const { png, zip } = require('./core.test.cjs');
const fixture = core.readJSON(path.join(__dirname, 'fixtures', 'items.json'));
const languages = fixture.items[0].languages;

function listing(copy = languages, labelled = false) {
  const headings = ['繁體中文', 'English', '日本語'];
  return (labelled ? '三語上架文案\n計數規則：全形 2，半形 1。\n\n' : '') + Object.values(copy).map((value, index) =>
    `${labelled ? '【' + headings[index] + '】' : headings[index]}\n` +
    `${labelled ? '貼圖名稱：' : '名稱 / Title: '}${value.title}\n名稱計數：0 / 40\n` +
    `${labelled ? '商品說明：' : '說明 / Description: '}${value.description}\n說明計數：0 / 160\n`).join('\n');
}
function entries(amount) {
  return [['main.png', png(240, 240)], ['tab.png', png(96, 74)], ...Array.from({ length: amount }, (_, i) => [String(i + 1).padStart(2, '0') + '.png', png(370, 320)])];
}
const archives = new Map();
function archive(amount) {
  if (!archives.has(amount)) archives.set(amount, zip(entries(amount)));
  return archives.get(amount);
}
function configAt(folder, overrides = {}) {
  const file = path.join(folder, 'items.json');
  core.writeJSON(file, { ...structuredClone(fixture), items: [], ...overrides });
  return file;
}
function packAt(root, name, amount = 8, copy = listing()) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  const zipFile = path.join(folder, 'upload.zip'), copyFile = path.join(folder, 'listing-copy.txt');
  fs.writeFileSync(zipFile, archive(amount)); fs.writeFileSync(copyFile, copy, 'utf8');
  return { folder, zipFile, copyFile };
}
function unchangedOnFailure(file, fn, message) {
  const before = fs.readFileSync(file);
  assert.throws(fn, message);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'results', 'run.lock')), false);
}

function runScanTests() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'line-sticker-scan-'));
  const passed = [];
  const check = (name, fn) => {
    const folder = fs.mkdtempSync(path.join(temp, 'case-'));
    fn(folder); passed.push(name);
  };
  try {
    check('解析兩種既有文案格式、BOM 與 CRLF，忽略計數行', () => {
      assert.deepEqual(parseListingCopy(listing()), languages);
      assert.deepEqual(parseListingCopy('\uFEFF' + listing(languages, true).replace(/\n/g, '\r\n')), languages);
    });
    check('保留多行說明與段落', () => {
      const copy = structuredClone(languages); copy.en.description = 'First line.\n\nSecond line.';
      assert.deepEqual(parseListingCopy(listing(copy)), copy);
    });
    check('缺少語言、重複段落或欄位及過長文案會報錯', () => {
      assert.throws(() => parseListingCopy(listing().split('日本語')[0]), /缺少 ja/);
      assert.throws(() => parseListingCopy(listing() + '\nEnglish'), /重複語言/);
      assert.throws(() => parseListingCopy(listing() + '\n名稱：其他標題'), /重複欄位/);
      const copy = structuredClone(languages); copy.en.description = 'A'.repeat(161);
      assert.throws(() => parseListingCopy(listing(copy)), /上限/);
      assert.throws(() => parseListingCopy(listing().replace('名稱計數：0 / 40', '不明欄位')), /無法辨識/);
    });
    check('從空清單掃描直屬資料夾、依數字排序、自動判斷張數', folder => {
      const config = structuredClone(fixture); delete config.items;
      const file = path.join(folder, 'items.json'), root = path.join(folder, 'sticker');
      core.writeJSON(file, config);
      packAt(root, '010', 16); packAt(root, '002');
      fs.mkdirSync(path.join(root, '.hidden')); fs.mkdirSync(path.join(root, '__MACOSX'));
      fs.writeFileSync(path.join(root, '.DS_Store'), 'ignored');
      const result = generateItems(file), saved = core.readJSON(file);
      assert.deepEqual(saved.items.map(item => item.id), ['002', '010']);
      assert.deepEqual(saved.items.map(item => item.stickerCount), [8, 16]);
      assert.equal(saved.items[0].zip, 'sticker/002/upload.zip');
      assert.deepEqual(saved.items[0].languages, languages);
      assert.deepEqual(saved.defaults, fixture.defaults); assert.deepEqual(saved.verification, fixture.verification);
      assert.equal(result.total, 2); assert.equal(result.scanDir, root);
      assert.equal(fs.existsSync(path.join(folder, 'results', 'run.lock')), false);
      const before = fs.readFileSync(file); generateItems(file);
      assert.deepEqual(fs.readFileSync(file), before);
    });
    check('30 個資料夾只在不連續編號放素材時，掃描有資料的組別並略過其餘空資料夾', folder => {
      const file = configAt(folder), root = path.join(folder, 'sticker');
      const names = Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(3, '0'));
      for (const name of names) fs.mkdirSync(path.join(root, name), { recursive: true });
      packAt(root, '025', 24); packAt(root, '007', 16); packAt(root, '001');
      const result = generateItems(file), expected = ['001', '007', '025'];
      assert.deepEqual(result.scanned.map(item => item.id), expected);
      assert.deepEqual(core.readJSON(file).items.map(item => item.id), expected);
      assert.deepEqual(result.skippedEmpty, names.filter(name => !expected.includes(name)));
      assert.equal(result.total, 3); assert.equal(fs.existsSync(path.join(folder, 'results', 'run.lock')), false);
    });
    check('略過空資料夾時保留對應的既有 ID、停用狀態、個別設定與進度', folder => {
      const existing = { ...structuredClone(fixture.items[0]), enabled: false, priceTier: '7' };
      const file = configAt(folder, { items: [existing] }), root = path.join(folder, 'sticker');
      fs.mkdirSync(path.join(root, '002'), { recursive: true }); packAt(root, '007');
      const stateFile = path.join(folder, 'results', 'progress.json');
      core.writeJSON(stateFile, { version: 1, items: { [existing.id]: { stage: 'draft_ready' } } });
      const progress = fs.readFileSync(stateFile), result = generateItems(file), saved = core.readJSON(file);
      assert.deepEqual(result.skippedEmpty, ['002']); assert.equal(result.total, 2);
      assert.deepEqual(saved.items[0], existing); assert.equal(saved.items[1].id, '007');
      assert.deepEqual(fs.readFileSync(stateFile), progress);
    });
    check('只有隱藏檔的資料夾視為空，繼續掃描其他有效素材', folder => {
      const file = configAt(folder), root = path.join(folder, 'sticker'), empty = path.join(root, '002');
      fs.mkdirSync(path.join(empty, '.metadata'), { recursive: true });
      fs.writeFileSync(path.join(empty, '.DS_Store'), 'metadata'); fs.writeFileSync(path.join(empty, '.gitkeep'), '');
      packAt(root, '007');
      const result = generateItems(file);
      assert.deepEqual(result.skippedEmpty, ['002']); assert.deepEqual(result.scanned.map(item => item.id), ['007']);
      assert.equal(fs.readFileSync(path.join(empty, '.DS_Store'), 'utf8'), 'metadata');
    });
    check('所有資料夾皆空時正常結束，原樣保留空清單、既有清單及省略 items 的設定與進度', folder => {
      const file = path.join(folder, 'items.json'), root = path.join(folder, 'sticker');
      for (let index = 1; index <= 30; index++) fs.mkdirSync(path.join(root, String(index).padStart(3, '0')), { recursive: true });
      const stateFile = path.join(folder, 'results', 'progress.json');
      core.writeJSON(stateFile, { version: 1, items: { existing: { stage: 'draft_ready' } } });
      const progress = fs.readFileSync(stateFile);
      for (const items of [[], fixture.items, undefined]) {
        const config = { ...structuredClone(fixture), items };
        if (items === undefined) delete config.items;
        fs.writeFileSync(file, '\uFEFF' + JSON.stringify(config, null, 4) + '\r\n', 'utf8');
        const before = fs.readFileSync(file), result = generateItems(file);
        assert.deepEqual(result.scanned, []); assert.equal(result.skippedEmpty.length, 30);
        assert.equal(result.total, items?.length ?? 0); assert.deepEqual(fs.readFileSync(file), before);
        assert.deepEqual(fs.readFileSync(stateFile), progress);
        assert.equal(fs.existsSync(path.join(folder, 'results', 'run.lock')), false);
      }
    });
    check('素材誤放在更深層的非空資料夾仍回報錯誤，不當作空資料夾略過', folder => {
      const file = configAt(folder), root = path.join(folder, 'sticker');
      packAt(path.join(root, '001'), 'nested');
      unchangedOnFailure(file, () => generateItems(file), /需要且只能有一個/);
    });
    check('ZIP 改名時保留既有 ID、停用狀態、個別設定及續跑指紋', folder => {
      const previous = structuredClone(fixture.items[0]);
      previous.id = 'custom-id'; previous.enabled = false; previous.priceTier = '7';
      previous.languages = { en: previous.languages.en, 'zh-Hant': previous.languages['zh-Hant'], ja: previous.languages.ja };
      const file = configAt(folder, { items: [previous] });
      const pack = packAt(path.join(folder, 'sticker'), '002', 32);
      const hash = core.inspectZip(pack.zipFile, 32).hash;
      const before = core.fingerprint({ ...fixture.defaults, ...previous }, hash);
      generateItems(file);
      const item = core.readJSON(file).items[0];
      assert.equal(item.id, 'custom-id'); assert.equal(item.enabled, false); assert.equal(item.priceTier, '7');
      assert.equal(item.zip, 'sticker/002/upload.zip');
      assert.equal(core.fingerprint({ ...fixture.defaults, ...item }, hash), before);
    });
    check('重新掃描會更新來源文案，並保留未掃描的既有項目與進度', folder => {
      const existing = structuredClone(fixture.items[0]); existing.zip = 'elsewhere/old.zip';
      const file = configAt(folder, { items: [existing] }), root = path.join(folder, 'sticker');
      const pack = packAt(root, '003');
      const stateFile = path.join(folder, 'results', 'progress.json');
      core.writeJSON(stateFile, { version: 1, items: { [existing.id]: { stage: 'draft_ready' } } });
      const progress = fs.readFileSync(stateFile);
      generateItems(file);
      const copy = structuredClone(languages); copy.en.title = 'Changed title';
      fs.writeFileSync(pack.copyFile, listing(copy)); generateItems(file);
      const saved = core.readJSON(file);
      assert.equal(saved.items.length, 2); assert.deepEqual(saved.items[0], existing);
      assert.equal(saved.items[1].languages.en.title, 'Changed title');
      assert.deepEqual(fs.readFileSync(stateFile), progress);
    });
    check('scanDir 與命令列覆寫皆相對 baseDir 解析', folder => {
      const configDir = path.join(folder, 'settings');
      const file = configAt(configDir, { baseDir: '../assets', scanDir: 'incoming' });
      const assets = path.join(folder, 'assets');
      packAt(path.join(assets, 'incoming'), '001');
      packAt(path.join(assets, 'other'), '002');
      assert.equal(generateItems(file).scanDir, path.join(assets, 'incoming'));
      assert.equal(core.readJSON(file).items[0].zip, 'incoming/001/upload.zip');
      assert.equal(generateItems(file, path.join(assets, 'other')).scanDir, path.join(assets, 'other'));
      assert.equal(core.readJSON(file).items[1].zip, 'other/002/upload.zip');
      assert.equal(core.readJSON(file).scanDir, 'incoming');
    });
    for (const extension of ['.zip', '.txt']) {
      for (const amount of [0, 2]) check(`${extension} 數量為 ${amount} 時不覆寫清單`, folder => {
        const file = configAt(folder), pack = packAt(path.join(folder, 'sticker'), '001');
        const target = extension === '.zip' ? pack.zipFile : pack.copyFile;
        if (amount === 0) fs.unlinkSync(target);
        else fs.copyFileSync(target, path.join(pack.folder, 'extra' + extension));
        unchangedOnFailure(file, () => generateItems(file), /需要且只能有一個/);
      });
    }
    check('後續資料夾的文案錯誤不會寫入部分結果', folder => {
      const file = configAt(folder), root = path.join(folder, 'sticker');
      packAt(root, '001'); packAt(root, '002', 8, 'English\nTitle: Missing other languages');
      unchangedOnFailure(file, () => generateItems(file), /缺少/);
    });
    check('ZIP 無效、張數不支援或圖號不連續時不產生清單', folder => {
      const file = configAt(folder), pack = packAt(path.join(folder, 'sticker'), '001');
      fs.writeFileSync(pack.zipFile, 'not a zip');
      unchangedOnFailure(file, () => generateItems(file), /upload\.zip.*ZIP/);
      fs.writeFileSync(pack.zipFile, archive(7));
      unchangedOnFailure(file, () => generateItems(file), /張數/);
      fs.writeFileSync(pack.zipFile, zip(entries(8).map(([name, content]) => [name === '08.png' ? '09.png' : name, content])));
      unchangedOnFailure(file, () => generateItems(file), /缺少：08.png/);
    });
    check('空掃描根目錄正常結束，非空素材仍會驗證共用設定', folder => {
      const file = configAt(folder), root = path.join(folder, 'sticker');
      fs.mkdirSync(root);
      const before = fs.readFileSync(file), result = generateItems(file);
      assert.deepEqual(result.scanned, []); assert.deepEqual(result.skippedEmpty, []); assert.equal(result.total, 0);
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.existsSync(path.join(folder, 'results', 'run.lock')), false);
      packAt(root, '001');
      const config = core.readJSON(file); config.defaults.priceTier = 'invalid'; core.writeJSON(file, config);
      unchangedOnFailure(file, () => generateItems(file), /priceTier/);
    });
    check('ID 衝突或多個既有項目對應同一資料夾時不改動清單', folder => {
      const existing = structuredClone(fixture.items[0]); existing.id = '001'; existing.zip = 'elsewhere/upload.zip';
      const file = configAt(folder, { items: [existing] });
      packAt(path.join(folder, 'sticker'), '001');
      unchangedOnFailure(file, () => generateItems(file), /ID 已被其他組使用/);
      const config = core.readJSON(file); config.items = [
        { ...existing, id: 'first', zip: 'sticker/001/a.zip' },
        { ...existing, id: 'second', zip: 'sticker/001/b.zip' }
      ]; core.writeJSON(file, config);
      unchangedOnFailure(file, () => generateItems(file), /多個既有項目/);
    });
    check('掃描不會覆寫或移除其他執行程序的鎖', folder => {
      const file = configAt(folder), lock = path.join(folder, 'results', 'run.lock');
      packAt(path.join(folder, 'sticker'), '001');
      core.writeJSON(lock, { pid: 123 });
      const before = fs.readFileSync(file), lockBefore = fs.readFileSync(lock);
      assert.throws(() => generateItems(file), /run.lock/);
      assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readFileSync(lock), lockBefore);
    });
    check('CLI 可在其他工作目錄產生清單，並回報參數或掃描錯誤', folder => {
      const file = configAt(folder);
      packAt(path.join(folder, 'custom source'), '001');
      const run = args => spawnSync(process.execPath, [path.join(__dirname, '..', 'run.cjs'), '--items', file, ...args], { cwd: temp, encoding: 'utf8' });
      let result = run(['--scan', '--scan-dir', 'custom source']);
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /尚未連線 LINE/);
      assert.equal(core.readJSON(file).items[0].zip, 'custom source/001/upload.zip');
      result = run(['--scan-dir', 'custom source']);
      assert.equal(result.status, 1); assert.match(result.stderr, /必須搭配 --scan/);
      result = run(['--scan', '--resume']);
      assert.equal(result.status, 1); assert.match(result.stderr, /分開使用/);
      result = run(['--scan', '--scan-dir', 'missing']);
      assert.equal(result.status, 1); assert.equal(fs.existsSync(path.join(folder, 'results', 'run.lock')), false);
    });
    check('CLI 顯示實際掃描組數與略過名單，全部空時正常結束並保留清單', folder => {
      const file = configAt(folder), root = path.join(folder, 'sticker');
      for (let index = 1; index <= 30; index++) fs.mkdirSync(path.join(root, String(index).padStart(3, '0')), { recursive: true });
      const pack = packAt(root, '007');
      const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'run.cjs'), '--scan', '--items', file], { cwd: temp, encoding: 'utf8' });
      let result = run();
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /掃描 1 組/);
      assert.match(result.stdout, /略過 29 個空資料夾：001、002/); assert.match(result.stdout, /030/);
      assert.deepEqual(core.readJSON(file).items.map(item => item.id), ['007']);
      fs.unlinkSync(pack.copyFile); fs.unlinkSync(pack.zipFile);
      const before = fs.readFileSync(file); result = run();
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /沒有可掃描的素材，原清單保留/);
      assert.match(result.stdout, /略過 30 個空資料夾/); assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(fs.existsSync(path.join(folder, 'results', 'run.lock')), false);
    });
    return { passed: passed.length, tests: passed };
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'line-sticker-scan-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { runScanTests };
if (require.main === module) console.log(JSON.stringify(runScanTests(), null, 2));
