import type { Caller } from '../../src/types.ts';

// The decision table shared by the server (`canDo`) and the client (`canShow`).
export type Action = 'edit-comment' | 'delete-comment' | 'delete-thread' | 'resolve-thread' | 'discard-review' | 'upsert-author';
export interface Target {
  authorKey?: string | null;
  authorKeys?: Array<string | null | undefined>;
  threadAuthor?: string | null;
  reviewAuthor?: string | null;
  drafted?: boolean;
}

export const who = (key: string, over: Partial<Caller> = {}): Caller =>
  ({ key, name: key, email: null, avatarUrl: '', source: 'header', isAdmin: false, ...over });
const ALICE = who('alice');
const BOB = who('bob');
const ROOT = who('root', { isAdmin: true });
const DEV = who('dev', { source: 'payload' });

type Row = [label: string, caller: Caller, action: Action, target: Target, resolve: 'anyone' | 'author', allowed: boolean];
export const rows: Row[] = [
  ['edit: author', ALICE, 'edit-comment', { authorKey: 'alice' }, 'anyone', true],
  ['edit: other', BOB, 'edit-comment', { authorKey: 'alice' }, 'anyone', false],
  ['edit: admin', ROOT, 'edit-comment', { authorKey: 'alice' }, 'anyone', true],
  ['delete: other', BOB, 'delete-comment', { authorKey: 'alice' }, 'anyone', false],
  ['delete: legacy comment, member', BOB, 'delete-comment', {}, 'anyone', false],
  ['delete: legacy comment, admin', ROOT, 'delete-comment', { authorKey: null }, 'anyone', true],
  ['delete: legacy comment, payload caller', DEV, 'delete-comment', {}, 'author', true],
  ['edit: drafted', BOB, 'edit-comment', { authorKey: 'alice', drafted: true }, 'anyone', true],
  ['delete-thread: owns every comment', ALICE, 'delete-thread', { authorKeys: ['alice', 'alice'] }, 'anyone', true],
  ['delete-thread: one foreign comment', ALICE, 'delete-thread', { authorKeys: ['alice', 'bob'] }, 'anyone', false],
  ['delete-thread: one legacy comment', ALICE, 'delete-thread', { authorKeys: ['alice', undefined] }, 'anyone', false],
  ['delete-thread: admin', ROOT, 'delete-thread', { authorKeys: ['alice', 'bob'] }, 'anyone', true],
  ['resolve anyone: stranger', BOB, 'resolve-thread', { threadAuthor: 'alice' }, 'anyone', true],
  ['resolve author: stranger', BOB, 'resolve-thread', { threadAuthor: 'alice' }, 'author', false],
  ['resolve author: thread author', ALICE, 'resolve-thread', { threadAuthor: 'alice' }, 'author', true],
  ['resolve author: admin', ROOT, 'resolve-thread', { threadAuthor: 'alice' }, 'author', true],
  ['resolve author: legacy thread', BOB, 'resolve-thread', {}, 'author', false],
  ['resolve author: drafted thread', BOB, 'resolve-thread', { drafted: true }, 'author', true],
  ['discard: other', BOB, 'discard-review', { reviewAuthor: 'alice' }, 'anyone', false],
  ['discard: author', ALICE, 'discard-review', { reviewAuthor: 'alice' }, 'anyone', true],
  ['discard: admin', ROOT, 'discard-review', { reviewAuthor: 'alice' }, 'anyone', true],
  ['upsert: own key', ALICE, 'upsert-author', { authorKey: 'alice' }, 'anyone', true],
  ['upsert: no key', ALICE, 'upsert-author', {}, 'anyone', true],
  ['upsert: another key', BOB, 'upsert-author', { authorKey: 'alice' }, 'anyone', false],
  ['upsert: admin cannot write another key', ROOT, 'upsert-author', { authorKey: 'alice' }, 'anyone', false],
  ['payload caller is never enforced', DEV, 'discard-review', { reviewAuthor: 'alice' }, 'author', true],
];

