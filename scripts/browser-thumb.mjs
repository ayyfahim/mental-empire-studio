// Drives the Thumbnail Studio in Chromium: sets an IMAGE background + a subject PNG,
// then batch-generates — proving thumbnails composite a real image background + subject
// + headline text (not just text on a flat gradient).
import { chromium } from 'playwright'
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RDIR = join(ROOT, 'out', 'renderer')
const OUT = join(ROOT, 'browser-test-out')
mkdirSync(OUT, { recursive: true })
const ASSET = process.env.DEMO_ASSET_DIR || join(tmpdir(), 'demo-assets')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'
  const f = join(RDIR, p)
  if (!existsSync(f)) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const URLBASE = `http://127.0.0.1:${server.address().port}/`

const MOCK = `window.__pngs=[];(function(){const noop=()=>{};const ns=o=>new Proxy(o,{get:(t,k)=>k in t?t[k]:(async()=>[])});
const settings={accent:'Amber',ambientGlow:true,showActivityRail:true,defaultScreen:'library',namingTemplate:'{channel} - {title}',outputFolder:'/out',concurrency:2,quality:'1080p',autoScrape:{enabled:true,frequency:'Every 6 hours',delaySec:1.5,retries:3,proxy:'',cookiesPath:''},background:{tray:true,startOnSignIn:true,notifications:true,webhook:''},transcription:{apiKey:'',model:'whisper-large-v3-turbo'},beta:{enabled:true,pexelsKey:'',pixabayKey:'',coverrKey:''}};
window.api={platform:'web',appVersion:'0.1.3',minimize:noop,maximize:noop,close:noop,
settings:ns({get:async()=>settings,set:async p=>Object.assign(settings,p),reset:async()=>settings}),
db:ns({myChannels:async()=>[],recentUploads:async()=>[],downloads:async()=>[],sourceChannels:async()=>[],profiles:async()=>[],templates:async()=>[],activity:async()=>[]}),
scrape:ns({sourceVideos:async()=>[]}),reminders:ns({check:async()=>[]}),download:ns({}),compose:ns({list:async()=>[]}),transcribe:ns({get:async()=>[]}),
thumbnails:ns({templates:async()=>[],saveTemplate:async()=>[],writePng:async(name,dataUrl)=>{window.__pngs.push({name,dataUrl});return '/out/'+name;}}),
render:ns({jobs:async()=>[]}),effects:ns({generate:async()=>'{}'}),automation:ns({}),
onActivity:()=>noop,onScrapeProgress:()=>noop,onDownloadProgress:()=>noop,onTranscribeProgress:()=>noop,onRenderProgress:()=>noop};})();`

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
await ctx.addInitScript({ content: MOCK })
const page = await ctx.newPage()
const errs = []; page.on('pageerror', (e) => errs.push(String(e)))
await page.goto(URLBASE, { waitUntil: 'networkidle' }); await page.waitForTimeout(1200)
await page.getByText('Thumbnails', { exact: true }).first().click(); await page.waitForTimeout(900)

// Upload subject PNG + background image into the two hidden file inputs.
const fileInputs = page.locator('input[type=file]')
const count = await fileInputs.count()
console.log('file inputs found:', count)
// subject section renders before background section → nth(0)=subject, nth(1)=bg
if (count >= 1) await fileInputs.nth(0).setInputFiles(join(ASSET, 'subject.png')).catch((e) => console.log('subj err', e.message))
await page.waitForTimeout(600)
if (count >= 2) await fileInputs.nth(1).setInputFiles(join(ASSET, 'photobg.png')).catch((e) => console.log('bg err', e.message))
await page.waitForTimeout(1200)
await page.screenshot({ path: join(OUT, 'thumb-editor-imagebg.png') })
console.log('  shot thumb-editor-imagebg.png')

// Batch generate 3 titles → composited PNGs (image bg + subject + headline).
const tas = page.locator('textarea'); const n = await tas.count()
if (n > 0) { await tas.nth(n - 1).fill('THEY ALL LIED TO YOU\nYOU WERE NEVER THE PROBLEM\nWALK AWAY AND WIN'); await page.waitForTimeout(400) }
await page.getByText('Generate all', { exact: false }).first().click(); await page.waitForTimeout(3000)

const pngs = await page.evaluate(() => window.__pngs || [])
console.log('rasterized pngs:', pngs.length)
pngs.slice(0, 3).forEach((p, i) => writeFileSync(join(OUT, `thumb-imagebg-${i + 1}.png`), Buffer.from(p.dataUrl.split(',')[1], 'base64')))
console.log('PAGE ERRORS:', errs.length, errs.slice(0, 2).join(' | '))
await ctx.close(); await browser.close(); server.close()
console.log('DONE')
