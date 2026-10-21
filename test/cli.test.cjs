'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const core = require('../core.cjs');
const { png, zip } = require('./core.test.cjs');

async function runCLITests() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'line-sticker-cli-'));
  const scriptPath = path.resolve(__dirname, '..', 'run.cjs');
  const source = fs.readFileSync(scriptPath, 'utf8');
  const realRequire = createRequire(scriptPath);
  const passed = [];
  const configFile = path.join(folder, 'items.json');
  const stateFile = path.join(folder, 'results', 'progress.json');
  const lockFile = path.join(folder, 'results', 'run.lock');
  const config = core.readJSON(path.join(__dirname, 'fixtures', 'items.json'));
  config.items[0].zip = 'arbitrary-name.zip';
  const archive = path.join(folder, 'arbitrary-name.zip');
  const entries = [['main.png', png(240, 240)], ['tab.png', png(96, 74)], ...Array.from({ length: 32 }, (_, i) => [String(i + 1).padStart(2, '0') + '.png', png(370, 320)])];
  fs.writeFileSync(archive, zip(entries));
  core.writeJSON(configFile, config);
  const item = core.loadConfig(configFile).items[0];
  const hash = core.fingerprint(item, core.inspectZip(archive, 32).hash);
  async function execute(args) {
    let browserCalls = 0;
    const messages = [];
    const fakeProcess = { argv: ['node', scriptPath, '--items', configFile, ...args], pid: 123456789, stdin: { isTTY: false }, stdout: {}, exitCode: 0 };
    const sandbox = {
      require(name) { if (name === '@playwright/test') { browserCalls++; throw new Error('TEST: unexpected browser launch'); } return realRequire(name); },
      process: fakeProcess, __dirname: path.dirname(scriptPath),
      console: { log: (...v) => messages.push(v.join(' ')), error: (...v) => messages.push(v.join(' ')) }
    };
    await new vm.Script(source, { filename: scriptPath }).runInNewContext(sandbox);
    return { code: fakeProcess.exitCode, messages: messages.join('\n'), browserCalls };
  }
  const seed = stage => core.writeJSON(stateFile, { version: 1, items: { 'ibusuki-002': { fingerprint: hash, stage } } });
  try {
    let result = await execute(['--check']);
    assert.equal(result.code, 0); assert.equal(result.browserCalls, 0); assert.match(result.messages, /資料檢查通過/); passed.push('預檢不啟動瀏覽器或要求登入檔');
    seed('draft_ready'); result = await execute(['--resume']);
    assert.equal(result.code, 0); assert.equal(result.browserCalls, 0); assert.equal(fs.existsSync(lockFile), false); passed.push('續跑跳過已完成商品並釋放鎖');
    result = await execute([]);
    assert.equal(result.code, 1); assert.equal(result.browserCalls, 0); assert.match(result.messages, /已有進度/); passed.push('不帶續跑旗標時拒絕重複新增');
    seed('creating'); result = await execute(['--resume']);
    assert.equal(result.code, 1); assert.equal(result.browserCalls, 0); assert.match(result.messages, /建立結果不明/); passed.push('建立結果不明時阻止再次建立');
    result = await execute(['--id', 'ibusuki-002', '--attach-url', 'https://creator.line.me/my/123/sticker/4567890']);
    assert.equal(result.code, 0); assert.equal(result.browserCalls, 0); assert.equal(core.readJSON(stateFile).items['ibusuki-002'].productId, '4567890'); passed.push('補綁既有商品只改進度、不啟動瀏覽器');
    fs.writeFileSync(lockFile, 'existing lock'); result = await execute(['--resume']);
    assert.equal(result.code, 1); assert.equal(fs.readFileSync(lockFile, 'utf8'), 'existing lock'); fs.unlinkSync(lockFile); passed.push('拒絕同時執行且保留其他執行的鎖');
    const bad = structuredClone(config); const second = structuredClone(bad.items[0]); second.id = 'second'; second.zip = 'missing.zip'; bad.items.push(second);
    core.writeJSON(configFile, bad); result = await execute(['--resume']);
    assert.equal(result.code, 1); assert.equal(result.browserCalls, 0); assert.match(result.messages, /ENOENT/); passed.push('整批預檢失敗時不開始任何網站操作');
    const clearConfig = { ...structuredClone(config), scanDir: 'custom source', customSetting: { keep: true },
      items: [...config.items, { id: 'disabled', enabled: false }, { id: 'incomplete' }] };
    core.writeJSON(configFile, clearConfig);
    const authFile = path.join(folder, 'line-auth.json'), summaryFile = path.join(folder, 'results', 'summary.json');
    core.writeJSON(authFile, { test: '登入狀態' }); core.writeJSON(summaryFile, [{ id: 'ibusuki-002', stage: 'draft_ready' }]);
    const preserved = [stateFile, summaryFile, authFile, archive].map(file => [file, fs.readFileSync(file)]);
    result = await execute(['--clear-items']);
    assert.equal(result.code, 0, result.messages); assert.equal(result.browserCalls, 0);
    assert.match(result.messages, /已清除 3 組/);
    assert.deepEqual(core.readJSON(configFile), { ...clearConfig, items: [] });
    for (const [file, before] of preserved) assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(lockFile), false); passed.push('清空所有組別並保留共用設定、進度、登入與素材，不啟動瀏覽器');
    const emptyBefore = fs.readFileSync(configFile);
    result = await execute(['--clear-items']);
    assert.equal(result.code, 0, result.messages); assert.match(result.messages, /已清除 0 組/);
    assert.deepEqual(fs.readFileSync(configFile), emptyBefore); passed.push('空清單可重複清除');
    const withoutItems = { ...clearConfig }; delete withoutItems.items;
    core.writeJSON(configFile, withoutItems); result = await execute(['--clear-items']);
    assert.equal(result.code, 0, result.messages);
    assert.deepEqual(core.readJSON(configFile), { ...withoutItems, items: [] }); passed.push('省略 items 時建立空陣列並保留設定');
    for (const invalid of [{ ...config, items: {} }, { ...config, items: null }, null, [], 'invalid', 42]) {
      core.writeJSON(configFile, invalid); const before = fs.readFileSync(configFile);
      result = await execute(['--clear-items']);
      assert.equal(result.code, 1); assert.equal(result.browserCalls, 0);
      assert.match(result.messages, /items 必須是陣列|清單最外層必須是物件/);
      assert.deepEqual(fs.readFileSync(configFile), before); assert.equal(fs.existsSync(lockFile), false);
    }
    passed.push('無效清單結構不會被清除指令覆寫，且會釋放鎖');
    fs.writeFileSync(configFile, '{ invalid JSON');
    result = await execute(['--clear-items']);
    assert.equal(result.code, 1); assert.equal(fs.readFileSync(configFile, 'utf8'), '{ invalid JSON');
    assert.equal(fs.existsSync(lockFile), false); passed.push('JSON 解析失敗時保留原檔並釋放鎖');
    core.writeJSON(configFile, clearConfig);
    const beforeClear = fs.readFileSync(configFile);
    fs.writeFileSync(lockFile, 'another process'); result = await execute(['--clear-items']);
    assert.equal(result.code, 1); assert.match(result.messages, /run.lock/);
    assert.deepEqual(fs.readFileSync(configFile), beforeClear); assert.equal(fs.readFileSync(lockFile, 'utf8'), 'another process');
    fs.unlinkSync(lockFile); passed.push('清除遇到執行鎖時保留清單與其他程序的鎖');
    for (const args of [['--scan'], ['--check'], ['--login'], ['--resume'], ['--auto'], ['--id', 'ibusuki-002'],
      ['--zip', 'override.zip'], ['--attach-url', 'https://creator.line.me/my/123/sticker/4567890'], ['--scan-dir', 'sticker']]) {
      result = await execute(['--clear-items', ...args]);
      assert.equal(result.code, 1); assert.equal(result.browserCalls, 0); assert.match(result.messages, /--clear-items.*分開使用/);
      assert.deepEqual(fs.readFileSync(configFile), beforeClear); assert.equal(fs.existsSync(lockFile), false);
    }
    passed.push('清除指令拒絕與其他操作參數混用');
    const otherFile = path.join(folder, 'other settings', 'custom items.json');
    core.writeJSON(otherFile, clearConfig);
    const child = spawnSync(process.execPath, [scriptPath, '--clear-items', '--items', path.relative(folder, otherFile)], { cwd: folder, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /已清除 3 組/);
    assert.deepEqual(core.readJSON(otherFile), { ...clearConfig, items: [] });
    assert.deepEqual(fs.readFileSync(configFile), beforeClear);
    assert.equal(fs.existsSync(path.join(path.dirname(otherFile), 'results', 'run.lock')), false);
    passed.push('可從其他工作目錄清除指定的相對路徑清單，支援空白路徑');
    result = await execute(['--clear-items', '--help']);
    assert.equal(result.code, 0, result.messages); assert.match(result.messages, /--clear-items/);
    assert.deepEqual(fs.readFileSync(configFile), beforeClear); passed.push('說明列出清除指令，查看說明不改寫清單');
    return { passed: passed.length, tests: passed };
  } finally {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + 'line-sticker-cli-'));
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
module.exports = { runCLITests };
if (require.main === module) runCLITests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
