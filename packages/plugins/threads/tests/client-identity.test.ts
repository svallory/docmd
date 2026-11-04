import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFromWhoami, resolveIdentity, showContext } from '../src/client/lib/identity-mode.ts';
import { canShow, deleteCommentTarget } from '../src/client/lib/can-show.ts';
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

test('resolveIdentity: a rejected whoami (no live server) is local mode', async () => {
  assert.deepEqual(await resolveIdentity(() => Promise.reject(new Error('offline'))), { mode: 'local' });
  const header = who('alice', { name: 'Alice' });
  assert.equal((await resolveIdentity(() => Promise.resolve({ identity: header }))).mode, 'header');
});

test('showContext maps identity and injected config onto canShow', () => {
  const alice = identityFromWhoami({ identity: who('alice') });
  const root = identityFromWhoami({ identity: who('root', { isAdmin: true }) });
  const local = { mode: 'local' } as const;
  assert.deepEqual(showContext(root, { permissions: { resolve: 'author' } }, 'ignored'),
    { callerKey: 'root', isAdmin: true, source: 'header', resolveRule: 'author' });
  assert.deepEqual(showContext(alice, { permissions: { resolve: 'anyone' } }, null),
    { callerKey: 'alice', isAdmin: false, source: 'header', resolveRule: 'anyone' });
  assert.deepEqual(showContext(local, { permissions: { resolve: 'author' } }, 'me'),
    { callerKey: 'me', isAdmin: false, source: 'payload', resolveRule: 'author' });
  for (const cfg of [undefined, null, {}, { permissions: {} }, { permissions: { resolve: 'admins' } }, 'x']) {
    assert.equal(showContext(alice, cfg, null).resolveRule, 'anyone');
  }
});

test('deleteCommentTarget: an opener with replies is admin only, like the server', () => {
  const c = (id: string, authorKey: string, draft?: true) => ({ id, authorKey, draft });
  assert.deepEqual(deleteCommentTarget([c('1', 'a'), c('2', 'b')], '1'), { authorKey: null, drafted: false });
  assert.deepEqual(deleteCommentTarget([c('1', 'a'), c('2', 'b')], '2'), { authorKey: 'b', drafted: false });
  assert.deepEqual(deleteCommentTarget([c('1', 'a')], '1'), { authorKey: 'a', drafted: false });
  assert.deepEqual(deleteCommentTarget([c('1', 'a'), c('2', 'a', true)], '1'), { authorKey: 'a', drafted: false });
  assert.deepEqual(deleteCommentTarget([c('1', 'a'), c('2', 'b', true)], '2'), { authorKey: 'b', drafted: true });
});
