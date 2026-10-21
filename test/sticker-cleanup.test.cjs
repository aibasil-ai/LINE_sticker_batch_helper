'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const core = require('../core.cjs');
const { parseTraditionalTitle } = require('../scan.cjs');
const { backupAndClearStickers } = require('../sticker-cleanup.cjs');

const today = new Date(2026, 9, 21, 0, 1);
function put(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}
function pack(project, name, title = '海岸小列車與小海龜') {
  const folder = path.join(project, 'sticker', name);
  const copy = put(path.join(folder, 'listing-copy.txt'), `【繁體中文】\n貼圖名稱：${title}\n商品說明：測試文案。\n`);
  const zip = put(path.join(folder, 'upload.zip'), Buffer.from([0, 1, 255, 13, 10]));
  return { folder, copy, zip };
}
function unchanged(files) {
  const before = files.map(file => [file, fs.readFileSync(file)]);
  return () => { for (const [file, data] of before) assert.deepEqual(fs.readFileSync(file), data); };
}
function cleanup(project) { return backupAndClearStickers(project, { now: today }); }
function lockAt(project) { return path.join(project, 'results', 'run.lock'); }
function backupAt(project, title) { return path.join(project, 'sticker-backups', '20261021-' + title); }

async function runStickerCleanupTests() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'line-sticker-cleanup-'));
  const passed = [];
  const check = async (name, fn) => {
    const project = fs.mkdtempSync(path.join(temp, 'case-'));
    await fn(project); assert.equal(fs.existsSync(lockAt(project)), false); passed.push(name);
  };
  try {
    await check('從兩種文案格式、語言別名、BOM 與 CRLF 讀取繁中名稱，不依賴其他語言', () => {
      assert.equal(parseTraditionalTitle('繁體中文\n名稱 / Title: 指宿海岸小列車與小海龜\nEnglish\nTitle: Other'), '指宿海岸小列車與小海龜');
      assert.equal(parseTraditionalTitle('\uFEFF【繁體中文】\r\n貼圖名稱：星旅小火車與柚子嚮導\r\n名稱計數：20 / 40'), '星旅小火車與柚子嚮導');
      assert.equal(parseTraditionalTitle('[zh-Hant]\nTitle: 小海龜\n[en]\nTitle: Turtle'), '小海龜');
      assert.throws(() => parseTraditionalTitle('English\nTitle: Turtle'), /繁體中文/);
      assert.throws(() => parseTraditionalTitle('繁體中文\n貼圖名稱：一\n貼圖名稱：二'), /重複/);
      assert.throws(() => parseTraditionalTitle('繁體中文\n貼圖名稱：一\n繁體中文\n貼圖名稱：二'), /重複/);
    });
    await check('全部備份核對後清除所有檔案，保留來源資料夾、檔名、相對路徑與專案其他資料', project => {
      const first = pack(project, '002', '星旅小火車與柚子嚮導'), second = pack(project, '003');
      const extra = put(path.join(first.folder, 'nested', 'deep', 'image.bin'), Buffer.from([6, 7, 8]));
      const notes = put(path.join(first.folder, 'notes.txt'), '其他筆記，不是文案');
      const hidden = put(path.join(second.folder, '.hidden'), '隱藏檔');
      fs.mkdirSync(path.join(project, 'sticker', '001', 'empty'), { recursive: true });
      const others = ['items.json', 'line-auth.json', 'results/progress.json', 'results/summary.json', 'sticker/root.txt']
        .map(file => put(path.join(project, file), file));
      const keepOthers = unchanged(others), originals = [first.copy, first.zip, extra, notes, second.copy, second.zip, hidden];
      const contents = originals.map(file => [file, fs.readFileSync(file)]);
      const result = cleanup(project);
      assert.equal(result.fileCount, 7); assert.equal(result.groups.length, 2);
      for (const [source, bytes] of contents) {
        const group = source.startsWith(first.folder + path.sep) ? first : second;
        const title = group === first ? '星旅小火車與柚子嚮導' : '海岸小列車與小海龜';
        assert.deepEqual(fs.readFileSync(path.join(backupAt(project, title), path.relative(group.folder, source))), bytes);
        assert.equal(fs.existsSync(source), false);
      }
      assert.deepEqual(fs.readdirSync(first.folder), ['nested']);
      assert.deepEqual(fs.readdirSync(path.dirname(extra)), []);
      assert.deepEqual(fs.readdirSync(second.folder), []);
      assert.equal(fs.existsSync(path.join(project, 'sticker', '001', 'empty')), true); keepOthers();
    });
    await check('日期採用執行當天的本機日期', project => {
      pack(project, '001', '跨年貼圖');
      const result = backupAndClearStickers(project, { now: new Date(2027, 0, 1, 0, 1) });
      assert.equal(path.basename(result.groups[0].backupDir), '20270101-跨年貼圖');
    });
    await check('同日同名及既有同名檔案自動加流水號，重複執行不覆蓋備份', project => {
      const base = backupAt(project, '同名貼圖');
      const old = put(path.join(base, 'keep.txt'), '既有備份'); put(base + '-2', '既有同名檔案');
      pack(project, '001', '同名貼圖'); pack(project, '002', '同名貼圖');
      let result = cleanup(project);
      assert.deepEqual(result.groups.map(group => path.basename(group.backupDir)), ['20261021-同名貼圖-3', '20261021-同名貼圖-4']);
      assert.equal(fs.readFileSync(old, 'utf8'), '既有備份'); assert.equal(fs.readFileSync(base + '-2', 'utf8'), '既有同名檔案');
      pack(project, '001', '同名貼圖'); result = cleanup(project);
      assert.equal(path.basename(result.groups[0].backupDir), '20261021-同名貼圖-5');
    });
    await check('資料夾名稱替換檔案系統禁用字元與結尾句點', project => {
      pack(project, '001', '小海龜/火車:*?"<>|\\.');
      const result = cleanup(project), name = path.basename(result.groups[0].backupDir);
      assert.match(name, /^20261021-小海龜_火車/);
      assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]|[. ]$/);
    });
    await check('空資料夾略過，重複清除不新增空備份', project => {
      fs.mkdirSync(path.join(project, 'sticker', '001', 'nested'), { recursive: true });
      assert.equal(cleanup(project).fileCount, 0); assert.equal(cleanup(project).groups.length, 0);
      assert.equal(fs.existsSync(path.join(project, 'sticker-backups')), false);
    });
    await check('支援子資料夾中的文案與隱藏素材資料夾', project => {
      const source = pack(project, '.hidden-group', '隱藏貼圖');
      fs.mkdirSync(path.join(source.folder, 'copy'));
      fs.renameSync(source.copy, path.join(source.folder, 'copy', 'listing.TXT'));
      const result = cleanup(project);
      assert.equal(result.fileCount, 2);
      assert.equal(fs.existsSync(path.join(backupAt(project, '隱藏貼圖'), 'copy', 'listing.TXT')), true);
    });
    for (const kind of ['缺少文案', '無繁中名稱', '多個不同名稱']) {
      await check(kind + '時整批停止，保留所有來源且不產生備份', project => {
        const first = pack(project, '001'), second = pack(project, '002', '第二組');
        if (kind === '缺少文案') fs.unlinkSync(second.copy);
        if (kind === '無繁中名稱') fs.writeFileSync(second.copy, 'English\nTitle: Missing Chinese');
        if (kind === '多個不同名稱') put(path.join(second.folder, 'other.txt'), '繁體中文\n貼圖名稱：其他組別');
        const keep = unchanged([first.copy, first.zip, second.zip, ...(fs.existsSync(second.copy) ? [second.copy] : [])]);
        assert.throws(() => cleanup(project), /繁體中文貼圖名稱|多個不同/); keep();
        assert.equal(fs.existsSync(path.join(project, 'sticker-backups')), false);
      });
    }
    await check('找不到 sticker 時停止且釋放鎖', project => {
      assert.throws(() => cleanup(project), /sticker/);
      assert.equal(fs.existsSync(path.join(project, 'sticker-backups')), false);
    });
    await check('既有執行鎖阻止備份與刪除，保留其他程序的鎖', project => {
      const source = pack(project, '001'), keep = unchanged([source.copy, source.zip]);
      put(lockAt(project), 'another process');
      assert.throws(() => cleanup(project), /run.lock/); keep();
      assert.equal(fs.readFileSync(lockAt(project), 'utf8'), 'another process');
      assert.equal(fs.existsSync(path.join(project, 'sticker-backups')), false); fs.unlinkSync(lockAt(project));
    });
    for (const failure of ['複製失敗', '備份內容不符', '來源內容變更', '新增來源檔案']) {
      await check(failure + '時不開始清除任何來源', project => {
        const first = pack(project, '001'), second = pack(project, '002', '第二組');
        const keep = unchanged([first.copy, first.zip, second.copy, second.zip]);
        const realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync; let deletions = 0;
        fs.copyFileSync = (source, target, flags) => {
          assert.equal(fs.existsSync(lockAt(project)), true);
          if (source === second.zip && failure === '複製失敗') throw new Error('測試複製失敗');
          realCopy(source, target, flags);
          if (source !== second.zip) return;
          if (failure === '備份內容不符') fs.appendFileSync(target, 'corrupt');
          if (failure === '來源內容變更') fs.appendFileSync(source, 'changed');
          if (failure === '新增來源檔案') put(path.join(first.folder, 'new.dat'), 'new');
        };
        fs.unlinkSync = file => { if (file !== lockAt(project)) deletions++; return realUnlink(file); };
        try { assert.throws(() => cleanup(project), /尚未刪除來源檔案/); }
        finally { fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink; }
        assert.equal(deletions, 0);
        if (failure === '來源內容變更') assert.equal(fs.readFileSync(second.zip).subarray(-7).toString(), 'changed');
        else keep();
        if (failure === '新增來源檔案') assert.equal(fs.readFileSync(path.join(first.folder, 'new.dat'), 'utf8'), 'new');
      });
    }
    await check('刪除失敗時保留完整備份並釋放鎖', project => {
      const source = pack(project, '001'), before = fs.readFileSync(source.zip), realUnlink = fs.unlinkSync;
      fs.unlinkSync = file => { if (file === source.zip) throw new Error('測試刪除失敗'); return realUnlink(file); };
      try { assert.throws(() => cleanup(project), /備份已完成.*刪除失敗/); }
      finally { fs.unlinkSync = realUnlink; }
      assert.deepEqual(fs.readFileSync(source.zip), before);
      assert.deepEqual(fs.readFileSync(path.join(backupAt(project, '海岸小列車與小海龜'), 'upload.zip')), before);
      assert.equal(fs.existsSync(path.join(backupAt(project, '海岸小列車與小海龜'), 'listing-copy.txt')), true);
    });
    for (const kind of ['來源連結', '備份目錄連結']) {
      await check(kind + '不會導致讀寫或刪除外部資料', project => {
        const source = pack(project, '001'), keep = unchanged([source.copy, source.zip]);
        const outside = path.join(project, 'external'); put(path.join(outside, 'keep.txt'), 'keep');
        const link = kind === '來源連結' ? path.join(source.folder, 'linked') : path.join(project, 'sticker-backups');
        fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => cleanup(project), /連結/); keep();
        assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
      });
    }
    await check('清除素材參數拒絕混用其他操作與自訂清單', () => {
      assert.equal(core.parseArgs(['--clear-sticker'])['clear-sticker'], true);
      for (const args of [['--scan'], ['--check'], ['--resume'], ['--login'], ['--auto'], ['--clear-items'], ['--clear-results'],
        ['--items', 'other.json'], ['--id', '001'], ['--zip', 'upload.zip'], ['--scan-dir', 'other'], ['--attach-url', 'https://creator.line.me/']]) {
        assert.throws(() => core.parseArgs(['--clear-sticker', ...args]), /分開使用/);
      }
    });
    await check('CLI 顯示每組備份位置，不需清單、登入或瀏覽器；說明不清除素材', async project => {
      const source = pack(project, '001'), keep = unchanged([source.copy, source.zip]);
      const script = path.resolve(__dirname, '..', 'run.cjs'), realRequire = createRequire(script);
      const code = fs.readFileSync(script, 'utf8');
      const run = async args => {
        const messages = [], fakeProcess = { argv: ['node', script, ...args], exitCode: 0 };
        await new vm.Script(code, { filename: script }).runInNewContext({
          require(name) { assert.notEqual(name, '@playwright/test'); return realRequire(name); }, __dirname: project, process: fakeProcess,
          console: { log: (...values) => messages.push(values.join(' ')), error: (...values) => messages.push(values.join(' ')) }
        });
        return { code: fakeProcess.exitCode, messages: messages.join('\n') };
      };
      let result = await run(['--clear-sticker', '--help']);
      assert.equal(result.code, 0, result.messages); assert.match(result.messages, /node run\.cjs --clear-sticker/); keep();
      result = await run(['--clear-sticker']);
      assert.equal(result.code, 0, result.messages); assert.match(result.messages, /sticker-backups/);
      assert.match(result.messages, /已備份並清除 1 組.*2 個檔案/); assert.deepEqual(fs.readdirSync(source.folder), []);
    });
    await check('從其他工作目錄執行 CLI 仍使用工具所在專案的 sticker 與備份目錄', project => {
      const source = pack(project, '001');
      for (const name of ['run.cjs', 'core.cjs', 'scan.cjs', 'sticker-cleanup.cjs']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(project, name));
      const elsewhere = path.join(temp, 'elsewhere'); fs.mkdirSync(elsewhere);
      const other = pack(elsewhere, '001', '其他專案'), keepOther = unchanged([other.copy, other.zip]);
      const result = spawnSync(process.execPath, [path.join(project, 'run.cjs'), '--clear-sticker'], { cwd: elsewhere, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /已備份並清除 1 組/);
      assert.deepEqual(fs.readdirSync(source.folder), []); keepOther();
      assert.equal(fs.readdirSync(path.join(project, 'sticker-backups')).length, 1);
      assert.equal(fs.existsSync(path.join(elsewhere, 'sticker-backups')), false);
    });
    return { passed: passed.length, tests: passed };
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'line-sticker-cleanup-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { runStickerCleanupTests };
if (require.main === module) runStickerCleanupTests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
