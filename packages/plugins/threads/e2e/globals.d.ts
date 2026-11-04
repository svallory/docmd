/**
 * Global type declarations for the docmd browser runtime,
 * used in Playwright page.evaluate() contexts.
 */

declare const docmd: {
  isLive?: () => boolean;
  call: (action: string, payload: Record<string, unknown>) => Promise<any>;
};