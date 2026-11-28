import { connectionPreset } from './llm-presets.js';

export function reasoningUnavailable(connection) {
  return connectionPreset(connection ?? {})?.id === 'claude';
}
function outputTokensParameter(connection) {
  const preset = connectionPreset(connection ?? {})?.id;
  return ['deepseek', 'gemini', 'siliconflow'].includes(preset) ? 'max_tokens' : 'max_completion_tokens';
}

/** Missing metadata is unknown; an explicit empty list declares no effort levels. */
export function reasoningDiscovery(model) {
  if (!Array.isArray(model?.reasoningEfforts)) return { status: 'unknown', levels: [], defaultEffort: null };
  const levels = [...new Set(model.reasoningEfforts.filter(level => typeof level === 'string' && /^[a-z0-9_-]{1,32}$/.test(level)))].slice(0, 16);
  return {
    status: levels.length ? 'declared' : model.reasoningEfforts.length ? 'unknown' : 'unsupported',
    levels,
    defaultEffort: levels.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null,
  };
}

/** New profiles may use declared catalog values; unknown values stay disabled. */
export function reasoningConfig(connection, model) {
  if (reasoningUnavailable(connection)) return null;
  const discovery = reasoningDiscovery(model);
  if (discovery.status !== 'declared') return null;
  return {
    defaultEffort: discovery.defaultEffort,
    allowedEfforts: discovery.levels,
    chatOutputTokens: outputTokensParameter(connection),
  };
}

export function setReasoningEnabled(profile, enabled, connection, model) {
  profile.reasoning = enabled && !reasoningUnavailable(connection)
    ? reasoningConfig(connection, model) ?? { defaultEffort: null, allowedEfforts: [], chatOutputTokens: outputTokensParameter(connection) }
    : null;
}

export function applyReasoningDeclaration(profile, connection, model) {
  const declared = reasoningConfig(connection, model);
  if (!declared) return;
  if (profile.reasoning) {
    profile.reasoning.allowedEfforts = declared.allowedEfforts;
    profile.reasoning.defaultEffort = declared.defaultEffort;
  } else profile.reasoning = declared;
}

export function setAllowedEfforts(profile, value) {
  const levels = [...new Set(value.split(',').map(level => level.trim()).filter(Boolean))];
  profile.reasoning.allowedEfforts = levels;
  if (profile.reasoning.defaultEffort && !levels.includes(profile.reasoning.defaultEffort)) profile.reasoning.defaultEffort = null;
}
