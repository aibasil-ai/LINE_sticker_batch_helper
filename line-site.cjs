'use strict';
// Locators below come from the supplied recorded.spec.js. No private LINE API is used.
const { expect } = require('@playwright/test');
const { productFromURL } = require('./core.cjs');
const { currentGallery, verifyGallery } = require('./image-verification.cjs');
const SITE = 'https://creator.line.me/zh-hant/';
const testId = (page, value) => page.locator(`[data-test="${value}"]`);

async function visible(locator, timeout = 1000) {
  return locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}
async function optionalOK(page) {
  const button = page.getByRole('button', { name: 'OK', exact: true });
  if (await visible(button, 1500)) await button.click();
}
async function dismissAnnouncements(page, options = {}) {
  const { firstWaitMs = 5000, nextWaitMs = 1500, trialTimeoutMs = 1200, actionTimeoutMs = 5000, maxDialogs = 30 } = options;
  const announcements = page.getByRole('dialog').filter({
    has: page.getByRole('button', { name: '關閉', exact: true })
  });
  let closedCount = 0;
  while (closedCount < maxDialogs) {
    // A route change or closing one notice can mount the next notice asynchronously.
    let appeared = true;
    try {
      await expect.poll(() => announcements.count(), {
        timeout: closedCount ? nextWaitMs : firstWaitMs, intervals: [100, 200, 400]
      }).toBeGreaterThan(0);
    } catch (error) {
      if (page.isClosed()) throw error;
      appeared = false;
    }
    if (!appeared) return closedCount;

    const candidates = await announcements.all();
    let active = null;
    // DOM order alone is insufficient: trial clicks also check overlays and stability.
    for (const dialog of candidates.reverse()) {
      const close = dialog.getByRole('button', { name: '關閉', exact: true });
      if (await close.count() !== 1 || !await dialog.isVisible()) continue;
      try {
        await close.click({ trial: true, timeout: trialTimeoutMs });
        active = { dialog, close }; break;
      } catch (_) { /* Another modal or animation may cover this candidate. */ }
    }
    if (!active) throw new Error('找到公告，但關閉按鈕被遮住或定位不唯一；請提供此處的新錄製／錯誤訊息。');

    const { dialog, close } = active;
    const checkbox = dialog.getByRole('checkbox', { name: '以後不再顯示此畫面', exact: true, includeHidden: true });
    if (await checkbox.count() > 1) throw new Error('同一公告內找到多個同名勾選方塊，停止以避免點錯。');
    if (await checkbox.count() === 1 && !await checkbox.isChecked()) {
      try {
        await checkbox.check({ timeout: trialTimeoutMs });
      } catch (_) {
        // Styled checkboxes may hide the native input; click its visible label instead.
        const label = dialog.locator('label').filter({ hasText: '以後不再顯示此畫面' });
        if (await label.count() === 1 && await label.isVisible()) await label.click({ timeout: actionTimeoutMs });
        else await dialog.getByText('以後不再顯示此畫面', { exact: true }).click({ timeout: actionTimeoutMs });
      }
      await expect(checkbox).toBeChecked({ timeout: actionTimeoutMs });
    }
    const handle = await dialog.elementHandle();
    if (!handle) throw new Error('公告在操作期間改變，請續跑。');
    const previousText = await dialog.innerText();
    await close.click({ timeout: actionTimeoutMs });
    // Works both when a dialog is removed and when LINE reuses the same container.
    await page.waitForFunction(({ element, text }) => !element.isConnected ||
      !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden' ||
      element.innerText !== text,
      { element: handle, text: previousText }, { timeout: actionTimeoutMs });
    await handle.dispose();
    closedCount++;
  }
  throw new Error('連續公告超過上限，請核對目前頁面。');
}
async function ensureOrigin(page) {
  if (new URL(page.url()).hostname !== 'creator.line.me') throw new Error('目前不在 creator.line.me，請重新登入後續跑');
}
async function openManagement(page, ask) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: /個人頁面/ }).first().click();
  if (new URL(page.url()).hostname !== 'creator.line.me') {
    await ask('請在瀏覽器完成 LINE 登入並進入管理後台，完成後按 Enter：');
  }
  await ensureOrigin(page);
  await dismissAnnouncements(page);
  await expect(page.getByRole('link', { name: '新增', exact: true })).toBeVisible();
}
async function fillMetadata(page, item) {
  for (const lang of ['zh-Hant', 'ja']) {
    if (await testId(page, 'title-' + lang).count() === 0) {
      await testId(page, 'select-language').selectOption(lang);
      await testId(page, 'btn-add-language').click();
    }
  }
  for (const lang of ['zh-Hant', 'en', 'ja']) {
    await testId(page, 'title-' + lang).fill(item.languages[lang].title);
    await testId(page, 'description-' + lang).fill(item.languages[lang].description);
    await expect(testId(page, 'title-' + lang)).toHaveValue(item.languages[lang].title);
    await expect(testId(page, 'description-' + lang)).toHaveValue(item.languages[lang].description);
  }
  await testId(page, 'copyright').fill(item.copyright);
  // The recording establishes only these two choices. Refuse to guess the opposite labels.
  if (!item.useAI || !item.autoStartSale) throw new Error('本版只校對過錄製中的「使用AI／自動開始販售」選項；請依實際頁面擴充 line-site.cjs');
  await page.getByRole('radio', { name: '使用AI', exact: true }).check();
  await page.getByRole('radio', { name: '自動開始販售', exact: true }).check();
}
async function createDraft(page, item, row, save, ask) {
  await openManagement(page, ask);
  await page.getByRole('link', { name: '新增', exact: true }).click();
  await dismissAnnouncements(page);
  await page.getByRole('link', { name: '貼圖', exact: true }).click();
  await ensureOrigin(page);
  await dismissAnnouncements(page);
  await fillMetadata(page, item);
  // Persist intent BEFORE a server-side creation can occur.
  row.stage = 'creating'; row.lastURL = page.url(); save();
  const capture = () => {
    const product = productFromURL(page.url());
    if (product) { row.productId = product.id; row.productURL = product.url; row.lastURL = page.url(); save(); }
  };
  const navigated = frame => { if (frame === page.mainFrame()) capture(); };
  page.on('framenavigated', navigated);
  try {
    const firstSave = page.getByText('儲存', { exact: true });
    const firstHandle = await firstSave.elementHandle();
    await firstSave.click();
    capture();
    if (!row.productId) {
      const secondSave = testId(page, 'btn-save');
      if (await visible(secondSave)) {
        // Codegen recorded two saves. Only click the second when it is a DIFFERENT control.
        const sameControl = !firstHandle || await secondSave.evaluate((el, first) => el === first || el.contains(first) || first.contains(el), firstHandle).catch(() => true);
        if (!sameControl) await secondSave.click();
      }
    }
    await optionalOK(page);
    await expect.poll(() => productFromURL(page.url()), { timeout: 60000 }).not.toBeNull();
    capture();
    if (!row.productId) throw new Error('儲存後未辨識到商品 ID');
    await expect(testId(page, 'tab-image')).toBeVisible();
    row.stage = 'metadata_saved'; save();
  } finally { page.off('framenavigated', navigated); }
}
async function openImages(page, row) {
  await page.goto(row.productURL, { waitUntil: 'domcontentloaded' });
  await ensureOrigin(page);
  await dismissAnnouncements(page);
  await testId(page, 'tab-image').click();
  await expect(testId(page, 'product-images-list-item').first()).toBeVisible();
  await page.getByRole('link', { name: '編輯', exact: true }).click();
  await expect(testId(page, 'select-image-amount')).toBeVisible();
}
async function verifyUpload(page, config, item, row, ask, allowRetry = false) {
  if (config.verification.mode === 'auto') {
    const result = await verifyGallery(page, item, row, config.verification.timeoutMs);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureOrigin(page);
    await dismissAnnouncements(page);
    await expect(testId(page, 'select-image-amount')).toBeVisible();
    await expect(testId(page, 'select-image-amount')).toHaveValue(String(item.stickerCount));
    await verifyGallery(page, item, row, config.verification.timeoutMs);
    row.imageVerification = { ...result, persistedAfterReload: true };
    console.log('圖片自動核對通過：' + result.count + ' 張，並已重新載入確認儲存。');
    return true;
  }
  if (config.verification.mode === 'selector') {
    await page.locator(config.verification.readySelector).waitFor({ state: 'visible', timeout: config.verification.timeoutMs });
    return true;
  }
  const answer = await ask(`請在瀏覽器核對 ${item.id}：主圖、標籤及 ${item.stickerCount} 張圖片均完成且正確，輸入 OK${allowRetry ? '；需要重新上傳則輸入 RETRY' : ''}，其他輸入停止：`);
  if (answer.trim().toUpperCase() === 'OK') return true;
  if (allowRetry && answer.trim().toUpperCase() === 'RETRY') return false;
  throw new Error('圖片尚未確認；進度已保留，請用 --resume 接續');
}
async function uploadImages(page, config, item, row, save, ask) {
  const wasPending = row.stage === 'upload_pending';
  await openImages(page, row);
  if (wasPending && (config.verification.mode !== 'auto' || (await currentGallery(page, item, row)).ready)) {
    if (await verifyUpload(page, config, item, row, ask, true)) {
      row.stage = 'images_verified'; save();
      await testId(page, 'btn-back').click(); return;
    }
  }
  const amount = testId(page, 'select-image-amount');
  if (await amount.inputValue() !== String(item.stickerCount)) {
    await amount.selectOption(String(item.stickerCount));
    await optionalOK(page);
  }
  await expect(amount).toHaveValue(String(item.stickerCount));
  await page.getByText('上傳壓縮檔', { exact: true }).click();
  row.stage = 'upload_pending'; row.lastURL = page.url(); save();
  await page.getByRole('button', { name: '上傳壓縮檔', exact: true }).setInputFiles(item.zipAbsolutePath);
  await verifyUpload(page, config, item, row, ask);
  row.stage = 'images_verified'; save();
  await testId(page, 'btn-back').click();
}
async function setPrice(page, item, row) {
  await page.goto(row.productURL, { waitUntil: 'domcontentloaded' });
  await ensureOrigin(page);
  await dismissAnnouncements(page);
  await testId(page, 'tab-price').click();
  const select = testId(page, 'select-price-tier');
  await expect(select).toBeVisible();
  if (!await select.locator(`option[value="${item.priceTier}"]`).count()) throw new Error('後台沒有指定 priceTier：' + item.priceTier);
  await select.selectOption(item.priceTier);
  console.log('價格選項：' + await select.locator('option:checked').innerText());
  await testId(page, 'button-save').click();
  await optionalOK(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!await visible(select)) await testId(page, 'tab-price').click();
  await expect(select).toHaveValue(item.priceTier);
}
module.exports = { createDraft, uploadImages, setPrice, openManagement, dismissAnnouncements, verifyUpload };
