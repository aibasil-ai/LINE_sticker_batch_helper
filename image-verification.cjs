'use strict';
const { expect } = require('@playwright/test');

function inspectGallery(slots, expected, productId) {
  const issues = [], urls = [], seen = new Set();
  const keys = Object.keys(expected);
  if (slots.length !== keys.length) issues.push(`圖片欄位 ${slots.length}/${keys.length}`);
  for (const slot of slots) {
    if (!expected[slot.key] || seen.has(slot.key)) { issues.push('未知或重複欄位：' + slot.key); continue; }
    seen.add(slot.key);
    if (slot.error) issues.push(slot.key + '：' + slot.error);
    try {
      const url = new URL(slot.src);
      const image = expected[slot.key];
      if (url.protocol !== 'https:' || !(url.hostname === 'line-scdn.net' || url.hostname.endsWith('.line-scdn.net')) ||
          !url.pathname.endsWith(`/sticker/${productId}/${slot.key}/${image.sha1}.png`)) {
        issues.push(slot.key + ' 圖片尚未與本組 ZIP 相符'); continue;
      }
      urls.push({ key: slot.key, url: url.href, width: image.width, height: image.height });
    } catch (_) { issues.push(slot.key + ' 圖片尚未上傳'); }
  }
  for (const key of keys) if (!seen.has(key)) issues.push('缺少欄位：' + key);
  return { ready: issues.length === 0 && urls.length === keys.length, issues, urls };
}
async function currentGallery(page, item, row) {
  if (!item.expectedImages || !Object.keys(item.expectedImages).length || !/^\d+$/.test(String(row.productId))) throw new Error('缺少本組圖片指紋或商品 ID，無法自動核對');
  const slots = await page.locator('[data-test="product-images-list-item"]').evaluateAll(elements => elements
    .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    .map(el => ({ key: el.querySelector('[data-test="product-image-key"]')?.textContent.trim() || '',
      src: el.querySelector('[data-test="product-image"]')?.getAttribute('src') || '',
      error: el.querySelector('.cm-product-image-error')?.textContent.trim() || '' })));
  return inspectGallery(slots, item.expectedImages, row.productId);
}
async function verifyGallery(page, item, row, timeoutMs) {
  let report;
  try {
    await expect.poll(async () => { report = await currentGallery(page, item, row); return report.ready; }, {
      timeout: timeoutMs, intervals: [300, 700, 1500]
    }).toBe(true);
  } catch (error) {
    throw new Error('圖片自動核對未通過：' + (report?.issues.slice(0, 6).join('；') || error.message));
  }
  // The real editor uses input[type=image]; load an Image to check decoding and dimensions.
  const decoded = await page.evaluate(async ({ urls, timeout }) => Promise.all(urls.map(slot => new Promise(resolve => {
    const image = new Image();
    const finish = ok => { clearTimeout(timer); image.onload = image.onerror = null; resolve({ key: slot.key, ok }); };
    const timer = setTimeout(() => finish(false), timeout);
    image.onload = () => finish(image.naturalWidth === slot.width && image.naturalHeight === slot.height);
    image.onerror = () => finish(false);
    image.src = slot.url;
  }))), { urls: report.urls, timeout: Math.min(timeoutMs, 30000) });
  const failed = decoded.filter(slot => !slot.ok);
  if (failed.length) throw new Error('圖片無法載入或尺寸不符：' + failed.map(slot => slot.key).join(', '));
  return { mode: 'auto', verifiedAt: new Date().toISOString(), count: decoded.length,
    keys: decoded.map(slot => slot.key), sha1Matched: true, dimensionsMatched: true };
}
module.exports = { inspectGallery, currentGallery, verifyGallery };
