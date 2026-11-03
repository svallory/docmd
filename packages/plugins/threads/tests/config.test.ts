import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions } from '../src/plugin/config.ts';
import { ThreadsError } from '../src/plugin/errors.ts';

const DEFAULTS = {
  sidebar: false,
  devOnly: true,
  identityHeader: null,
  autoPublish: { seconds: 180, startOn: true },
  permissions: { admins: [], resolve: 'anyone' },
  limits: { maxCommentChars: 5000, commentsPerMinute: 10 },
  git: null,
};

test('absent, true and empty options all normalise to the defaults', () => {
  for (const raw of [{}, undefined, true]) {
    assert.deepEqual(normalizeOptions(raw), DEFAULTS, String(raw));
  }
});

test('a partial git block gets remote, marker, pull interval and committer defaults', () => {
  assert.deepEqual(normalizeOptions({ git: { branch: 'main' } }).git, {
    branch: 'main',
    remote: 'origin',
    skipDeployMarker: '[skip ci]',
    pullSeconds: 60,
    committer: { name: 'docmd threads', email: 'threads@docmd.invalid' },
  });
});

test('autoPublish: false is accepted as-is', () => {
  assert.equal(normalizeOptions({ autoPublish: false }).autoPublish, false);
});

test('invalid shapes throw threads/config', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ git: {} }, /git\.branch/],
    [{ autoPublish: { seconds: 0 } }, /autoPublish\.seconds/],
    [{ permissions: { resolve: 'nobody' } }, /permissions\.resolve/],
    [{ limits: { maxCommentChars: -1 } }, /limits\.maxCommentChars/],
    ['nope', /^threads\/config: plugins\.threads must be an object$/],
    [{ sidebar: 'yes' }, /plugins\.threads\.sidebar/],
    [{ limits: { commentsPerMinute: 0.5 } }, /limits\.commentsPerMinute/],
  ];
  for (const [raw, naming] of cases) {
    assert.throws(
      () => normalizeOptions(raw),
      (e: unknown) =>
        e instanceof ThreadsError && e.code === 'config' && e.message.startsWith('threads/config:') && naming.test(e.message),
      JSON.stringify(raw),
    );
  }
});
