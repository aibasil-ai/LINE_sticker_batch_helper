'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
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
  const config = core.readJSON(path.join(__dirname, '..', 'items.json'));
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
    return { passed: passed.length, tests: passed };
  } finally {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep + 'line-sticker-cli-'));
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
module.exports = { runCLITests };
if (require.main === module) runCLITests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
