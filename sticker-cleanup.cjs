'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseTraditionalTitle } = require('./scan.cjs');

function requireDirectory(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('必須是一般資料夾，不可為符號連結：' + folder);
}
function fileHash(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('必須是一般檔案，不可為符號連結：' + file);
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function entriesIn(folder) {
  requireDirectory(folder);
  return fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }) || a.name.localeCompare(b.name, 'en'));
}
function filesIn(folder, relative = '') {
  const files = [];
  for (const entry of entriesIn(path.join(folder, relative))) {
    const relativePath = path.join(relative, entry.name), file = path.join(folder, relativePath);
    if (entry.isSymbolicLink()) throw new Error('素材不可包含符號連結：' + file);
    if (entry.isDirectory()) files.push(...filesIn(folder, relativePath));
    else if (entry.isFile()) files.push({ relativePath, hash: fileHash(file) });
    else throw new Error('素材包含不支援的檔案類型：' + file);
  }
  return files;
}
function inventoryAt(sourceDir) {
  const groups = [];
  for (const entry of entriesIn(sourceDir)) {
    if (entry.isSymbolicLink()) throw new Error('素材不可包含符號連結：' + path.join(sourceDir, entry.name));
    if (entry.isDirectory()) groups.push({ name: entry.name, files: filesIn(path.join(sourceDir, entry.name)) });
  }
  return groups;
}
function groupTitle(folder, files) {
  const titles = new Set();
  for (const file of files.filter(file => path.extname(file.relativePath).toLowerCase() === '.txt')) {
    const source = path.join(folder, file.relativePath), text = fs.readFileSync(source, 'utf8');
    // 其他 TXT 可能是筆記，只採用可辨識繁中貼圖名稱的文案。
    try { titles.add(parseTraditionalTitle(text, source)); } catch {}
  }
  if (!titles.size) throw new Error(folder + '：找不到可辨識繁體中文貼圖名稱的 .txt 文案檔');
  if (titles.size > 1) throw new Error(folder + '：文案包含多個不同的繁體中文貼圖名稱，無法判定備份名稱');
  return [...titles][0];
}
function reserveBackupFolder(backupDir, name) {
  for (let number = 1; ; number++) {
    const folder = path.join(backupDir, name + (number === 1 ? '' : '-' + number));
    try { fs.mkdirSync(folder); return folder; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function backupAndClearStickers(projectDir, { now = new Date() } = {}) {
  projectDir = path.resolve(projectDir);
  const sourceDir = path.join(projectDir, 'sticker'), backupDir = path.join(projectDir, 'sticker-backups');
  const resultsDir = path.join(projectDir, 'results'), lockFile = path.join(resultsDir, 'run.lock');
  if (!Number.isFinite(now.getTime())) throw new Error('備份日期無效');
  const date = String(now.getFullYear()).padStart(4, '0') + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  fs.mkdirSync(resultsDir, { recursive: true });
  requireDirectory(resultsDir);
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有 run.lock。請先結束使用這個專案的工具，再備份並清空 sticker 素材。');
    throw error;
  }
  let deleting = false, groups = [];
  try {
    const inventory = inventoryAt(sourceDir);
    groups = inventory.filter(group => group.files.length).map(group => ({ ...group, title: groupTitle(path.join(sourceDir, group.name), group.files) }));
    const fileCount = groups.reduce((sum, group) => sum + group.files.length, 0);
    if (!fileCount) return { sourceDir, backupDir, groups, fileCount };
    fs.mkdirSync(backupDir, { recursive: true });
    requireDirectory(backupDir);
    for (const group of groups) {
      const safeTitle = group.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, value => '_'.repeat(value.length));
      group.backupDir = reserveBackupFolder(backupDir, date + '-' + safeTitle);
      for (const file of group.files) {
        const target = path.join(group.backupDir, file.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(sourceDir, group.name, file.relativePath), target, fs.constants.COPYFILE_EXCL);
      }
    }
    // 整批備份完成後，逐檔核對備份內容，再確認來源沒有新增、移動或變更。
    for (const group of groups) {
      for (const file of group.files) {
        if (fileHash(path.join(group.backupDir, file.relativePath)) !== file.hash) throw new Error('備份內容核對失敗：' + path.join(group.backupDir, file.relativePath));
      }
    }
    if (JSON.stringify(inventoryAt(sourceDir)) !== JSON.stringify(inventory)) throw new Error('備份期間來源素材有變更，請重新執行');
    deleting = true;
    for (const group of groups) {
      for (const file of group.files) {
        const source = path.join(sourceDir, group.name, file.relativePath);
        if (fileHash(source) !== file.hash) throw new Error('來源內容已變更，已保留此檔案：' + source);
        fs.unlinkSync(source);
      }
    }
    return { sourceDir, backupDir, groups, fileCount };
  } catch (error) {
    const message = deleting ? '備份已完成，但來源刪除失敗' : '備份未完成或核對失敗，尚未刪除來源檔案';
    throw new Error(message + '：' + error.message + (groups.some(group => group.backupDir) ? '\n備份目錄：' + backupDir : ''));
  } finally {
    fs.unlinkSync(lockFile);
  }
}

module.exports = { backupAndClearStickers };
