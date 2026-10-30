import asyncio, json
from playwright.async_api import async_playwright
async def main():
 async with async_playwright() as p:
  browser = await p.chromium.launch(headless=True, args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
  context = await browser.new_context(viewport={'width':1280,'height':1800},permissions=['microphone'])
  page = await context.new_page()
  errors=[]
  page.on('pageerror', lambda e: errors.append(str(e)))
  await page.goto('http://localhost:8080',wait_until='networkidle')
  await page.get_by_role('button', name='Mikrofonu aç', exact=True).click()
  await page.get_by_role('heading',name='DİNLİYOR',exact=True).wait_for()
  await page.wait_for_timeout(1600)
  levels=[]
  for i in range(15):
   levels.append(float(await page.locator('canvas').get_attribute('data-level')))
   await page.wait_for_timeout(120)
  await page.screenshot(path='/tmp/browser/quantum/desktop.png')
  await page.get_by_role('button',name='Mikrofonu kapat',exact=True).click()
  await page.get_by_role('heading',name='HAZIR',exact=True).wait_for()
  await page.wait_for_timeout(900)
  stopped=float(await page.locator('canvas').get_attribute('data-level'))
  assert max(levels) > .02, levels
  assert stopped < .005, stopped
  await page.get_by_role('textbox',name='Mesaj yaz').fill('Kuantum ses testi')
  await page.get_by_role('button',name='Mesajı gönder').click()
  await page.reload(wait_until='networkidle')
  assert await page.get_by_text('Kuantum ses testi',exact=True).count() == 1
  await page.set_viewport_size({'width':390,'height':844})
  await page.screenshot(path='/tmp/browser/quantum/mobile.png')
  assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
  print(json.dumps({'audio_max':max(levels),'audio_min':min(levels),'stopped':stopped,'persisted':True,'overflow':False,'errors':errors}))
  await browser.close()
asyncio.run(main())
