# 插件数据接口类型

`index.d.ts` 描述主窗口 ctx 和插件窗口 bridge 共用的 binary、fs、screen、llm 数据接口。可在插件的 TypeScript 项目中导入 PluginDataApi，或在 JavaScript 中通过 JSDoc 标注注入参数；不需要运行时 import 宿主模块。UI/窗口操作仍见 [插件 API](../../docs/plugin-dev/api.md)。

```ts
import type { PluginDataApi } from './path/to/toolkit/sdk/types';
export async function useModel(ctx: PluginDataApi) {
  const profiles = await ctx.llm.profiles();
  return ctx.llm.generate({ profile: profiles[0].id,
    messages: [{role:'user',content:[{type:'text',text:'hello'}]}] });
}
```

字段定义在 sdk/contracts.json，生成声明运行 `node scripts/generate-api-types.mjs`。`schema.contracts` 公布同一组定义；每个 action 的 params/result 使用 $defs 引用，WebView 的 fs 选项在 webview 下，不表示存在 fs RPC 服务。定义只覆盖显式列出的动作，平台、单位、跨字段约束和资源生命周期见接口文档。`tests/api-contracts.test.mjs` 验证生成结果及正反 TypeScript 示例。
