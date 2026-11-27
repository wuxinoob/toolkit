// Official endpoint references and compatibility notes: docs/LLM.md.
// These are connection defaults; model IDs stay user-configurable.
export const LLM_CONNECTION_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    note: 'Uses the OpenAI-compatible Chat Completions API. Enter a model ID available in your DeepSeek account.',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    note: 'Uses the Responses API. Enter a model ID available in your OpenAI API project.',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    adapter: 'openai-chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    note: 'Uses the official OpenAI-compatible endpoint with a Gemini API key from Google AI Studio.',
  },
  {
    id: 'claude',
    name: 'Claude',
    adapter: 'openai-chat',
    baseUrl: 'https://api.anthropic.com/v1',
    note: 'Uses the official OpenAI-compatible endpoint with a workspace-scoped API key from Claude Console.',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    adapter: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    note: 'Uses the SiliconFlow China endpoint. Enter the full model ID from your platform console, including its provider prefix.',
  },
];

export function connectionPreset(connection) {
  return LLM_CONNECTION_PRESETS.find(preset =>
    preset.adapter === connection.adapter &&
    preset.baseUrl === connection.baseUrl.replace(/\/+$/, ''),
  );
}
