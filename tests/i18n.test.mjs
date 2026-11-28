import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createI18n} from 'vue-i18n';
import {createLocaleClient, defaultSnapshot, resolveSystemLocale} from '../src/i18n/locale.js';

test('locale resolution distinguishes Simplified Chinese from Traditional and unknown languages', () => {
  for (const tag of ['zh-CN','zh_SG','zh-Hans','zh-Hans-HK','ZH-cn']) assert.equal(resolveSystemLocale(tag),'zh-CN',tag);
  for (const tag of ['zh','zh-TW','zh-HK','zh-Hant-CN','en-GB','fr-FR','bad locale','']) assert.equal(resolveSystemLocale(tag),'en-US',tag);
});

function deferred() { let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve}; }
const manual = (locale, revision) => ({mode:'manual',locale,resolvedLocale:locale,revision});
test('a native language event outruns an old snapshot without echoing a write', async () => {
  const reading=deferred(); let receive; const changes=[]; const writes=[]; let removed=0;
  const client=createLocaleClient({initial:defaultSnapshot('en-US'),read:()=>reading.promise,
    write: value=>writes.push(value),subscribe:async fn=>{receive=fn;return()=>{removed++;};},changed:value=>changes.push(value)});
  const started=client.start(); await Promise.resolve();
  receive(manual('zh-CN',3)); reading.resolve(manual('en-US',1)); await started;
  assert.equal(client.snapshot.resolvedLocale,'zh-CN'); assert.equal(changes.length,1); assert.equal(writes.length,0);
  receive({...manual('en-US',4),revision:undefined}); receive({...manual('en-US',4),resolvedLocale:'xx'});
  assert.equal(changes.length,1);
  client.stop(); receive(manual('en-US',5)); assert.equal(changes.length,1); assert.equal(removed,1);
});
test('open windows and a newly opened window share native state while preserving the manual choice in system mode', async () => {
  let server=manual('en-US',1); const sinks=new Set(); const writes=[];
  const make=()=>createLocaleClient({initial:defaultSnapshot('en-US'),read:async()=>server,
    subscribe:async fn=>{sinks.add(fn);return()=>sinks.delete(fn);},changed(){},
    write:async pref=>{writes.push(pref);server={...pref,resolvedLocale:pref.mode==='system'?'en-US':pref.locale,revision:server.revision+1};for(const fn of sinks)fn(server);return server;}});
  const main=make(), models=make(); await Promise.all([main.start(),models.start()]);
  await main.set('zh-CN'); assert.equal(models.snapshot.resolvedLocale,'zh-CN');
  const later=make(); await later.start(); assert.equal(later.snapshot.resolvedLocale,'zh-CN');
  await main.set('system'); assert.equal(models.snapshot.mode,'system'); assert.equal(models.snapshot.locale,'zh-CN'); assert.equal(models.snapshot.resolvedLocale,'en-US');
  assert.equal(writes.length,2); [main,models,later].forEach(client=>client.stop()); assert.equal(sinks.size,0);
});
test('a language write failure keeps the last native state', async () => {
  let changed=0;
  const client=createLocaleClient({initial:manual('en-US',1),read:async()=>manual('en-US',1),subscribe:async()=>()=>{},changed(){changed++;},write:async()=>{throw new Error('disk full');}});
  await client.start(); await assert.rejects(client.set('zh-CN'),/disk full/);
  assert.equal(client.snapshot.locale,'en-US'); assert.equal(changed,0); client.stop();
});
test('a window disposed while subscribing removes its late native listener', async () => {
  const subscription=deferred(); let removed=0; let reads=0;
  const client=createLocaleClient({initial:defaultSnapshot(),read(){reads++;},write(){},subscribe:()=>subscription.promise,changed(){}});
  const start=client.start(); client.stop(); subscription.resolve(()=>{removed++;}); await start;
  assert.equal(removed,1); assert.equal(reads,0);
});

function flatten(value,prefix='') {return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>typeof item==='string'?[[prefix+key,item]]:Object.entries(flatten(item,`${prefix}${key}.`))));}
const read=(locale,file)=>JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}/${file}`,import.meta.url),'utf8'));
test('all Chinese and English dictionaries have matching keys and interpolation parameters', () => {
  const files=readdirSync(new URL('../src/i18n/locales/en-US/',import.meta.url)).sort();
  assert.deepEqual(files,readdirSync(new URL('../src/i18n/locales/zh-CN/',import.meta.url)).sort());
  for(const file of files){const en=flatten(read('en-US',file)),zh=flatten(read('zh-CN',file));
    assert.deepEqual(Object.keys(en).sort(),Object.keys(zh).sort(),file);
    for(const[key,value]of Object.entries(en)){
      const params=text=>[...new Set([...text.matchAll(/\{(\w+)\}/g)].map(m=>m[1]))].sort();
      assert.deepEqual(params(value),params(zh[key]),`${file}:${key}`); assert.ok(zh[key].trim(),key);
    }
  }
});
test('migrated interface keys exist and every Vue message compiles with its parameters', () => {
  const messages={}; for(const locale of ['en-US','zh-CN'])messages[locale]=Object.assign({},...['shell.json','settings.json','llm.json'].map(file=>read(locale,file)));
  const i18n=createI18n({legacy:false,locale:'en-US',fallbackLocale:'en-US',messages});
  const definitions=flatten(messages['en-US']);
  for(const file of ['src/App.vue','src/views/SettingsView.vue','src/views/LlmSettingsView.vue']){
    const source=readFileSync(new URL(`../${file}`,import.meta.url),'utf8');
    for(const match of source.matchAll(/\bt\(['"]((?:shell|settings|llm)\.[\w.]+)['"]/g))assert.ok(Object.hasOwn(definitions,match[1]),`${file}:${match[1]}`);
  }
  for(const locale of ['en-US','zh-CN']){i18n.global.locale.value=locale;for(const[key,value]of Object.entries(flatten(messages[locale]))){
    const params=Object.fromEntries([...value.matchAll(/\{(\w+)\}/g)].map(m=>[m[1],m[1]==='count'?2:'<user-content>']));
    const text=i18n.global.t(key,params);assert.notEqual(text,key);assert.ok(!text.includes('{count}'),key);
  }}
  i18n.global.locale.value='en-US'; assert.equal(i18n.global.t('settings.installed',{count:0},0),'No plugins installed');
  assert.equal(i18n.global.t('settings.installed',{count:1},1),'1 plugin installed');
  assert.equal(i18n.global.t('settings.installed',{count:2},2),'2 plugins installed');
});
