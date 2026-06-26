// Verifies the two UI fixes at 1920x1080: (1) the Thumbnails inspector panel is NOT
// clipped off the right edge, (2) a saved template can be deleted.
import { chromium } from 'playwright'
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RDIR = join(ROOT, 'out', 'renderer')
const OUT = join(ROOT, 'browser-test-out')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = join(RDIR, p); if (!existsSync(f)) { res.writeHead(404); res.end(); return } res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f)) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const U = `http://127.0.0.1:${server.address().port}/`

const MOCK = `(function(){const noop=()=>{};const ns=o=>new Proxy(o,{get:(t,k)=>k in t?t[k]:(async()=>[])});let templates=[];const settings={accent:'Amber',ambientGlow:true,showActivityRail:true,defaultScreen:'library',namingTemplate:'x',outputFolder:'/o',concurrency:2,quality:'1080p',autoScrape:{enabled:true,frequency:'Every 6 hours',delaySec:1.5,retries:3,proxy:'',cookiesPath:''},background:{tray:true,startOnSignIn:true,notifications:true,webhook:''},transcription:{apiKey:'',model:'m'},beta:{enabled:true,pexelsKey:'',pixabayKey:'',coverrKey:''}};window.api={platform:'web',appVersion:'0.1.3',minimize:noop,maximize:noop,close:noop,openLogs:async()=>'',logPath:async()=>'',settings:ns({get:async()=>settings,set:async p=>Object.assign(settings,p),reset:async()=>settings}),db:ns({myChannels:async()=>[],recentUploads:async()=>[],downloads:async()=>[],sourceChannels:async()=>[],profiles:async()=>[],templates:async()=>templates,activity:async()=>[]}),scrape:ns({sourceVideos:async()=>[]}),reminders:ns({check:async()=>[]}),download:ns({}),compose:ns({}),transcribe:ns({}),thumbnails:ns({templates:async()=>templates,saveTemplate:async t=>{templates.push(t);return templates},deleteTemplate:async id=>{templates=templates.filter(t=>t.id!==id);return templates}}),render:ns({jobs:async()=>[]}),effects:ns({}),automation:ns({}),onActivity:()=>noop,onScrapeProgress:()=>noop,onDownloadProgress:()=>noop,onTranscribeProgress:()=>noop,onRenderProgress:()=>noop};})();`

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
await ctx.addInitScript({ content: MOCK })
const page = await ctx.newPage()
page.on('dialog', (d) => d.accept()) // auto-confirm the delete prompt
await page.goto(U, { waitUntil: 'networkidle' }); await page.waitForTimeout(1000)
await page.getByText('Thumbnails', { exact: true }).first().click(); await page.waitForTimeout(900)

// (1) clipping: the LAYERS inspector panel's right edge must be inside the 1920 viewport.
const layers = page.getByText('LAYERS', { exact: true }).first()
const box = await layers.boundingBox()
const rightEdge = box ? Math.round(box.x + box.width) : -1
const clipOk = box && box.x + box.width <= 1920
console.log(`INSPECTOR right-edge=${rightEdge} viewport=1920 → ${clipOk ? 'OK (inside)' : 'CLIPPED'}`)
await page.screenshot({ path: join(OUT, 'verify-thumbnails-1920.png') })

// (2) delete template: save one, confirm it appears, delete it, confirm it's gone.
await page.getByText('current', { exact: false }).first().click(); await page.waitForTimeout(700)
let count1 = await page.evaluate(async () => (await window.api.thumbnails.templates()).length)
console.log('templates after save:', count1)
// click the × on the first template card
const del = page.locator('div[title="Delete template"]').first()
const hasDel = await del.count()
if (hasDel) { await del.click(); await page.waitForTimeout(700) }
let count2 = await page.evaluate(async () => (await window.api.thumbnails.templates()).length)
console.log('delete control present:', hasDel > 0, '| templates after delete:', count2)
console.log(clipOk && hasDel > 0 && count1 === 1 && count2 === 0 ? 'VERIFY_OK' : 'VERIFY_FAIL')
await ctx.close(); await browser.close(); server.close()
