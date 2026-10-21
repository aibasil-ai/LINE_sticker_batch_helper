'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('../core.cjs');

function runClearAllTests() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'line-sticker-clear-all-'));
  const passed = [];
  const check = (name, fn) => {
    const project = fs.mkdtempSync(path.join(temp, 'case-'));
    for (const file of ['package.json', 'run.cjs', 'core.cjs', 'scan.cjs', 'sticker-cleanup.cjs']) {
      fs.copyFileSync(path.join(__dirname, '..', file), path.join(project, file));
    }
    const sourceDir = path.join(project, 'sticker', '001');
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(project, 'sticker', '002'));
    const copyFile = path.join(sourceDir, 'listing-copy.txt'), zipFile = path.join(sourceDir, 'upload.zip');
    fs.writeFileSync(copyFile, '【繁體中文】\n貼圖名稱：整合清理貼圖\n商品說明：測試文案。\n', 'utf8');
    fs.writeFileSync(zipFile, Buffer.from([0, 255, 1, 13, 10]));
    const configFile = path.join(project, 'items.json'), authFile = path.join(project, 'line-auth.json');
    const stateFile = path.join(project, 'results', 'progress.json'), summaryFile = path.join(project, 'results', 'summary.json');
    const config = { baseDir: '.', defaults: { copyright: '測試設定' }, verification: { mode: 'manual' }, items: [{ id: '001' }] };
    core.writeJSON(configFile, config); core.writeJSON(authFile, { test: '登入狀態' });
    core.writeJSON(stateFile, { version: 1, items: { '001': { stage: 'draft_ready' } } });
    core.writeJSON(summaryFile, [{ id: '001', stage: 'draft_ready' }]);
    const run = () => spawnSync('npm run clear-all', { cwd: project, shell: true, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_update_notifier: 'false' } });
    fn({ project, sourceDir, copyFile, zipFile, configFile, config, authFile, stateFile, summaryFile, run });
    passed.push(name);
  };
  const snapshot = files => files.map(file => [file, fs.readFileSync(file)]);
  const unchanged = files => { for (const [file, content] of files) assert.deepEqual(fs.readFileSync(file), content); };
  const verifyBackup = (project, files) => {
    const backupRoot = path.join(project, 'sticker-backups'), names = fs.readdirSync(backupRoot);
    assert.equal(names.length, 1); assert.match(names[0], /^\d{8}-整合清理貼圖$/);
    for (const [source, content] of files) assert.deepEqual(fs.readFileSync(path.join(backupRoot, names[0], path.basename(source))), content);
  };
  try {
    check('整合指令依序備份清除素材、清空清單及結果，保留備份與資料夾', ({ project, sourceDir, copyFile, zipFile, configFile, config, authFile, run }) => {
      const source = snapshot([copyFile, zipFile]), auth = snapshot([authFile]);
      const result = run();
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const sticker = result.stdout.indexOf('已備份並清除'), items = result.stdout.indexOf('items 已設為空陣列');
      const results = result.stdout.indexOf('已保留 results 資料夾');
      assert.ok(sticker >= 0 && items > sticker && results > items, result.stdout);
      verifyBackup(project, source); unchanged(auth);
      assert.deepEqual(core.readJSON(configFile), { ...config, items: [] });
      assert.deepEqual(fs.readdirSync(path.join(project, 'results')), []);
      assert.deepEqual(fs.readdirSync(sourceDir), ['nested']);
      assert.deepEqual(fs.readdirSync(path.join(sourceDir, 'nested')), []);
      assert.deepEqual(fs.readdirSync(path.join(project, 'sticker', '002')), []);
    });
    check('素材文案無法辨識時停止，保留來源、清單與全部進度', ({ project, copyFile, zipFile, configFile, authFile, stateFile, summaryFile, run }) => {
      fs.writeFileSync(copyFile, 'English\nTitle: No Chinese name');
      const before = snapshot([copyFile, zipFile, configFile, authFile, stateFile, summaryFile]);
      const result = run();
      assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /繁體中文貼圖名稱/); unchanged(before);
      assert.doesNotMatch(result.stdout, /items 已設為空陣列|已保留 results 資料夾/);
      assert.equal(fs.existsSync(path.join(project, 'sticker-backups')), false);
      assert.equal(fs.existsSync(path.join(project, 'results', 'run.lock')), false);
    });
    check('遇到既有執行鎖時停止，保留來源、清單、結果與其他程序的鎖', ({ project, copyFile, zipFile, configFile, stateFile, summaryFile, run }) => {
      const lockFile = path.join(project, 'results', 'run.lock'); fs.writeFileSync(lockFile, 'another process');
      const before = snapshot([copyFile, zipFile, configFile, stateFile, summaryFile, lockFile]);
      const result = run();
      assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /run.lock/); unchanged(before);
      assert.equal(fs.existsSync(path.join(project, 'sticker-backups')), false);
    });
    check('清空清單失敗時保留已完成的備份，並停止清空結果與進度', ({ project, sourceDir, copyFile, zipFile, configFile, stateFile, summaryFile, run }) => {
      fs.writeFileSync(configFile, '{ invalid JSON');
      const source = snapshot([copyFile, zipFile]), before = snapshot([configFile, stateFile, summaryFile]);
      const result = run();
      assert.equal(result.status, 1, result.stderr); assert.match(result.stdout, /已備份並清除/);
      assert.doesNotMatch(result.stdout, /已保留 results 資料夾/);
      verifyBackup(project, source); unchanged(before);
      assert.deepEqual(fs.readdirSync(sourceDir), ['nested']);
      assert.equal(fs.existsSync(path.join(project, 'results', 'run.lock')), false);
    });
    return { passed: passed.length, tests: passed };
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'line-sticker-clear-all-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { runClearAllTests };
if (require.main === module) console.log(JSON.stringify(runClearAllTests(), null, 2));
