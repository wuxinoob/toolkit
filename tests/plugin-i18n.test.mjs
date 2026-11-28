import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginSdk} from '../src/host/plugin-sdk.js';
import {Disposer} from '../src/host/disposer.js';
import {acceptLocaleSnapshot} from '../src/i18n/state.js';
import {manifestText,translate} from '../src/i18n/messages.js';
let revision=10;
const snapshot=(resolvedLocale,locale=resolvedLocale)=>({mode:'manual',locale,resolvedLocale,revision:++revision});
const messages={'en-US':{'title':'My tool','hello':'Hello {name}'},'zh-CN':{'title':'我的工具','hello':'你好 {name}'}};
const manifest={id:'checks.i18n',name:'Legacy name',nameKey:'title',permissions:['rpc:i18n'],i18n:{messages}};
let invoke;
globalThis.window={__TAURI_INTERNALS__:{invoke:(cmd,args)=>invoke(cmd,args)}};
const reply=(args,value)=>({v:1,kind:'res',id:args.msg.id,p:value});

test('plugin i18n reads native metadata through the gateway and uses the resolved language',async()=>{
  const calls=[];invoke=async(cmd,args)=>{calls.push({cmd,args});return reply(args,snapshot('zh-CN','en-US'));};
  const scope=new Disposer(),api=createPluginSdk(manifest.id,manifest,scope).i18n;
  const result=await api.get();
  assert.equal(result.locale,'en-US');assert.equal(result.resolvedLocale,'zh-CN');assert.equal(api.resolvedLocale,'zh-CN');
  assert.equal(api.t('hello',{name:'<user text>'}),'你好 <user text>');
  assert.equal(calls[0].cmd,'plugin_rpc');assert.equal(calls[0].args.msg.svc,'i18n');assert.equal(calls[0].args.msg.act,'get');
  assert.equal(api.set,undefined);assert.ok(Object.isFrozen(result));await scope.run();
});
test('plugin dictionaries and metadata fall back without changing the manifest',()=>{
  const original=JSON.stringify(manifest);
  assert.equal(manifestText(manifest,'title','zh-CN',manifest.name),'我的工具');
  assert.equal(manifestText(manifest,'missing','zh-CN',manifest.name),'Legacy name');
  assert.equal(translate(messages,'de-DE','title'),'My tool');
  assert.equal(translate({'zh':{'key':'基础语言'}},'zh-CN','key'),'基础语言');
  assert.equal(translate(messages,'en-US','missing'),'missing');
  assert.equal(translate(messages,'en-US','hello'),'Hello {name}');assert.equal(JSON.stringify(manifest),original);
});
test('plugin i18n updates translators in place and retains a single scope cleanup across subscriptions',async()=>{
  acceptLocaleSnapshot(snapshot('en-US'));
  const scope=new Disposer(),api=createPluginSdk(manifest.id,manifest,scope).i18n;
  const t=api.createTranslator(messages);let delivered=0;
  for(let i=0;i<100;i++)api.onChange(()=>delivered++)();
  const off=api.onChange(()=>delivered++);
  acceptLocaleSnapshot(snapshot('zh-CN'));assert.equal(delivered,1);assert.equal(t('title'),'我的工具');assert.equal(scope.fns.length,1);
  off();acceptLocaleSnapshot(snapshot('en-US'));assert.equal(delivered,1);
  api.onChange(()=>delivered++);await scope.run();acceptLocaleSnapshot(snapshot('zh-CN'));assert.equal(delivered,1);
  assert.throws(()=>api.onChange(()=>{}),error=>error.code==='not_found');
});
test('plugin i18n rejects missing grants and late replies after disposal',async()=>{
  let calls=0;invoke=async(cmd,args)=>{calls++;return reply(args,snapshot('en-US'));};
  const missing=createPluginSdk('missing',{permissions:[]},new Disposer()).i18n;
  await assert.rejects(missing.get(),error=>error.code==='denied');assert.throws(()=>missing.t('title'),error=>error.code==='denied');assert.equal(calls,0);
  let finish;invoke=(cmd,args)=>new Promise(resolve=>{finish=()=>resolve(reply(args,snapshot('en-US')));});
  const scope=new Disposer(),api=createPluginSdk(manifest.id,manifest,scope).i18n;
  let delivered=0;api.onChange(()=>delivered++);const pending=api.get();const rejected=assert.rejects(pending,error=>error.code==='not_found');
  await scope.run();finish();await rejected;assert.equal(delivered,0);
});
test('a stale i18n read cannot undo a newer native event',async()=>{
  let finish;invoke=(cmd,args)=>new Promise(resolve=>{const old=snapshot('en-US');finish=()=>resolve(reply(args,old));});
  const scope=new Disposer(),api=createPluginSdk(manifest.id,manifest,scope).i18n;
  const pending=api.get();const latest=snapshot('zh-CN');acceptLocaleSnapshot(latest);finish();
  const result=await pending;assert.equal(result.revision,latest.revision);assert.equal(result.resolvedLocale,'zh-CN');await scope.run();
});
test('plugin language callback failures are isolated, including rejected async callbacks',async t=>{
  const failures=[];t.mock.method(console,'error',(...args)=>failures.push(args));
  const scope=new Disposer(),api=createPluginSdk(manifest.id,manifest,scope).i18n;
  let delivered=0;
  api.onChange(()=>{throw new Error('sync callback');});
  api.onChange(async()=>{throw new Error('async callback');});
  api.onChange(()=>delivered++);
  acceptLocaleSnapshot(snapshot('en-US'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered,1);assert.equal(failures.length,2);await scope.run();
});
test('a malformed native locale reply is rejected instead of being reported as the cached language',async()=>{
  invoke=async(cmd,args)=>reply(args,{resolvedLocale:'zh-CN'});
  const scope=new Disposer(),api=createPluginSdk(manifest.id,manifest,scope).i18n;
  await assert.rejects(api.get(),error=>error.code==='protocol');await scope.run();
});
