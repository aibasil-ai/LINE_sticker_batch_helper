'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { readJSON, writeJSON, clearItems, textUnits, parseArgs, productFromURL, loadConfig, inspectZip, fingerprint } = require('./core.cjs');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node run.cjs [--check|--login|--resume] [--auto] [--items items.json] [--id ID] [--zip PATH] [--attach-url URL]\nnode run.cjs --scan [--scan-dir sticker] [--items items.json]\nnode run.cjs --clear-items [--items items.json]'); return;
  }
  const configFile = path.resolve(opts.items || path.join(__dirname, 'items.json'));
  if (opts['clear-items']) {
    const result = clearItems(configFile);
    console.log(`已清除 ${result.cleared} 組：${result.configFile}（items 已設為空陣列）。`);
    return;
  }
  if (opts.scan) {
    const { generateItems } = require('./scan.cjs');
    const result = generateItems(configFile, opts['scan-dir']);
    console.log('掃描資料夾：' + result.scanDir);
    for (const item of result.scanned) console.log(`[${item.id}] ${item.existing ? '更新' : '新增'}：${item.zip}（${item.stickerCount} 張）`);
    console.log(`已產生 ${result.configFile}：掃描 ${result.scanned.length} 組，清單共 ${result.total} 組。尚未連線 LINE。`);
    return;
  }
  const config = loadConfig(configFile, opts);
  const resultsDir = path.join(config.configDir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const stateFile = path.join(resultsDir, 'progress.json');
  const lockFile = path.join(resultsDir, 'run.lock');
  let rl;
  const configMode = config.verification.mode;
  const ask = text => {
    if (configMode === 'auto' && !opts.login) throw new Error('自動模式遇到登入或人工確認要求，請先執行 node run.cjs --login 再續跑');
    if (!process.stdin.isTTY) throw new Error('需要互動終端機；請直接在終端機執行');
    rl ||= readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(text);
  };
  let browser, context, lockOwned = false;
  let state;
  let active;
  try {
    if (opts.check && opts.login) throw new Error('--check 與 --login 不可同時使用');
    if (!opts.check) {
      try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' }); lockOwned = true; }
      catch (error) { if (error.code === 'EEXIST') throw new Error('已有 run.lock。先確認沒有另一個工具正在執行；若上次異常關閉，可手動移除 results/run.lock 後續跑。'); throw error; }
    }
    state = fs.existsSync(stateFile) ? readJSON(stateFile) : { version: 1, items: {} };
    if (state.version !== 1 || !state.items) throw new Error('進度檔格式不符');
    const save = () => writeJSON(stateFile, state);
    if (opts.login) {
      const { chromium } = require('@playwright/test');
      browser = await chromium.launch({ headless: false });
      context = await browser.newContext({ locale: 'zh-TW' });
      const page = await context.newPage();
      await page.goto('https://creator.line.me/zh-hant/');
      await ask('請點個人頁面並完成登入，確認看見創作者管理後台後，回到終端機按 Enter 儲存：');
      if (new URL(page.url()).hostname !== 'creator.line.me' || !/\/my(?:\/|$)/.test(new URL(page.url()).pathname)) throw new Error('尚未辨識到創作者管理後台，未儲存登入狀態');
      await context.storageState({ path: config.authPath, indexedDB: true });
      console.log('已儲存本機登入狀態：' + config.authPath); return;
    }
    console.log('ZIP 相對路徑基準：' + config.baseDir);
    for (const item of config.items) {
      if (!item.useAI || !item.autoStartSale) throw new Error(item.id + '：本版依錄製使用 useAI=true、autoStartSale=true，其他選項需核對頁面');
      const zip = inspectZip(item.zipAbsolutePath, item.stickerCount);
      item.fingerprint = fingerprint(item, zip.hash);
      item.expectedImages = zip.images;
      console.log(`\n[${item.id}] ${item.zipAbsolutePath}\n  ZIP=${zip.bytes} bytes，PNG=${zip.imageCount}，priceTier=${item.priceTier}，使用AI=${item.useAI}，審核通過後自動販售=${item.autoStartSale}`);
      for (const lang of ['zh-Hant', 'en', 'ja']) console.log(`  ${lang}: ${item.languages[lang].title}（預估 ${textUnits(item.languages[lang].title)}/40；說明 ${textUnits(item.languages[lang].description)}/160）`);
      const existing = state.items[item.id];
      if (existing && existing.fingerprint !== item.fingerprint) throw new Error(item.id + ' 文案、圖片或設定與進度紀錄不同。請核對既有商品；全新商品請使用新 id。');
    }
    if (opts.check) { console.log('\n資料檢查通過。尚未連線 LINE；不含透明像素、PNG CRC、權利或網站端審核驗證。'); return; }
    if (opts['attach-url']) {
      const product = productFromURL(opts['attach-url']);
      if (!product) throw new Error('請提供 creator.line.me 管理後台包含 /sticker/數字 的完整商品網址');
      const item = config.items[0];
      const row = state.items[item.id];
      if (!row || !['creating', 'metadata_saved'].includes(row.stage)) throw new Error('只能為建立中或已存文案的既有進度補綁網址');
      row.productId = product.id; row.productURL = product.url; row.stage = 'metadata_saved'; row.error = null; save();
      console.log('已綁定既有商品；本次未操作網頁。請先核對該商品文案，再使用 --resume。'); return;
    }
    const report = () => writeJSON(path.join(resultsDir, 'summary.json'), Object.entries(state.items).map(([id, r]) => ({ id, stage: r.stage, productId: r.productId || null, productURL: r.productURL || null, error: r.error || null })));
    let failed = 0;
    const blocked = new Set();
    // Check every selected checkpoint before opening the browser or creating any item.
    for (const item of config.items) {
      const row = state.items[item.id];
      if (row && !opts.resume) throw new Error(item.id + ' 已有進度；請使用 --resume 避免重複新增');
      if (row?.stage === 'creating' && !row.productURL) {
        const message = item.id + ' 上次建立結果不明；請先在後台找商品，以 --id ' + item.id + ' --attach-url "商品管理網址" 補綁，不要刪除進度。';
        if (!config.continueOnError) throw new Error(message);
        row.error = message; row.failedAt = new Date().toISOString(); save();
        console.error('略過：' + message); blocked.add(item.id); failed++;
      }
    }
    const pending = config.items.filter(item => !blocked.has(item.id) && state.items[item.id]?.stage !== 'draft_ready');
    if (!pending.length) { report(); if (failed) { console.log('沒有可繼續的項目；請處理 results/summary.json 中的錯誤。'); process.exitCode = 1; } else console.log('所選項目均已完成草稿；沒有新增或送審。'); return; }
    if (!fs.existsSync(config.authPath)) throw new Error('找不到登入檔。請先執行 npm run login，或放入你已建立的 line-auth.json');
    const { chromium } = require('@playwright/test');
    const site = require('./line-site.cjs');
    browser = await chromium.launch({ headless: false, slowMo: 120 });
    context = await browser.newContext({ storageState: config.authPath, locale: 'zh-TW' });
    context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(45000);
    const page = await context.newPage();
    for (const item of pending) {
      active = item;
      let row = state.items[item.id];
      if (!row) { row = state.items[item.id] = { fingerprint: item.fingerprint, stage: 'new', zipPath: item.zipAbsolutePath, createdAt: new Date().toISOString() }; save(); }
      row.zipPath = item.zipAbsolutePath;
      row.error = null;
      console.log('\n開始處理：' + item.id);
      try {
        if (row.stage === 'creating' && !row.productURL) throw new Error('上次建立結果不明；請使用 --id ' + item.id + ' --attach-url \"商品管理網址\" 補綁，禁止重複建立');
        if (row.stage === 'new') await site.createDraft(page, item, row, save, ask);
        if (row.stage === 'creating' && row.productURL) { row.stage = 'metadata_saved'; save(); }
        if (['metadata_saved', 'upload_pending'].includes(row.stage)) await site.uploadImages(page, config, item, row, save, ask);
        if (row.stage === 'images_verified') {
          await site.setPrice(page, item, row);
          row.stage = 'draft_ready'; row.completedAt = new Date().toISOString(); save();
        }
        if (row.stage !== 'draft_ready') throw new Error('未知進度階段：' + row.stage);
        console.log('草稿完成：' + row.productURL);
      } catch (error) {
        row.error = error.message; row.failedAt = new Date().toISOString(); row.lastURL = page.url(); save();
        failed++; console.error('本組未完成：' + item.id + '：' + error.message);
        report();
        const url = new URL(page.url());
        const loginRequired = /登入|login|auth/i.test(error.message) || url.hostname !== 'creator.line.me' || /\/login(?:\/|$)/.test(url.pathname);
        if (!config.continueOnError || loginRequired || page.isClosed()) throw error;
      }
      report(); active = null;
    }
    if (failed) { console.log('本次有 ' + failed + ' 組未完成，請查看 results/summary.json；修正後以 --resume --auto 續跑。'); process.exitCode = 1; }
    console.log('\n批次草稿處理完成。程式沒有提出審核或開始販售。');
  } catch (error) {
    if (active && state?.items?.[active.id]) {
      const row = state.items[active.id];
      row.error = error.message; row.failedAt = new Date().toISOString();
      if (context?.pages().length) row.lastURL = context.pages()[0].url();
      writeJSON(stateFile, state);
    }
    throw error;
  } finally {
    if (rl) rl.close();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (lockOwned) fs.unlinkSync(lockFile);
  }
}
main().catch(error => { console.error('\n停止：' + error.message); process.exitCode = 1; });
