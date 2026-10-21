'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readJSON, writeJSON, textUnits, validateConfig, inspectZip } = require('./core.cjs');

const LANGUAGE_NAMES = new Map([
  ['繁體中文', 'zh-Hant'], ['zh-hant', 'zh-Hant'], ['traditional chinese', 'zh-Hant'],
  ['english', 'en'], ['英文', 'en'], ['en', 'en'],
  ['日本語', 'ja'], ['日文', 'ja'], ['ja', 'ja']
]);
const TITLE_PATTERN = /^(?:名稱|貼圖名稱|標題|Title)(?:\s*\/\s*Title)?\s*[:：]\s*(.*)$/i;

function listingLanguage(line) {
  const heading = line.replace(/^(?:【(.*)】|\[(.*)\])$/, (_, full, square) => full ?? square).trim().toLowerCase();
  return LANGUAGE_NAMES.get(heading);
}

function parseTraditionalTitle(text, source = '文案檔') {
  let language, title, chineseSections = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    const trimmed = line.trim(), nextLanguage = listingLanguage(trimmed);
    if (nextLanguage) {
      language = nextLanguage;
      if (language === 'zh-Hant' && ++chineseSections > 1) throw new Error(source + '：重複繁體中文段落');
      continue;
    }
    if (language !== 'zh-Hant') continue;
    const match = trimmed.match(TITLE_PATTERN);
    if (!match) continue;
    if (title !== undefined) throw new Error(source + '：重複繁體中文貼圖名稱');
    title = match[1].trim();
  }
  if (!title) throw new Error(source + '：缺少繁體中文貼圖名稱');
  return title;
}

function parseListingCopy(text, source = '文案檔') {
  const copies = {}, fields = {};
  let language, field;
  const fail = message => { throw new Error(source + '：' + message); };
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const nextLanguage = listingLanguage(trimmed);
    if (nextLanguage) {
      if (copies[nextLanguage]) fail('重複語言段落：' + nextLanguage);
      language = nextLanguage; field = null;
      copies[language] = {}; fields[language] = new Set();
      continue;
    }
    // A listing may include a document title or counting rules before the first language.
    if (!language) continue;
    if (/^(?:名稱|貼圖名稱|標題|說明|商品說明)計數\s*[:：]/.test(trimmed)) { field = null; continue; }
    const title = trimmed.match(TITLE_PATTERN);
    const description = trimmed.match(/^(?:說明|商品說明|Description)(?:\s*\/\s*Description)?\s*[:：]\s*(.*)$/i);
    if (title || description) {
      field = title ? 'title' : 'description';
      if (fields[language].has(field)) fail(language + ' 重複欄位：' + field);
      fields[language].add(field);
      copies[language][field] = (title || description)[1].trim();
    } else if (field === 'description') {
      copies[language].description += '\n' + line.trimEnd();
    } else if (trimmed) {
      fail('第 ' + (index + 1) + ' 行無法辨識，請使用名稱／說明欄位與語言標題');
    }
  }
  const languages = {};
  for (const lang of ['zh-Hant', 'en', 'ja']) {
    const copy = copies[lang];
    if (!copy?.title?.trim() || !copy.description?.trim()) fail('缺少 ' + lang + ' 標題或說明');
    const title = copy.title.trim(), description = copy.description.trim();
    if (textUnits(title) > 40 || textUnits(description) > 160) fail(lang + ' 文案超過預估上限（標題 40、說明 160）');
    languages[lang] = { title, description };
  }
  return languages;
}

function generateItems(configFile, directory) {
  configFile = path.resolve(configFile);
  const configDir = path.dirname(configFile);
  const resultsDir = path.join(configDir, 'results');
  const lockFile = path.join(resultsDir, 'run.lock');
  fs.mkdirSync(resultsDir, { recursive: true });
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('已有 run.lock。請先結束使用這份清單的工具，再產生清單。');
    throw error;
  }
  try {
    const config = readJSON(configFile);
    if (config.items !== undefined && !Array.isArray(config.items)) throw new Error('items 必須是陣列');
    const baseDir = path.resolve(configDir, config.baseDir || '.');
    const scanDir = directory ?? config.scanDir ?? 'sticker';
    if (typeof scanDir !== 'string' || !scanDir.trim()) throw new Error('掃描資料夾路徑不可為空');
    const root = path.resolve(baseDir, scanDir);
    const folders = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX')
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }) || a.name.localeCompare(b.name, 'en'));
    const items = [...(config.items || [])];
    const ids = new Set();
    for (const item of items) {
      if (!item.id || typeof item.id !== 'string') throw new Error('每組需要字串 id');
      if (ids.has(item.id)) throw new Error('重複 id：' + item.id);
      ids.add(item.id);
    }
    const scanned = [], skippedEmpty = [];
    for (const folder of folders) {
      const folderPath = path.join(root, folder.name);
      const entries = fs.readdirSync(folderPath, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.'));
      if (!entries.length) { skippedEmpty.push(folder.name); continue; }
      const files = entries.filter(entry => entry.isFile());
      const findOne = extension => {
        const matches = files.filter(entry => path.extname(entry.name).toLowerCase() === extension);
        if (matches.length !== 1) throw new Error(folderPath + '：需要且只能有一個 ' + extension + ' 檔案，目前找到 ' + matches.length + ' 個');
        return path.join(folderPath, matches[0].name);
      };
      const zipPath = findOne('.zip'), copyPath = findOne('.txt');
      const languages = parseListingCopy(fs.readFileSync(copyPath, 'utf8'), copyPath);
      let archive;
      try { archive = inspectZip(zipPath); }
      catch (error) { throw new Error(zipPath + '：' + error.message); }
      const matches = items.map((item, index) => ({ item, index })).filter(({ item }) =>
        typeof item.zip === 'string' && path.dirname(path.resolve(baseDir, item.zip)) === folderPath);
      if (matches.length > 1) throw new Error(folderPath + '：多個既有項目指向同一資料夾，無法判定要保留的 ID');
      const previous = matches[0]?.item;
      const id = previous?.id || folder.name;
      if (!previous && ids.has(id)) throw new Error('自動 ID 已被其他組使用：' + id + '，請使用不重複的資料夾名稱');
      const mergedLanguages = { ...previous?.languages };
      for (const [lang, copy] of Object.entries(languages)) mergedLanguages[lang] = { ...previous?.languages?.[lang], ...copy };
      const item = { ...previous, id, enabled: previous?.enabled ?? true,
        zip: path.relative(baseDir, zipPath).split(path.sep).join('/'),
        stickerCount: archive.stickerCount, languages: mergedLanguages };
      if (previous) items[matches[0].index] = item;
      else { items.push(item); ids.add(id); }
      scanned.push({ id, zip: item.zip, copyPath, stickerCount: item.stickerCount, existing: !!previous });
    }
    const result = { configFile, scanDir: root, scanned, skippedEmpty, total: items.length };
    if (!scanned.length) return result;
    const generated = { ...config, items };
    // Validate disabled items too, without changing their stored enabled flags.
    validateConfig({ ...generated, items: items.map(item => ({ ...item, enabled: true })) }, configFile);
    writeJSON(configFile, generated);
    return result;
  } finally {
    fs.unlinkSync(lockFile);
  }
}

module.exports = { parseListingCopy, parseTraditionalTitle, generateItems };
