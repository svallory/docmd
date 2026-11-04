import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFromWhoami } from '../src/client/lib/identity.ts';
import { canShow } from '../src/client/lib/can-show.ts';
import { rows, who } from './fixtures/permissions-table.ts';

test('identityFromWhoami: header, payload, none', () => {
  const header = who('alice', { name: 'Alice', avatarUrl: 'a.png', isAdmin: true });
  assert.deepEqual(identityFromWhoami({ identity: header }), {
    mode: 'header', payload: { author: 'Alice', authorKey: 'alice', avatarUrl: 'a.png' }, isAdmin: true,
  });
  assert.deepEqual(identityFromWhoami({ identity: who('dev', { source: 'payload' }) }), { mode: 'local' });
  assert.deepEqual(identityFromWhoami({ identity: null }), { mode: 'local' });
  assert.deepEqual(identityFromWhoami(undefined), { mode: 'local' });
});

test('canShow matches the server decision table', () => {
  for (const [label, caller, action, target, resolve, allowed] of rows) {
    if (action === 'upsert-author') continue; // profile edits are not a button
    const shown = canShow(action, { callerKey: caller.key, isAdmin: caller.isAdmin, source: caller.source, resolveRule: resolve }, target);
    assert.equal(shown, allowed, label);
  }
});
