import type { PluginDataApi, ModelRequest } from '../../sdk/types/index';
declare const ctx: PluginDataApi;
const request: ModelRequest = { messages: [{role:'user',content:[{type:'text',text:'hello'}]}], reasoningEffort:'low' };
void ctx.llm.generate(request);
async function screenshot() {
  const capture = await ctx.screen.captureResource({target:{kind:'desktop'},rect:{x:-100,y:0,width:200,height:100},includeInfo:true});
  const ticket = await ctx.binary.export(capture.source.id,{to:'window:main'});
  const imported = await ctx.binary.import(ticket);
  await imported.read(0);
  await imported.close();
  // @ts-expect-error imported immutable resources expose no write method
  await imported.write(0,new Uint8Array());
}
// @ts-expect-error this is not an LLM role
void ctx.llm.generate({messages:[{role:'admin',content:[]}]});
// @ts-expect-error image blocks require a resource source
void ctx.llm.generate({messages:[{role:'user',content:[{type:'image'}]}]});
void screenshot;
