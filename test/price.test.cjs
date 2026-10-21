'use strict';
// 僅使用本機 HTML 與攔截回應，不連線或登入 LINE。
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { setPrice } = require('../line-site.cjs');

const productURL = 'https://creator.line.me/my/123/sticker/4567890';
const options = { timeoutMs: 4000, announcementOptions: { firstWaitMs: 75, nextWaitMs: 75, actionTimeoutMs: 1000 } };
function priceFixture(config) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <button data-test="tab-price">價格</button><main id="price"></main>
    ${config.announcement ? '<section role="dialog" aria-label="公告"><p>測試公告</p><button onclick="this.parentElement.remove()">關閉</button></section>' : ''}
    <script>
      const config = ${JSON.stringify(config)};
      const tab = document.querySelector('[data-test="tab-price"]');
      let mounted = false;
      function selected() {
        tab.disabled = true;
        if (config.ariaOnly) tab.setAttribute('aria-selected', 'true');
        else tab.classList.add('selected');
        history.replaceState(null, '', '#/price');
      }
      function mount() {
        if (mounted || config.noForm) return;
        mounted = true;
        setTimeout(() => {
          const select = document.createElement('select'); select.setAttribute('data-test', 'select-price-tier');
          document.querySelector('#price').append(select);
          const fillOptions = () => {
            for (const value of config.tiers) {
              const option = document.createElement('option'); option.value = value; option.textContent = '價格 ' + value;
              option.selected = value === config.value; select.append(option);
            }
          };
          if (config.optionDelay) setTimeout(fillOptions, config.optionDelay); else fillOptions();
          const save = document.createElement('button'); save.setAttribute('data-test', 'button-save'); save.textContent = '儲存';
          save.onclick = () => window.recordPriceAction({ type: 'save', value: select.value });
          document.querySelector('#price').append(save);
        }, config.formDelay);
      }
      tab.onclick = async () => { await window.recordPriceAction({ type: 'tab' }); selected(); mount(); };
      if (config.selected) { selected(); mount(); }
      else if (config.enableDelay) { tab.disabled = true; setTimeout(() => { tab.disabled = false; }, config.enableDelay); }
    </script></body></html>`;
}

async function runPriceTests() {
  const browser = await chromium.launch({ headless: true });
  const tests = [];
  async function check(name, settings, verify) {
    const context = await browser.newContext();
    const page = await context.newPage(); page.setDefaultTimeout(4000);
    const events = [], pageErrors = []; let loads = 0, saved = settings.initialValue || '2';
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.exposeFunction('recordPriceAction', event => {
      events.push(event);
      if (event.type === 'save' && settings.persist !== false) saved = event.value;
    });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest() || new URL(request.url()).pathname !== new URL(productURL).pathname) return route.abort();
      const reloaded = ++loads > 1;
      return route.fulfill({ contentType: 'text/html', body: priceFixture({
        selected: reloaded ? settings.reloadSelected !== false : !!settings.initialSelected,
        ariaOnly: !!settings.ariaOnly, noForm: !!settings.noForm,
        formDelay: (reloaded ? settings.reloadDelay : settings.initialDelay) || 0,
        optionDelay: settings.optionDelay || 0, enableDelay: settings.enableDelay || 0,
        tiers: settings.tiers || ['2', '5'], value: saved, announcement: reloaded && !!settings.announcement
      }) });
    });
    const row = { productURL, stage: 'images_verified' };
    try {
      await verify({ page, row, events, saved: () => saved, loads: () => loads,
        run: (overrides = {}) => setPrice(page, { priceTier: '5' }, row, { ...options, ...overrides }) });
      assert.equal(row.stage, 'images_verified', '價格函式只有完成核對後返回，進度由批次流程更新');
      assert.deepEqual(pageErrors, []); tests.push(name);
    } finally { await context.close(); }
  }
  try {
    await check('儲存重新載入後頁籤已選取且停用，表單延遲出現時直接等待而不重複點擊', { reloadDelay: 1600 }, async ({ run, events, saved, loads }) => {
      await run();
      assert.equal(saved(), '5'); assert.equal(loads(), 2);
      assert.equal(events.filter(event => event.type === 'tab').length, 1);
      assert.deepEqual(events.filter(event => event.type === 'save').map(event => event.value), ['5']);
    });
    await check('一開始就在 aria-selected 的停用價格頁籤時，等待表單即可完成價格核對', { initialSelected: true, initialDelay: 250, ariaOnly: true }, async ({ run, events, saved }) => {
      await run(); assert.equal(saved(), '5'); assert.equal(events.filter(event => event.type === 'tab').length, 0);
    });
    await check('重新載入回到其他頁籤時，仍會正常切換至價格頁籤', { reloadSelected: false }, async ({ run, events, saved }) => {
      await run(); assert.equal(saved(), '5'); assert.equal(events.filter(event => event.type === 'tab').length, 2);
    });
    await check('價格選項晚於表單出現時，等待選項載入再選擇與儲存', { initialSelected: true, optionDelay: 250 }, async ({ run, saved }) => {
      await run(); assert.equal(saved(), '5');
    });
    await check('未選取的價格頁籤暫時停用時，等到可用後才點擊', { enableDelay: 200 }, async ({ run, events, saved }) => {
      await run(); assert.equal(saved(), '5'); assert.equal(events.filter(event => event.type === 'tab').length, 1);
    });
    await check('後台沒有指定價格選項時回報錯誤，不儲存其他價格', { initialSelected: true, tiers: ['2'] }, async ({ run, events, saved }) => {
      await assert.rejects(run({ timeoutMs: 700 }), /沒有指定 priceTier/);
      assert.equal(saved(), '2'); assert.equal(events.filter(event => event.type === 'save').length, 0);
    });
    await check('價格未實際儲存時，重新載入後的核對必須失敗', { persist: false }, async ({ run, events, saved }) => {
      await assert.rejects(run({ timeoutMs: 700 }), /價格.*不一致/);
      assert.equal(saved(), '2'); assert.equal(events.filter(event => event.type === 'save').length, 1);
    });
    await check('頁籤已選取但表單始終沒有載入時回報錯誤，不強制點擊停用頁籤', { initialSelected: true, noForm: true }, async ({ run, events }) => {
      await assert.rejects(run({ timeoutMs: 700 }), /價格表單.*載入/); assert.deepEqual(events, []);
    });
    await check('重新載入後出現公告時，關閉公告後再完成價格核對', { announcement: true }, async ({ run, page, saved }) => {
      await run(); assert.equal(saved(), '5'); assert.equal(await page.getByRole('dialog').count(), 0);
    });
    return { passed: tests.length, tests };
  } catch (error) {
    error.message = `價格回歸測試已通過 ${tests.length} 項；下一項失敗：${error.message}`;
    throw error;
  } finally { await browser.close(); }
}
module.exports = { runPriceTests };
if (require.main === module) runPriceTests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
