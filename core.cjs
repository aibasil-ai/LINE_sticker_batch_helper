'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}
function clearItems(configFile) {
  configFile = path.resolve(configFile);
  const resultsDir = path.join(path.dirname(configFile), 'results');
  const lockFile = path.join(resultsDir, 'run.lock');
  fs.mkdirSync(resultsDir, { recursive: true });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有 run.lock。請先結束使用這份清單的工具，再清空清單。');
    throw error;
  }
  try {
    const config = readJSON(configFile);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('清單最外層必須是物件');
    if (config.items !== undefined && !Array.isArray(config.items)) throw new Error('items 必須是陣列');
    const cleared = config.items?.length ?? 0;
    writeJSON(configFile, { ...config, items: [] });
    return { configFile, cleared };
  } finally {
    fs.unlinkSync(lockFile);
  }
}
function clearResults(configFile) {
  const resultsDir = path.join(path.dirname(path.resolve(configFile)), 'results');
  const lockFile = path.join(resultsDir, 'run.lock');
  fs.mkdirSync(resultsDir, { recursive: true });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有 run.lock。請先結束使用這份清單的工具，再清空 results 資料夾。');
    throw error;
  }
  try {
    const entries = fs.readdirSync(resultsDir).filter(name => name !== 'run.lock');
    for (const name of entries) fs.rmSync(path.join(resultsDir, name), { recursive: true, force: true });
    return { resultsDir, cleared: entries.length };
  } finally {
    fs.unlinkSync(lockFile);
  }
}
// Conservative LINE-style estimate. The website's own counter remains authoritative.
function textUnits(value) {
  return Array.from(value).reduce((sum, c) => sum + (c.codePointAt(0) <= 0x7e ? 1 : 2), 0);
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function parseArgs(args) {
  const opts = {};
  const switches = new Set(['--check', '--login', '--resume', '--help', '--auto', '--scan', '--clear-items', '--clear-results', '--clear-sticker']);
  const values = new Set(['--id', '--zip', '--items', '--attach-url', '--scan-dir']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (switches.has(key)) opts[key.slice(2)] = true;
    else if (values.has(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(key + ' 缺少參數');
      opts[key.slice(2)] = args[++i];
    } else throw new Error('未知參數：' + key);
  }
  if (opts['clear-sticker'] && Object.keys(opts).some(key => !['clear-sticker', 'help'].includes(key))) {
    throw new Error('--clear-sticker 只備份並清空專案的 sticker 子資料夾，請與其他操作參數分開使用');
  }
  if (opts['clear-items'] && Object.keys(opts).some(key => !['clear-items', 'items', 'help'].includes(key))) {
    throw new Error('--clear-items 只清空清單，請與其他操作參數分開使用（可搭配 --items）');
  }
  if (opts['clear-results'] && Object.keys(opts).some(key => !['clear-results', 'items', 'help'].includes(key))) {
    throw new Error('--clear-results 只清空 results 資料夾，請與其他操作參數分開使用（可搭配 --items）');
  }
  if (opts.zip && !opts.id) throw new Error('--zip 必須搭配 --id，避免覆蓋到多組');
  if (opts['attach-url'] && !opts.id) throw new Error('--attach-url 必須搭配 --id');
  if (opts['scan-dir'] && !opts.scan) throw new Error('--scan-dir 必須搭配 --scan');
  if (opts.scan && ['check', 'login', 'resume', 'id', 'zip', 'attach-url'].some(key => opts[key])) {
    throw new Error('--scan 只產生清單，請與預檢、登入、執行及單組操作分開使用');
  }
  return opts;
}
function productFromURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'creator.line.me') return null;
  const match = url.pathname.match(/\/sticker\/(\d+)(?:\/|$)/);
  return match ? { id: match[1], url: url.href } : null;
}
function loadConfig(file, opts = {}) {
  return validateConfig(readJSON(file), file, opts);
}
function validateConfig(config, file, opts = {}) {
  if (!Array.isArray(config.items) || !config.items.length) throw new Error('items 必須是非空陣列');
  const configDir = path.dirname(path.resolve(file));
  const baseDir = path.resolve(configDir, config.baseDir || '.');
  const seen = new Set();
  for (const item of config.items) {
    if (!item.id || typeof item.id !== 'string') throw new Error('每組需要字串 id');
    if (seen.has(item.id)) throw new Error('重複 id：' + item.id);
    seen.add(item.id);
  }
  const items = config.items.filter(i => i.enabled !== false && (!opts.id || i.id === opts.id))
    .map(i => ({ ...config.defaults, ...i }));
  if (!items.length) throw new Error('沒有符合條件且啟用的貼圖組');
  for (const item of items) {
    const zip = opts.zip || item.zip;
    if (typeof zip !== 'string' || !zip.trim()) throw new Error(item.id + ' 缺少 zip 路徑');
    if (path.extname(zip).toLowerCase() !== '.zip') throw new Error(item.id + ' 必須指定 .zip');
    item.zipAbsolutePath = path.resolve(baseDir, zip);
    if (![8, 16, 24, 32, 40].includes(item.stickerCount)) throw new Error(item.id + ' 張數錯誤');
    if (typeof item.useAI !== 'boolean' || typeof item.autoStartSale !== 'boolean') {
      throw new Error(item.id + ' 必須指定 useAI 與 autoStartSale 布林值');
    }
    if (typeof item.priceTier !== 'string' || !/^\d+$/.test(item.priceTier)) throw new Error(item.id + ' priceTier 須為後台選項值字串');
    if (!item.copyright || textUnits(item.copyright) > 50) throw new Error(item.id + ' Copyright 缺漏或過長');
    for (const lang of ['en', 'zh-Hant', 'ja']) {
      const copy = item.languages?.[lang];
      if (!copy || typeof copy.title !== 'string' || typeof copy.description !== 'string') throw new Error(item.id + ' 缺少 ' + lang + ' 文案');
      copy.title = copy.title.trim(); copy.description = copy.description.trim();
      if (!copy.title || !copy.description || /[\r\n]/.test(copy.title)) throw new Error(item.id + ' ' + lang + ' 文案為空或標題有換行');
      if (textUnits(copy.title) > 40 || textUnits(copy.description) > 160) throw new Error(item.id + ' ' + lang + ' 文案超過預估上限');
    }
  }
  const verification = { mode: 'auto', timeoutMs: 180000, ...config.verification, ...(opts.auto ? { mode: 'auto' } : {}) };
  if (!['auto', 'manual', 'selector'].includes(verification.mode)) throw new Error('verification.mode 須為 auto、manual 或 selector');
  if (verification.mode === 'selector' && !verification.readySelector?.trim()) throw new Error('自動判斷需要 readySelector，請用實際頁面確認');
  if (!Number.isFinite(verification.timeoutMs) || verification.timeoutMs < 1000) throw new Error('timeoutMs 須至少 1000');
  if (config.continueOnError !== undefined && typeof config.continueOnError !== 'boolean') throw new Error('continueOnError 須為布林值');
  return { ...config, continueOnError: config.continueOnError !== false, items, configDir, baseDir, verification, authPath: path.resolve(configDir, config.authFile || 'line-auth.json') };
}

function inspectZip(file, amount) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 60 * 1024 * 1024) throw new Error('ZIP 不是檔案或超過 60 MiB：' + file);
  const data = fs.readFileSync(file);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 結構錯誤');
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff || data.readUInt16LE(eocd + 4) || data.readUInt16LE(eocd + 6)) throw new Error('不支援 ZIP64 或分片 ZIP');
  const expectedNames = count => new Set(['main.png', 'tab.png', ...Array.from({ length: count }, (_, i) => String(i + 1).padStart(2, '0') + '.png')]);
  let expected = expectedNames(amount ?? 40);
  const found = new Set();
  const images = {};
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 0; i < count; i++) {
    if (offset + 46 > eocd || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目錄錯誤');
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20), uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (!expected.has(name) || found.has(name)) throw new Error('ZIP 檔名需在根目錄且不可重複：' + name);
    found.add(name);
    if (flags & 1 || ![0, 8].includes(method)) throw new Error('ZIP 不可加密，需使用標準壓縮');
    if (uncompressedSize > 1024 * 1024) throw new Error(name + ' 超過 1 MiB');
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地檔頭錯誤');
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    if (start + compressedSize > data.length) throw new Error('ZIP 檔案遭截斷');
    const raw = data.subarray(start, start + compressedSize);
    const png = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: 1024 * 1024 });
    if (png.length !== uncompressedSize || png.length < 33 || !png.subarray(0, 8).equals(pngSignature) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error(name + ' 不是有效 PNG 檔頭');
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (!w || !h || w % 2 || h % 2) throw new Error(name + ' 尺寸須為正偶數');
    if (name === 'main.png' ? w !== 240 || h !== 240 : name === 'tab.png' ? w !== 96 || h !== 74 : w > 370 || h > 320) throw new Error(name + ' 尺寸不符');
    images[name.slice(0, -4)] = { sha1: crypto.createHash('sha1').update(png).digest('hex'), width: w, height: h };
  }
  if (amount === undefined) {
    amount = found.size - 2;
    if (![8, 16, 24, 32, 40].includes(amount)) throw new Error('ZIP 貼圖張數須為 8、16、24、32 或 40（不含主圖與標籤）');
    expected = expectedNames(amount);
  }
  const missing = [...expected].filter(n => !found.has(n));
  if (missing.length) throw new Error('ZIP 缺少：' + missing.join(', '));
  return { hash: sha256(data), imageCount: found.size, stickerCount: amount, bytes: stat.size, images };
}
function fingerprint(item, zipHash) {
  return sha256(JSON.stringify({ zipHash, languages: item.languages, copyright: item.copyright,
    stickerCount: item.stickerCount, useAI: item.useAI, autoStartSale: item.autoStartSale, priceTier: item.priceTier }));
}
module.exports = { readJSON, writeJSON, clearItems, clearResults, textUnits, parseArgs, productFromURL, loadConfig, validateConfig, inspectZip, fingerprint };
