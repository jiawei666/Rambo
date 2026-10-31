import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const contractsSource = readFileSync(
  new URL('../../src/shared/contracts.ts', import.meta.url),
  'utf8'
);
const source = readFileSync(
  new URL('../../src/shared/voice-support.ts', import.meta.url),
  'utf8'
);
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const compiledContracts = ts.transpileModule(contractsSource, { compilerOptions }).outputText;
const compiled = ts.transpileModule(source, { compilerOptions }).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  compiled.replace(
    "from './contracts'",
    `data:text/javascript;base64,${Buffer.from(compiledContracts).toString('base64')}`
  )
).toString('base64')}`;
const module = await import(moduleUrl);

test('Voice preflight allows ChatGPT and the official OpenAI API endpoint', () => {
  assert.equal(module.voiceModelPreflightError({
    kind: 'chatgpt',
    manual: { serviceName: '', baseUrl: '', model: '' }
  }), null);
  assert.equal(module.voiceModelPreflightError({
    kind: 'local',
    manual: { serviceName: '', baseUrl: '', model: '' }
  }), null);
  assert.equal(module.voiceModelPreflightError({
    kind: 'manualApi',
    manual: {
      serviceName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5'
    }
  }), null);
});

test('Voice preflight rejects a third-party manual API with an actionable message', () => {
  const message = module.voiceModelPreflightError({
    kind: 'manualApi',
    manual: {
      serviceName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash'
    }
  });
  assert.equal(
    message,
    '语音模型不支持：“DeepSeek”未提供 Codex Live 所需的实时语音通道。请在“设置 → 账号 → 模型配置”切换为 ChatGPT 登录后再试。'
  );
});

test('Voice preflight rejects malformed or non-OpenAI manual endpoints', () => {
  for (const baseUrl of ['', 'not-a-url', 'http://api.openai.com/v1', 'https://api.openai.com.evil.test/v1']) {
    assert.match(module.voiceModelPreflightError({
      kind: 'manualApi',
      manual: { serviceName: '', baseUrl, model: 'model' }
    }) ?? '', /^语音模型不支持：/u);
  }
});
