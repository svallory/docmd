import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateScripts } from '../src/index.ts';

const config = { src: '/nonexistent-docs-root' };

test('the injected config carries autoPublish and nothing server-side', () => {
  const { bodyScriptsHtml } = generateScripts(config, {
    autoPublish: { seconds: 60, startOn: false },
    identityHeader: 'X-A',
    permissions: { admins: ['a'] },
  });
  assert.ok(bodyScriptsHtml.includes('"autoPublish":{"seconds":60,"startOn":false}'));
  for (const leak of ['admins', 'identityHeader', 'X-A']) assert.ok(!bodyScriptsHtml.includes(leak), leak);
});

test('autoPublish: false is injected as false', () => {
  const { bodyScriptsHtml } = generateScripts(config, { autoPublish: false });
  assert.ok(bodyScriptsHtml.includes('"autoPublish":false'));
});
