'use strict';
// Local HTML fixtures only. This test does not contact or sign in to LINE.
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { dismissAnnouncements } = require('../line-site.cjs');

const style = `<style>
body{margin:0} [role=dialog]{position:fixed;inset:40px;background:white;border:2px solid green;padding:20px;overflow:auto;}
.content{height:1000px} button{display:block;margin-top:10px} label{display:block}
</style>`;
function notice(id, { hiddenInput = false, hidden = false, z = 1, tall = false } = {}) {
  return `<section role="dialog" aria-label="公告 ${id}" id="${id}" style="z-index:${z};${hidden ? 'display:none' : ''}">
    <h2>公告 ${id}</h2>${tall ? '<div class="content">可捲動內容</div>' : ''}
    <label><input type="checkbox" ${hiddenInput ? 'style="position:absolute;opacity:0;width:0;height:0"' : ''}>以後不再顯示此畫面</label>
    <button onclick="window.closedNotices.push({id:'${id}',checked:this.parentElement.querySelector('input').checked});this.parentElement.remove()">關閉</button>
  </section>`;
}
const options = { firstWaitMs: 1000, nextWaitMs: 600, trialTimeoutMs: 1200, actionTimeoutMs: 4000 };
async function runAnnouncementTests() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1033, height: 762 } });
  const tests = [];
  async function load(html) { await page.setContent(style + '<script>window.closedNotices=[]</script>' + html); }
  try {
    await load('<p>沒有公告</p>');
    assert.equal(await dismissAnnouncements(page, options), 0); tests.push('沒有公告時正常繼續');

    await load(notice('scroll', { tall: true }));
    assert.equal(await dismissAnnouncements(page, options), 1);
    assert.deepEqual(await page.evaluate(() => window.closedNotices), [{ id: 'scroll', checked: true }]); tests.push('捲動公告底部，勾選後關閉');

    await load(notice('hidden', { hidden: true }) + notice('visible'));
    assert.equal(await dismissAnnouncements(page, options), 1);
    assert.equal(await page.locator('#hidden').count(), 1); tests.push('跳過隱藏公告而操作可見公告');

    // Topmost is deliberately earlier in DOM order, so .last() alone would also fail.
    await load(notice('top', { z: 10 }) + notice('bottom', { z: 1 }));
    assert.equal(await dismissAnnouncements(page, options), 2);
    assert.deepEqual(await page.evaluate(() => window.closedNotices.map(r => r.id)), ['top', 'bottom']); tests.push('多層公告依可點擊狀態關閉，而非 DOM 順序');

    await load(notice('styled', { hiddenInput: true }));
    assert.equal(await dismissAnnouncements(page, options), 1);
    assert.equal(await page.evaluate(() => window.closedNotices[0].checked), true); tests.push('隱藏的原生 checkbox 使用可見 label 勾選');

    await load(notice('first') + `<script>
      document.querySelector('button').onclick=function(){
        window.closedNotices.push({id:'first',checked:this.parentElement.querySelector('input').checked});
        this.parentElement.remove(); setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(notice('second'))}),150);
      };
    </script>`);
    assert.equal(await dismissAnnouncements(page, options), 2); tests.push('關閉後等待延遲出現的下一個公告');

    await load(notice('reuse') + `<script>
      let first=true; document.querySelector('button').onclick=function(){
        const d=this.parentElement; window.closedNotices.push({id:d.querySelector('h2').textContent,checked:d.querySelector('input').checked});
        if(first){first=false;d.querySelector('h2').textContent='第二個公告';d.querySelector('input').checked=false;}else{d.remove();}
      };
    </script>`);
    assert.equal(await dismissAnnouncements(page, options), 2);
    assert.deepEqual(await page.evaluate(() => window.closedNotices.map(r => r.checked)), [true, true]); tests.push('同一視窗容器重用時辨識公告已切換');

    await load('<div id="later"></div><script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",' + JSON.stringify(notice('late')) + '),150)</script>');
    assert.equal(await dismissAnnouncements(page, options), 1); tests.push('等待換頁後延遲掛載的公告');
    return { passed: tests.length, tests };
  } catch (error) {
    error.message = `公告回歸測試已通過 ${tests.length} 項；下一項失敗：${error.message}`;
    throw error;
  } finally { await browser.close(); }
}
module.exports = { runAnnouncementTests };
if (require.main === module) runAnnouncementTests().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
