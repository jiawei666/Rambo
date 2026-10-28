import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/main/bot-secret-tools.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;

async function withModule(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rambo-bot-secrets-test-'));
  const modulePath = join(directory, 'bot-secret-tools.mjs');
  writeFileSync(modulePath, compiled, { mode: 0o600 });
  try {
    const module = await import(`${pathToFileURL(modulePath).href}?${Date.now()}-${Math.random()}`);
    await run(module, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('secret tool inputs reject unknown fields and unsafe command mappings', async () => {
  await withModule(async ({
    BotSecretInputError,
    normalizeCapturedSecretValue,
    normalizeListSecretsInput,
    normalizeRunWithSecretInput,
    normalizeSaveSecretInput
  }) => {
    assert.deepEqual(normalizeSaveSecretInput({
      name: ' GitHub Token ',
      description: ' 发布脚本 ',
      scope: 'bot'
    }), {
      name: 'GitHub Token',
      description: '发布脚本',
      scope: 'bot'
    });
    assert.throws(() => normalizeSaveSecretInput({
      name: 'Token', scope: 'global', secret: 'must-not-enter-model', bot_id: 'other'
    }), BotSecretInputError);
    assert.equal(normalizeCapturedSecretValue('  exact secret  '), '  exact secret  ');
    assert.doesNotThrow(() => normalizeListSecretsInput({}));
    assert.throws(() => normalizeListSecretsInput({ scope: 'global' }), /不支持/u);
    assert.throws(() => normalizeRunWithSecretInput({
      command: 'node',
      secret_env: [{ secret_id: '00000000-0000-4000-8000-000000000000', env_name: 'BAD-NAME' }]
    }), /环境变量名无效/u);
    assert.throws(() => normalizeRunWithSecretInput({
      command: 'node',
      secret_env: [
        { secret_id: '00000000-0000-4000-8000-000000000000', env_name: 'TOKEN' },
        { secret_id: '00000000-0000-4000-8000-000000000000', env_name: 'OTHER' }
      ]
    }), /不能.*重复/u);
  });
});

test('secret redaction covers raw, JSON, URL, base64, base64url, and hex variants', async () => {
  await withModule(async ({ redactSecretValues }) => {
    const secret = 'a/b "token"\nvalue';
    const encoded = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(secret).toString('hex')
    ].join('\n');
    const redacted = redactSecretValues(encoded, [secret]);
    assert.equal(redacted.includes(secret), false);
    assert.equal(redacted.includes(Buffer.from(secret).toString('base64')), false);
    assert.equal(redacted.match(/\[已隐藏\]/gu)?.length, 6);
  });
});

test('runSecretCommand injects only selected secrets and does not invoke a shell', async () => {
  await withModule(async ({ runSecretCommand }, directory) => {
    const previousParentSecret = process.env.RAMBO_PARENT_SECRET;
    process.env.RAMBO_PARENT_SECRET = 'must-not-inherit';
    try {
      const result = await runSecretCommand({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(`${process.env.RAMBO_SELECTED_SECRET ?? ""}|${process.env.RAMBO_PARENT_SECRET ?? ""}`)'
        ],
        cwd: directory,
        env: { RAMBO_SELECTED_SECRET: 'selected-secret' },
        timeoutMs: 5_000
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, 'selected-secret|');
      assert.equal(result.timedOut, false);

      const literal = await runSecretCommand({
        command: '/bin/echo',
        args: ['$RAMBO_SELECTED_SECRET'],
        cwd: directory,
        env: { RAMBO_SELECTED_SECRET: 'selected-secret' },
        timeoutMs: 5_000
      });
      assert.equal(literal.stdout.trim(), '$RAMBO_SELECTED_SECRET');
    } finally {
      if (previousParentSecret === undefined) delete process.env.RAMBO_PARENT_SECRET;
      else process.env.RAMBO_PARENT_SECRET = previousParentSecret;
    }
  });
});

test('runSecretCommand returns a timed-out process result within the configured limit', async () => {
  await withModule(async ({ runSecretCommand }, directory) => {
    const started = Date.now();
    const result = await runSecretCommand({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      cwd: directory,
      env: {},
      timeoutMs: 250
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 3_000);
  });
});

