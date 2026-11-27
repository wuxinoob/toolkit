import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: () => null };
let invokeImpl;
globalThis.window = { __TAURI_INTERNALS__: { invoke: (cmd, args) => invokeImpl(cmd, args) } };
const { createPluginSdk } = await import('../src/host/plugin-sdk.js');
const { Disposer } = await import('../src/host/disposer.js');
const permissions = ['rpc:screen', 'rpc:binary'];
const reply = (args, p) => ({ v: 1, kind: 'res', id: args.msg.id, p });

test('closed screenshot resources do not accumulate cleanup callbacks', async () => {
  let sequence = 0, sweeps = 0;
  invokeImpl = async (cmd, args) => {
    if (args.msg.act === 'capture_resource') return reply(args, { kind: 'resource', id: `capture-${++sequence}`, size: 100 });
    if (args.msg.act === 'close_all') sweeps++;
    return reply(args, true);
  };
  const disposer = new Disposer();
  const sdk = createPluginSdk('test.resources', { permissions }, disposer);
  for (let i = 0; i < 100; i++) {
    const resource = await sdk.screen.captureResource();
    await sdk.binary.close(resource.id);
  }
  assert.equal(disposer.fns.length, 1);
  await disposer.run();
  assert.equal(sweeps, 1);
});

test('a screenshot completing after disposal is closed and cannot escape its scope', async () => {
  let complete;
  const closed = [];
  invokeImpl = async (cmd, args) => {
    if (args.msg.act === 'capture_resource') return new Promise(resolve => complete = () => resolve(reply(args, { source: { id: 'late' }, capture: {} })));
    if (args.msg.act === 'close') closed.push(args.msg.p.id);
    return reply(args, true);
  };
  const disposer = new Disposer();
  const sdk = createPluginSdk('test.resources', { permissions }, disposer);
  const pending = sdk.screen.captureResource({ includeInfo: true });
  const rejected = assert.rejects(pending, error => error.code === 'not_found');
  await disposer.run();
  complete();
  await rejected;
  assert.deepEqual(closed, ['late']);
});

test('resource tickets use native recipient identities and imported handles read through raw IPC', async () => {
  const calls=[];
  invokeImpl=async(cmd,args)=>{
    calls.push({cmd,args});
    if(cmd==='plugin_binary_read') return new Uint8Array([42,43]).buffer;
    if(cmd==='plugin_binary_control') return true;
    const results={identity:{owner:'window:main'},export:{token:'ticket',to:'sidecar:worker',expiresInMs:30000},import:{source:{kind:'resource',id:'shared',size:2},maxChunkBytes:262144},revoke:true,close_all:null};
    return reply(args,results[args.msg.act]);
  };
  const scope=new Disposer();
  const sdk=createPluginSdk('test.exchange',{permissions:['rpc:binary']},scope);
  assert.equal((await sdk.binary.identity()).owner,'window:main');
  const ticket=await sdk.binary.export('original',{to:'sidecar:worker'});
  const imported=await sdk.binary.import(ticket);
  assert.deepEqual([...await imported.read(0,2)],[42,43]);
  assert.equal(imported.source.id,'shared');
  assert.deepEqual(calls.find(call=>call.args.msg?.act==='export').args.msg.p,{id:'original',to:'sidecar:worker'});
  await imported.close();
  assert.equal(await sdk.binary.revoke(ticket),true);
  await scope.run();
});
