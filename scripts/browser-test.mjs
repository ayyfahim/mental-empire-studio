// Drives the built renderer in a real Chromium browser (Playwright), clicking through
// the UI like a user. window.api is mocked (a browser has no Electron backend) with
// stateful seed data so every screen is populated. Produces: screenshots, a recorded
// video of the session, and a real thumbnail PNG rasterized by the Konva studio.
import { chromium } from 'playwright'
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RDIR = join(ROOT, 'out', 'renderer')
const OUT = join(ROOT, 'browser-test-out')
mkdirSync(OUT, { recursive: true })
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }

// ---- tiny static server for out/renderer ----
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  const f = join(RDIR, p)
  if (!existsSync(f)) { res.writeHead(404); res.end('nf'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' })
  res.end(readFileSync(f))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const URLBASE = `http://127.0.0.1:${PORT}/`

// ---- the mocked window.api (injected before app scripts run) ----
const MOCK = `
window.__pngs = [];
(function(){
  const grad = (a,b) => 'linear-gradient(135deg,'+a+','+b+')';
  const channels = [
    { id:'me', name:'Mental Empire', handle:'@MentalEmpire', mono:'ME', avatar:grad('#f5b323','#b9780a'), views:'1.2M', subs:'455', total:1240000, linkedSourceId:'pw', source:'@PowerWithinOfficial', mapDone:12, mapTotal:18, weekDone:3, weekGoal:5, monthDone:9, monthGoal:20, reminder:'Fri Jun 27', reminderNote:'' },
    { id:'sh', name:'Stoic Hour', handle:'@StoicHour', mono:'SH', avatar:grad('#8b7cff','#5b4fd6'), views:'880K', subs:'1.1K', total:880000, linkedSourceId:'ds', source:'@DailyStoicTalks', mapDone:7, mapTotal:10, weekDone:2, weekGoal:4, monthDone:6, monthGoal:16, reminder:'', reminderNote:'' },
    { id:'sd', name:'Sleep Deep', handle:'@SleepDeep', mono:'SD', avatar:grad('#36c98e','#1f9c6b'), views:'2.3M', subs:'8.4K', total:2300000, linkedSourceId:'rs', source:'@RainSounds24', mapDone:3, mapTotal:3, weekDone:1, weekGoal:3, monthDone:4, monthGoal:12, reminder:'', reminderNote:'' }
  ];
  const recentUploads = [
    { title:'Why Narcissists Panic When You Go Quiet', channel:'Mental Empire', views:'42K', publishedAt:'2d ago' },
    { title:'The Stoic Secret to Never Being Angry', channel:'Stoic Hour', views:'18K', publishedAt:'4d ago' },
    { title:'8 Hours Heavy Rain for Deep Sleep', channel:'Sleep Deep', views:'120K', publishedAt:'1w ago' }
  ];
  const downloads = [
    { id:'d1', sourceId:'pw', title:'How Narcissists Act When They Can No Longer Control You', channel:'@PowerWithinOfficial', size:'31 MB', when:'just now', stage:'Downloaded only', pct:'100', action:'Open', thumb:grad('#2a2540','#46243a'), durationSec:1320 },
    { id:'d2', sourceId:'pw', title:'The Final Dirty Trick Narcissists Use', channel:'@PowerWithinOfficial', size:'28 MB', when:'10m ago', stage:'Downloading', pct:'64', action:'Resume', thumb:grad('#143a32','#0f3a32'), durationSec:1190 }
  ];
  const titles = ['How Narcissists React After Long No Contact','The Narcissist Can\\'t Escape What They Did to You','When The Narcissist Knows You Will Never Come Back','Narcissists Are 100% Done With You Forever','What Narcissists Do When They KNOW They\\'re Guilty','When A Narcissist And You BOTH Go No Contact','Universe Sends These 3 Signs Before Removing a Narcissist','How to RESPOND When a Narcissist Reaches Out'];
  const sourceVideos = titles.map((t,i)=>({ id:'sv'+i, title:t+' | Dr Ramani', durationSec:1150+i*97, views:48000+i*15300, uploadDate:'2026-06-'+(10+i), thumb:grad(['#23304a','#2a2540','#143a32','#3a2330'][i%4], '#15171d') }));
  const templates = [{ id:'tpl-1', name:'Full Bleed', layers:[] }];
  const profiles = [
    { id:'me', name:'Mental Empire', mono:'ME', avatar:grad('#f5b323','#b9780a'), rule:'Latest · 5 videos', images:'Pool of 10 · shuffle', thumb:'Full Bleed', cap:'Hormozi · 16:9', out:'/Desktop/ME_out', autoWatch:true, sourceUrl:'https://youtube.com/@PowerWithinOfficial', sourceOrder:'Latest', sourceCount:5, imageMode:'pool', poolSize:10, kenBurns:true, captionPreset:'Hormozi', captionAspect:'16:9' }
  ];
  const activity = [
    { t:'09:42', icon:'✓', color:'#36c98e', text:'Rendered "Gaslighting Explained" → ME_out' },
    { t:'09:31', icon:'✓', color:'#36c98e', text:'Downloaded 5 mp3 from @PowerWithinOfficial' },
    { t:'09:30', icon:'◔', color:'#f5b323', text:'Auto-watch found 5 new uploads' }
  ];
  const settings = { accent:'Amber', ambientGlow:true, showActivityRail:true, defaultScreen:'library', namingTemplate:'{channel} - {title}', outputFolder:'/Desktop/ME_out', concurrency:2, quality:'1080p', autoScrape:{enabled:true,frequency:'Every 6 hours',delaySec:1.5,retries:3,proxy:'',cookiesPath:''}, background:{tray:true,startOnSignIn:true,notifications:true,webhook:''}, transcription:{apiKey:'',model:'whisper-large-v3-turbo'}, beta:{enabled:true,pexelsKey:'',pixabayKey:'',coverrKey:''} };
  const dlCbs=[]; const noop=()=>{};
  const ns = (o)=> new Proxy(o, { get:(t,k)=> (k in t ? t[k] : (async()=>[])) });
  window.api = {
    platform:'web', appVersion:'0.1.3', minimize:noop, maximize:noop, close:noop,
    settings: ns({ get:async()=>settings, set:async(p)=>Object.assign(settings,p||{}), reset:async()=>settings }),
    db: ns({ myChannels:async()=>channels, recentUploads:async()=>recentUploads, downloads:async()=>downloads, sourceChannels:async()=>[], profiles:async()=>profiles, templates:async()=>templates, activity:async()=>activity, upsertProfile:async()=>profiles, saveTemplate:async(t)=>{templates.push(t);return templates;}, updateChannelGoals:async()=>channels }),
    scrape: ns({ channel:async()=>({}), addMyChannel:async()=>channels[0], refreshChannel:async()=>channels[0], all:async()=>channels, sourceVideos:async()=>sourceVideos }),
    reminders: ns({ check:async()=>[] }),
    download: ns({ start:async(vids)=>{ (vids||[]).forEach((v,i)=>{ let pct=0; const id=setInterval(()=>{ pct+=20; dlCbs.forEach(cb=>cb({downloadId:v.id,title:v.title,pct,stage:'Downloading',done:pct>=100})); if(pct>=100){clearInterval(id); downloads.unshift({id:v.id,sourceId:'pw',title:v.title,channel:'@PowerWithinOfficial',size:'30 MB',when:'just now',stage:'Downloaded only',pct:'100',action:'Open',thumb:grad('#2a2540','#15171d'),durationSec:v.durationSec});}},250+i*120); }); return downloads; }, resume:async(id)=>downloads.find(d=>d.id===id), openFolder:async()=>{} }),
    compose: ns({ list:async()=>[], get:async()=>null, images:async()=>[] }),
    transcribe: ns({ get:async()=>[] }),
    thumbnails: ns({ templates:async()=>templates, saveTemplate:async(t)=>{templates.push(t);return templates;}, assignToProfile:async()=>profiles, writePng:async(name,dataUrl)=>{ window.__pngs.push({name,dataUrl}); return '/out/'+name; } }),
    render: ns({ jobs:async()=>[], all:async()=>{}, cancel:async()=>{} }),
    effects: ns({ generate:async()=>'{}' }),
    automation: ns({ runProfile:async()=>[], upsertProfile:async()=>profiles, deleteProfile:async()=>profiles, tick:async()=>{} }),
    onActivity:(cb)=>{return noop;}, onScrapeProgress:()=>noop,
    onDownloadProgress:(cb)=>{dlCbs.push(cb);return noop;}, onTranscribeProgress:()=>noop, onRenderProgress:()=>noop
  };
})();
`

const shot = async (page, name) => { await page.screenshot({ path: join(OUT, name) }); console.log('  shot', name) }
const nav = async (page, label) => {
  await page.getByText(label, { exact: true }).first().click({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(900)
}

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] })
const contextOptions = { viewport: { width: 1366, height: 850 }, deviceScaleFactor: 1 }
if (process.env.RECORD_VIDEO === '1') {
  contextOptions.recordVideo = { dir: OUT, size: { width: 1366, height: 850 } }
}
const context = await browser.newContext(contextOptions)
await context.addInitScript({ content: MOCK })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

console.log('open', URLBASE)
await page.goto(URLBASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await shot(page, '01-library.png')

// Settings → flip accent colors (pure UI)
await nav(page, 'Settings')
for (const a of ['Violet', 'Emerald', 'Crimson', 'Amber']) { await page.getByText(a, { exact: true }).first().click().catch(() => {}); await page.waitForTimeout(450) }
await shot(page, '02-settings.png')

await nav(page, 'My Channels'); await shot(page, '03-mychannels.png')

// Download → Fetch + select 2 cards + Download mp3 only
await nav(page, 'Download')
await page.getByPlaceholder('youtube.com/@PowerWithinOfficial').fill('youtube.com/@PowerWithinOfficial').catch(() => {})
await page.getByText('Fetch', { exact: true }).first().click().catch(() => {})
await page.waitForTimeout(1200)
await shot(page, '04-download-fetched.png')
// click two video cards (their titles)
for (const t of ['How Narcissists React After Long No Contact | Dr Ramani', 'The Narcissist Can\'t Escape What They Did to You | Dr Ramani']) {
  await page.getByText(t, { exact: false }).first().click().catch(() => {})
  await page.waitForTimeout(300)
}
await page.getByText('Download mp3 only', { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(1800)
await shot(page, '05-download-progress.png')

await nav(page, 'Compose'); await shot(page, '06-compose.png')

// Thumbnails → build + batch generate (real Konva rasterize → PNG)
await nav(page, 'Thumbnails')
await page.waitForTimeout(800)
await page.getByText('Auto-arrange type', { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(700)
await shot(page, '07-thumbnails.png')
// batch: fill the last textarea with titles, click Generate all
const tas = page.locator('textarea')
const n = await tas.count()
if (n > 0) { await tas.nth(n - 1).fill('YOU WERE THE PRIZE\nTHEY KNOW THEY LOST\nNARCISSIST EXPOSED'); await page.waitForTimeout(400) }
await page.getByText('Generate all', { exact: false }).first().click().catch(() => {})
await page.waitForTimeout(2500)
await shot(page, '08-thumbnails-batch.png')

await nav(page, 'Render Queue'); await shot(page, '09-renderqueue.png')
await nav(page, 'Profiles'); await shot(page, '10-profiles.png')

// grab the first rasterized thumbnail dataURL → real PNG
const pngs = await page.evaluate(() => window.__pngs || [])
console.log('rasterized pngs:', pngs.length)
if (pngs.length) {
  const b64 = pngs[0].dataUrl.split(',')[1]
  writeFileSync(join(OUT, 'thumbnail.png'), Buffer.from(b64, 'base64'))
  console.log('  wrote thumbnail.png from', pngs[0].name)
}
console.log('PAGE ERRORS:', errors.length, errors.slice(0, 3).join(' | '))

const video = page.video()
const vpath = video ? await video.path() : ''
await context.close()
await browser.close()
server.close()
if (vpath) console.log('VIDEO_RAW', vpath)
console.log('DONE')
