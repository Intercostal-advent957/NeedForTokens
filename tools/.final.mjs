import { chromium } from 'playwright';
const PORT = process.argv[2] || '5401';
const b = await chromium.launch({ headless: true, args: ['--use-gl=angle','--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.error('PAGEERR', String(e.message).slice(0,200)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__NFT && window.__NFT.ready, null, { timeout: 90000 });

const measure = async (label, setup, tier='high') => {
  await page.evaluate(t => window.__NFT.setQuality(t), tier);
  await page.evaluate(async (src) => { const fn = new Function('nft', `return (${src})(nft)`); await fn(window.__NFT); }, setup.toString());
  await page.evaluate(() => window.__NFT.waitFrames(6));
  const on = await page.evaluate(() => window.__NFT.stats);
  const cityInfo = await page.evaluate(() => {
    const c = window.__NFT.ctx; let m=0,t=0,cast=0,ct=0;
    c.city.root.traverseVisible(o => { if(!o.isMesh) return; m++;
      const idx=(o.geometry?.index?.count||0)/3; t += idx*(o.isInstancedMesh?o.count:1);
      if(o.castShadow){cast++; ct+=idx*(o.isInstancedMesh?o.count:1);} });
    return { meshes:m, tris:Math.round(t), casters:cast, casterTris:Math.round(ct), pool:c.city.pool.lights.filter(l=>l.light.visible).length };
  });
  await page.evaluate(async () => { window.__NFT.ctx.city.root.visible=false; await window.__NFT.waitFrames(6); });
  const off = await page.evaluate(() => window.__NFT.stats);
  await page.evaluate(async () => { window.__NFT.ctx.city.root.visible=true; await window.__NFT.waitFrames(4); });
  console.log(`${label.padEnd(22)} tier=${tier} total=${on.draws}d/${Math.round(on.tris/1000)}k  city=${on.draws-off.draws}d/${Math.round((on.tris-off.tris)/1000)}k  meshes=${cityInfo.meshes} casters=${cityInfo.casters}(${cityInfo.casterTris}tri) lights=${cityInfo.pool} fps=${Math.round(on.fps)}`);
};
await measure('01 golden chase', async (nft)=>{ nft.setPreset('goldenHour'); nft.setCamera('chase'); nft.teleport(0.12,0,190); nft.drive({throttle:1,steer:0.18}); await nft.settle(2.2); });
await measure('02 night neon wet', async (nft)=>{ nft.setPreset('night'); nft.setWeather({wetness:0.85,rain:0.25}); nft.setCamera('chase'); nft.teleport(0.42,1.5,150); nft.drive({throttle:0.9,steer:-0.1}); await nft.settle(2.2); });
await measure('12 tunnel nos', async (nft)=>{ nft.setPreset('night'); nft.setCamera('chase'); nft.teleport(0.55,0,200); nft.drive({throttle:1,nos:1}); await nft.settle(2.2); });
await measure('13 aerial vista', async (nft)=>{ nft.setPreset('goldenHour'); nft.setCamera('photo'); nft.teleport(0.2,0,0); nft.photo({position:[70,44,90],lookAt:[0,2,0],fov:46,worldUp:true}); await nft.settle(1.5); });
await measure('13 aerial vista LOW', async (nft)=>{ nft.setPreset('goldenHour'); nft.setCamera('photo'); nft.teleport(0.2,0,0); nft.photo({position:[70,44,90],lookAt:[0,2,0],fov:46,worldUp:true}); await nft.settle(1.5); }, 'low');
await measure('13 aerial vista ULTRA', async (nft)=>{ nft.setPreset('goldenHour'); nft.setCamera('photo'); nft.teleport(0.2,0,0); nft.photo({position:[70,44,90],lookAt:[0,2,0],fov:46,worldUp:true}); await nft.settle(1.5); }, 'ultra');
console.log('errors:', JSON.stringify(await page.evaluate(()=>window.__NFT.errors)));
await b.close();
