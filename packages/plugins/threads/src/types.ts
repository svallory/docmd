export interface Author {
  name: string;
  avatarUrl: string;
}

export interface AuthorsMap {
  [key: string]: Author;
}

export interface Thread {
  id: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  comments: Comment[];
  anchor?: { quote: string };
  /** Set by the overlay: this thread exists only in the caller's draft journal. */
  draft?: true;
  /** Set on read: the anchor quote has no `==...=={id}` mark in the page body any more. */
  orphaned?: true;
}

export interface Comment {
  id: string;
  thread_id: string;
  parent_id: string | null;
  author: string;
  date: string;
  edited_at: string | null;
  authorKey?: string;
  reviewId?: string;
  body: string;
  reactions: Reaction[];
  /** Set by the overlay: this comment exists only in the caller's draft journal. */
  draft?: true;
}

export interface Reaction {
  emoji: string;
  authors: string[];
}

export interface Anchor {
  quote: string;
  prefix: string | null;
  suffix: string | null;
  selector: string | null;
  offset: number | null;
  blockText: string | null;
}

export interface CreateThreadPayload {
  file: string;
  anchor: Anchor | null;
  author: string;
  body: string;
}

export interface AddCommentPayload {
  file: string;
  threadId: string;
  parentId?: string | null;
  author: string;
  body: string;
}

export interface EditCommentPayload {
  file: string;
  threadId: string;
  commentId: string;
  body: string;
}

export interface DeleteCommentPayload {
  file: string;
  threadId: string;
  commentId: string;
}

export interface ResolveThreadPayload {
  file: string;
  threadId: string;
  resolved_by: string;
}

export interface ToggleReactionPayload {
  file: string;
  threadId: string;
  commentId: string;
  emoji: string;
  author: string;
}

export type DraftMode = 'auto' | 'collect';

export type DraftOp =
  | { kind: 'add-thread'; opId: string; at: string; file: string; threadId: string; commentId: string; anchor: Anchor | null; body: string }
  | { kind: 'add-comment'; opId: string; at: string; file: string; threadId: string; commentId: string; parentId: string | null; body: string }
  | { kind: 'edit-comment'; opId: string; at: string; file: string; threadId: string; commentId: string; body: string }
  | { kind: 'delete-comment'; opId: string; at: string; file: string; threadId: string; commentId: string }
  | { kind: 'delete-thread'; opId: string; at: string; file: string; threadId: string }
  | { kind: 'resolve-thread'; opId: string; at: string; file: string; threadId: string }
  | { kind: 'toggle-reaction'; opId: string; at: string; file: string; threadId: string; commentId: string; emoji: string };

/** A DraftOp as the caller supplies it: the store assigns `opId` and `at`. */
export type NewDraftOp = DraftOp extends infer O ? (O extends DraftOp ? Omit<O, 'opId' | 'at'> : never) : never;

/** One user's private, unpublished changes (`<docsRoot>/.threads/drafts/<slug>.json`). */
export interface Journal {
  version: 1;
  authorKey: string;
  mode: DraftMode;
  review: { id: string; title: string | null; summary: string | null; createdAt: string; updatedAt: string };
  ops: DraftOp[];
}

/** Who is making a call. */
export interface Caller {
  key: string;
  name: string;
  email: string | null;
  avatarUrl: string;
  source: 'payload' | 'header';
}

export interface WhoAmI {
  identity: Caller | null;
  journal: Journal | null;
  /** Published threads started by the caller whose anchor text is gone from the page. */
  orphanedMine: number;
}

/** An applied op as the manifest records it; `before` is what discard needs to reverse it. */
export type ManifestOp = DraftOp & { before?: unknown; quote?: string; pageTitle?: string };

/** `<docsRoot>/.threads/reviews/<reviewId>.json` (committed). */
export interface ReviewManifest {
  version: 1;
  id: string;
  authorKey: string;
  authorName: string;
  title: string;
  summary: string | null;
  state: 'published' | 'discarded';
  publishedAt: string;
  discardedAt?: string;
  discardedBy?: string;
  ops: ManifestOp[];
  skipped: Array<{ opId: string; reason: string }>;
}

/** What the reviews panel lists: a projection of the manifest. */
export interface ReviewSummary {
  id: string;
  authorKey: string;
  authorName: string;
  title: string;
  publishedAt: string;
  state: 'published' | 'discarded';
  ops: Array<{ file: string; threadId: string; quote: string | null; pageTitle: string | null }>;
}

export interface PublishResult {
  reviewId: string;
  skipped: Array<{ opId: string; reason: string }>;
}
