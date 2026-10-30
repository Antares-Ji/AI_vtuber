const { chromium } = require('C:/Users/Antares.Ji/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:3000/studio.html#game-input');
    await page.waitForLoadState('networkidle');
    await page.locator('#gi-image').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#gi-image').naturalWidth > 0);
    assert.ok(await page.locator('#game-input').evaluate(e => e.classList.contains('active')));
    await page.locator('#gi-kind').selectOption('drag');
    await page.locator('#gi-image').click({ position: { x: 100, y: 100 } });
    await page.locator('#gi-image').click({ position: { x: 250, y: 120 } });
    assert.equal(await page.locator('#gi-markers span').count(), 2);
    let calls = 0;
    // UI contract test only; intercept native mutations so this test cannot play a card.
    await page.route('**/api/game-input/action', async route => {
      const body = route.request().postDataJSON(); calls++;
      assert.equal(body.kind, 'drag'); assert.equal(body.from.length, 2); assert.equal(body.to.length, 2); assert.ok(body.frameId);
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'UI contract test: no game input' }) });
    });
    await page.locator('#gi-execute').click();
    await page.waitForFunction(() => document.querySelector('#gi-result').textContent.includes('UI contract test'));
    assert.equal(calls, 1); assert.deepEqual(errors, []);
    let starts = 0, stops = 0;
    await page.route('**/api/skills/run', async route => {
      const body=route.request().postDataJSON();
      assert.equal(body.skill,'sts2:native-play');assert.equal(body.args.maxSteps,300);assert.equal(body.allowLive,true); starts++;
      await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({id:'00000000-0000-4000-8000-000000000001',state:'RUNNING'})});
    });
    await page.route('**/api/game-input/stop', async route => {
      stops++; await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({stopRequested:true})});
    });
    await page.locator('#gi-agent-start').click();
    await page.waitForResponse('**/api/game-input/state');
    await page.locator('#gi-agent-stop').click();
    await page.waitForResponse('**/api/game-input/state');
    assert.equal(starts,1); assert.equal(stops,1); assert.deepEqual(errors,[]);
    await page.screenshot({ path: 'runtime/game-input/console-ui.png', fullPage: true });
    console.log('Console UI passed: native action contract, autonomous start/stop buttons; all mutations intercepted.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
