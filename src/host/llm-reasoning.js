import { connectionPreset } from './llm-presets.js';

export function reasoningUnavailable(connection) {
  return connectionPreset(connection ?? {})?.id === 'claude';
}
function outputTokensParameter(connection) {
  const preset = connectionPreset(connection ?? {})?.id;
  return ['deepseek', 'gemini', 'siliconflow'].includes(preset) ? 'max_tokens' : 'max_completion_tokens';
}

/** New profiles may use declared catalog values; unknown values stay disabled. */
export function reasoningConfig(connection, model) {
  if (reasoningUnavailable(connection)) return null;
  const levels = [...new Set((model?.reasoningEfforts ?? []).filter(level => /^[a-z0-9_-]{1,32}$/.test(level)))].slice(0, 16);
  if (!levels.length) return null;
  return {
    defaultEffort: levels.includes(model?.defaultReasoningEffort) ? model.defaultReasoningEffort : null,
    allowedEfforts: levels,
    chatOutputTokens: outputTokensParameter(connection),
  };
}

export function setReasoningEnabled(profile, enabled, connection, model) {
  profile.reasoning = enabled && !reasoningUnavailable(connection)
    ? reasoningConfig(connection, model) ?? { defaultEffort: null, allowedEfforts: ['low', 'medium', 'high'], chatOutputTokens: outputTokensParameter(connection) }
    : null;
}

export function setAllowedEfforts(profile, value) {
  const levels = value.split(',').map(level => level.trim()).filter(Boolean);
  profile.reasoning.allowedEfforts = levels;
  if (profile.reasoning.defaultEffort && !levels.includes(profile.reasoning.defaultEffort)) profile.reasoning.defaultEffort = levels[0] ?? null;
}
