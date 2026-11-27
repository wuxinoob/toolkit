import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningConfig, reasoningUnavailable, setAllowedEfforts, setReasoningEnabled } from '../src/host/llm-reasoning.js';
import { LLM_CONNECTION_PRESETS } from '../src/host/llm-presets.js';
const connection = id => ({ ...LLM_CONNECTION_PRESETS.find(p => p.id === id) });

test('reasoning profiles use declared levels and defaults without guessing model names', () => {
  assert.equal(reasoningConfig(connection('deepseek'), { id: 'reasoner' }), null);
  const config = reasoningConfig(connection('deepseek'), { reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high' });
  assert.deepEqual(config, { defaultEffort: 'high', allowedEfforts: ['low', 'high', 'max'], chatOutputTokens: 'max_tokens' });
  assert.equal(reasoningConfig(connection('openai'), { reasoningEfforts: ['low'], defaultReasoningEffort: 'medium' }).defaultEffort, null);
});

test('reasoning configuration accepts future declared levels and keeps protocol settings internal', () => {
  const config = reasoningConfig(connection('openai'), { reasoningEfforts: ['low', 'max', 'future_level', 'low', 'INVALID VALUE'] });
  assert.deepEqual(config.allowedEfforts, ['low', 'max', 'future_level']);
  assert.equal(config.chatOutputTokens, 'max_completion_tokens');
});

test('reasoning controls default to the compatible output-token field and can be disabled', () => {
  const profile = {};
  setReasoningEnabled(profile, true, connection('deepseek'));
  assert.equal(profile.reasoning.chatOutputTokens, 'max_tokens');
  profile.reasoning.defaultEffort = 'medium';
  setAllowedEfforts(profile, 'low, high');
  assert.deepEqual(profile.reasoning.allowedEfforts, ['low', 'high']);
  assert.equal(profile.reasoning.defaultEffort, 'low');
  setReasoningEnabled(profile, false, connection('deepseek')); assert.equal(profile.reasoning, null);
});

test('official Claude compatibility does not offer an ignored reasoning parameter', () => {
  assert.equal(reasoningUnavailable(connection('claude')), true);
  assert.equal(reasoningConfig(connection('claude'), { reasoningEfforts: ['high'] }), null);
  const profile = {};
  setReasoningEnabled(profile, true, connection('claude')); assert.equal(profile.reasoning, null);
});
