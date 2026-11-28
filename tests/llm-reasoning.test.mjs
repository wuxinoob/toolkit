import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoningDeclaration, reasoningConfig, reasoningDiscovery, reasoningUnavailable, setAllowedEfforts, setReasoningEnabled } from '../src/host/llm-reasoning.js';
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

test('missing, malformed and explicitly unavailable effort metadata remain distinct', () => {
  for (const model of [undefined, {}, { reasoningEfforts: null }, { reasoningEfforts: ['INVALID VALUE', null, {}] }]) {
    assert.equal(reasoningDiscovery(model).status, 'unknown');
    assert.equal(reasoningConfig(connection('openai'), model), null);
  }
  assert.equal(reasoningDiscovery({ reasoningEfforts: [] }).status, 'unsupported');
  assert.equal(reasoningConfig(connection('openai'), { reasoningEfforts: [] }), null);
  assert.deepEqual(reasoningDiscovery({ reasoningEfforts: ['low', 'max'], defaultReasoningEffort: 'high' }), {
    status: 'declared', levels: ['low', 'max'], defaultEffort: null,
  });
});

test('manual setup never invents levels and removing a default returns to API default', () => {
  const profile = {};
  setReasoningEnabled(profile, true, connection('deepseek'));
  assert.deepEqual(profile.reasoning.allowedEfforts, []);
  assert.equal(profile.reasoning.defaultEffort, null);
  assert.equal(profile.reasoning.chatOutputTokens, 'max_tokens');
  setAllowedEfforts(profile, 'low, medium, high');
  profile.reasoning.defaultEffort = 'medium';
  setAllowedEfforts(profile, 'low, high, low, ');
  assert.deepEqual(profile.reasoning.allowedEfforts, ['low', 'high']);
  assert.equal(profile.reasoning.defaultEffort, null);
  setReasoningEnabled(profile, false, connection('deepseek')); assert.equal(profile.reasoning, null);
});

test('discovery preserves saved choices until explicitly applied and never synthesizes none', () => {
  const profile = { reasoning: { defaultEffort: 'custom', allowedEfforts: ['custom'], chatOutputTokens: 'max_tokens' } };
  const original = structuredClone(profile);
  const model = { reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' };
  reasoningDiscovery(model); reasoningConfig(connection('deepseek'), model);
  assert.deepEqual(profile, original);
  applyReasoningDeclaration(profile, connection('openai'), model);
  assert.deepEqual(profile.reasoning, { defaultEffort: 'high', allowedEfforts: ['low', 'high'], chatOutputTokens: 'max_tokens' });
  profile.reasoning.allowedEfforts.push('manual');
  assert.deepEqual(model.reasoningEfforts, ['low', 'high']);
  setAllowedEfforts(profile, 'none, high');
  assert.deepEqual(profile.reasoning.allowedEfforts, ['none', 'high']);
  assert.deepEqual(reasoningConfig(connection('openai'), { reasoningEfforts: ['none', 'low'], defaultReasoningEffort: 'none' }).allowedEfforts, ['none', 'low']);
  const manual = structuredClone(profile);
  applyReasoningDeclaration(profile, connection('openai'), { reasoningEfforts: [] });
  assert.deepEqual(profile, manual);
});

test('official Claude compatibility does not offer an ignored reasoning parameter', () => {
  assert.equal(reasoningUnavailable(connection('claude')), true);
  assert.equal(reasoningConfig(connection('claude'), { reasoningEfforts: ['high'] }), null);
  const profile = {};
  setReasoningEnabled(profile, true, connection('claude')); assert.equal(profile.reasoning, null);
});
