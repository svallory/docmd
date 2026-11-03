import { ThreadsError } from './errors.js';

export interface ThreadsOptions {
  sidebar: boolean;
  devOnly: boolean;
  identityHeader: string | null;
  autoPublish: false | { seconds: number; startOn: boolean };
  permissions: { admins: string[]; resolve: 'anyone' | 'author' };
  limits: { maxCommentChars: number; commentsPerMinute: number };
  git: null | {
    branch: string;
    remote: string;
    skipDeployMarker: string;
    pullSeconds: number;
    committer: { name: string; email: string };
  };
}

const bad = (key: string, why: string): never => {
  throw new ThreadsError('config', `plugins.threads.${key} ${why}`);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A sub-object option: absent/undefined gives {}, anything else must be an object. */
function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  if (v === undefined) return {};
  if (!isObject(v)) bad(key, 'must be an object');
  return v as Record<string, unknown>;
}

function positiveNumber(obj: Record<string, unknown>, path: string, key: string, def: number): number {
  const v = obj[key] ?? def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) bad(`${path}.${key}`, 'must be a positive number');
  return v as number;
}

function nonEmptyString(obj: Record<string, unknown>, path: string, key: string, def?: string): string {
  const v = obj[key] ?? def;
  if (typeof v !== 'string' || !v.trim()) bad(`${path}.${key}`, 'must be a non-empty string');
  return v as string;
}

/**
 * Turn the raw `plugins.threads` value (object, `true`, or absent) into a
 * complete ThreadsOptions. Pure: no I/O.
 */
export function normalizeOptions(rawInput?: unknown): ThreadsOptions {
  if (rawInput !== undefined && rawInput !== true && rawInput !== null && !isObject(rawInput)) {
    bad('', 'must be an object');
  }
  const raw: Record<string, unknown> = isObject(rawInput) ? rawInput : {};

  let autoPublish: ThreadsOptions['autoPublish'];
  if (raw.autoPublish === false) {
    autoPublish = false;
  } else {
    const ap = section(raw, 'autoPublish');
    const startOn = ap.startOn ?? true;
    if (typeof startOn !== 'boolean') bad('autoPublish.startOn', 'must be a boolean');
    autoPublish = { seconds: positiveNumber(ap, 'autoPublish', 'seconds', 180), startOn: startOn as boolean };
  }

  const perm = section(raw, 'permissions');
  const admins = perm.admins ?? [];
  if (!Array.isArray(admins) || !admins.every((a) => typeof a === 'string')) {
    bad('permissions.admins', 'must be an array of strings');
  }
  const resolve = perm.resolve ?? 'anyone';
  if (resolve !== 'anyone' && resolve !== 'author') bad('permissions.resolve', "must be 'anyone' or 'author'");

  const lim = section(raw, 'limits');

  let git: ThreadsOptions['git'] = null;
  if (raw.git !== undefined && raw.git !== null) {
    const g = section(raw, 'git');
    const c = isObject(g.committer) ? g.committer : g.committer === undefined ? {} : bad('git.committer', 'must be an object');
    git = {
      branch: nonEmptyString(g, 'git', 'branch'),
      remote: nonEmptyString(g, 'git', 'remote', 'origin'),
      skipDeployMarker: nonEmptyString(g, 'git', 'skipDeployMarker', '[skip ci]'),
      pullSeconds: positiveNumber(g, 'git', 'pullSeconds', 60),
      committer: {
        name: nonEmptyString(c, 'git.committer', 'name', 'docmd threads'),
        email: nonEmptyString(c, 'git.committer', 'email', 'threads@docmd.invalid'),
      },
    };
  }

  const identityHeader = raw.identityHeader ?? null;
  if (identityHeader !== null && (typeof identityHeader !== 'string' || !identityHeader.trim())) {
    bad('identityHeader', 'must be a non-empty string');
  }

  return {
    sidebar: raw.sidebar === true,
    devOnly: raw.devOnly !== false,
    identityHeader: identityHeader as string | null,
    autoPublish,
    permissions: { admins: admins as string[], resolve: resolve as 'anyone' | 'author' },
    limits: {
      maxCommentChars: positiveNumber(lim, 'limits', 'maxCommentChars', 5000),
      commentsPerMinute: positiveNumber(lim, 'limits', 'commentsPerMinute', 10),
    },
    git,
  };
}
