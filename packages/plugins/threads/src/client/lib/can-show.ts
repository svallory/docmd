/**
 * Whether the UI should offer an action. The same table as the server's `canDo`
 * (src/plugin/permissions.ts); the server stays the authority and still answers
 * `threads/forbidden`. DOM-free.
 */
export type ShowAction = 'edit-comment' | 'delete-comment' | 'delete-thread' | 'resolve-thread' | 'discard-review';

export interface ShowContext {
  callerKey: string | null;
  isAdmin: boolean;
  /** 'payload' is the local (dev) identity: never enforced, so always shown. */
  source: 'payload' | 'header';
  resolveRule: 'anyone' | 'author';
}

export interface ShowTarget {
  authorKey?: string | null;
  authorKeys?: Array<string | null | undefined>;
  threadAuthor?: string | null;
  reviewAuthor?: string | null;
  /** An op in the caller's own journal: always theirs. */
  drafted?: boolean;
}

export function canShow(action: ShowAction, ctx: ShowContext, target: ShowTarget): boolean {
  if (ctx.source === 'payload') return true;
  const mine = (key: string | null | undefined) => !!key && key === ctx.callerKey;
  if (ctx.isAdmin || target.drafted) return true;
  switch (action) {
    case 'edit-comment':
    case 'delete-comment':
      return mine(target.authorKey);
    case 'delete-thread':
      return (target.authorKeys ?? []).every(mine);
    case 'resolve-thread':
      return ctx.resolveRule === 'anyone' || mine(target.threadAuthor);
    case 'discard-review':
      return mine(target.reviewAuthor);
  }
}
