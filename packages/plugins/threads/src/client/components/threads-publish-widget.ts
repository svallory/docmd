import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import * as api from '../lib/api';
import { t } from '../lib/i18n';
import { createPublishTimer, widgetState, type PublishMode, type PublishTimer } from '../lib/mode';
import type { Journal } from '../../types';

const STYLE_ID = 'tc-publish-widget-styles';

const CSS = `
  threads-publish-widget {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2200;
    font-family: var(--docmd-font-family, inherit);
    font-size: 13px;
  }
  .tpw {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-end;
    padding: 8px 10px;
    border: 1px solid var(--sl-color-neutral-200, var(--docmd-border-color, currentColor));
    border-radius: 10px;
    background: var(--sl-color-neutral-0, var(--docmd-bg, canvas));
    color: var(--sl-color-neutral-900, var(--docmd-text, canvastext));
    box-shadow: var(--sl-shadow-large, none);
  }
  .tpw__row { display: flex; align-items: center; gap: 8px; }
  .tpw__pill {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--sl-color-neutral-100, var(--docmd-bg-muted, transparent));
    color: var(--sl-color-neutral-700, inherit);
    font-size: 12px;
  }
  .tpw__pill--auto { background: var(--sl-color-primary-100, transparent); color: var(--sl-color-primary-700, inherit); }
  .tpw__btn {
    border: 1px solid var(--sl-color-primary-600, currentColor);
    background: var(--sl-color-primary-600, transparent);
    color: var(--sl-color-neutral-0, inherit);
    border-radius: 6px;
    padding: 4px 12px;
    cursor: pointer;
    font: inherit;
  }
  .tpw__btn:disabled { opacity: 0.5; cursor: default; }
  .tpw__pp {
    position: relative;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tpw__ring { position: absolute; inset: 0; transform: rotate(-90deg); }
  .tpw__ring circle { fill: none; stroke-width: 2; }
  .tpw__ring-track { stroke: var(--sl-color-neutral-200, currentColor); }
  .tpw__ring-bar {
    stroke: var(--sl-color-primary-600, currentColor);
    stroke-dasharray: 75.4;
    stroke-dashoffset: 0;
    animation: tpw-countdown linear forwards;
  }
  @keyframes tpw-countdown { to { stroke-dashoffset: 75.4; } }
  .tpw__count { color: var(--sl-color-neutral-700, inherit); }
  .tpw__line { color: var(--sl-color-warning-700, inherit); font-size: 12px; }
  .tpw__line--error { color: var(--sl-color-danger-700, inherit); }
`;

@customElement('threads-publish-widget')
export class ThreadsPublishWidget extends LitElement {
  override createRenderRoot() { return this; }

  @state() private journal: Journal | null = null;
  @state() private orphanedMine = 0;
  @state() private publishing = false;
  @state() private error: string | null = null;
  @state() private remaining: number | null = null;
  /** Elapsed ms of the countdown when the ring was created; frozen per updatedAt so re-renders keep the style identical. */
  private ringDelay = 0;
  private ringKey: string | null = null;

  private timer: PublishTimer | null = null;

  /** generateScripts always injects it; a missing value means no config, so collect-only. */
  private get autoPublish(): false | { seconds: number; startOn: boolean } {
    const cfg = (window as any).__threads_config?.autoPublish;
    return cfg && typeof cfg === 'object' ? cfg : false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const ap = this.autoPublish;
    if (ap) {
      this.timer = createPublishTimer({
        seconds: ap.seconds,
        now: () => Date.now(),
        schedule: (cb, ms) => {
          const id = window.setTimeout(cb, ms);
          return () => window.clearTimeout(id);
        },
      });
      this.timer.onFire(() => {
        // Fired: nothing is scheduled until the next edit, so the ring must go.
        this.remaining = null;
        void this.publish();
      });
    }
    // The owner (threads-app) calls refresh() on load and after every mutation.
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.timer?.stop();
  }

  /** Re-read the caller's journal; the count is always `journal.ops.length`. */
  async refresh(): Promise<void> {
    try {
      const me = await api.whoami();
      this.journal = me.journal;
      this.error = null;
      this.orphanedMine = me.orphanedMine;
    } catch (err) {
      console.error('[threads] whoami failed:', err);
      this.error = err instanceof api.ThreadsClientError ? err.text : t('loadFailed');
      return;
    }
    this.syncTimer();
  }

  private get mode(): PublishMode {
    return this.journal?.mode ?? 'collect';
  }

  private get pendingCount(): number {
    return this.journal?.ops.length ?? 0;
  }

  private get loaded(): boolean {
    return this.journal !== null;
  }

  private syncTimer(): void {
    if (!this.timer || !this.journal) return;
    this.timer.update({ mode: this.mode, updatedAt: this.journal.review.updatedAt, pendingCount: this.pendingCount });
    this.remaining = this.timer.remainingMs();
    const key = this.journal.review.updatedAt;
    // No ring while unarmed (collect, paused, fired): the next one is created fresh and re-measured.
    if (this.remaining === null) this.ringKey = null;
    else if (key !== this.ringKey) {
      this.ringKey = key;
      this.ringDelay = Math.max(0, this.timer.totalMs() - this.remaining);
    }
  }

  private async publish(): Promise<void> {
    if (this.publishing || this.pendingCount < 1) return;
    this.publishing = true;
    this.error = null;
    try {
      const result = await api.publishReview();
      await this.refresh();
      if (result.skipped.length > 0) {
        const n = result.skipped.length;
        const skipped = t(n === 1 ? 'skippedOpsOne' : 'skippedOps').replace('{n}', String(n));
        // A failed refresh left a stale count on screen; keep its error beside the skipped line.
        this.error = this.error ? `${this.error}. ${skipped}` : skipped;
      }
    } catch (err) {
      this.error = err instanceof api.ThreadsClientError ? err.text : t('publishFailed');
    } finally {
      this.publishing = false;
    }
  }

  private async toggleMode(): Promise<void> {
    const next: PublishMode = this.mode === 'auto' ? 'collect' : 'auto';
    try {
      this.journal = await api.setMode(next);
      this.error = null;
    } catch (err) {
      this.error = err instanceof api.ThreadsClientError ? err.text : t('modeFailed');
      return;
    }
    this.syncTimer();
  }

  override render() {
    const ap = this.autoPublish;
    const s = widgetState({
      autoPublish: ap !== false,
      mode: this.mode,
      pendingCount: this.loaded ? this.pendingCount : null,
      orphanedMine: this.orphanedMine,
      publishing: this.publishing,
      armed: this.remaining !== null,
      error: this.error,
      t,
    });
    const auto = s.variant === 'auto';
    const total = (ap ? ap.seconds : 0) * 1000;
    return html`
      <div class="tpw" data-variant=${s.variant}>
        <div class="tpw__row">
          ${auto ? html`<span class="tpw__pill tpw__pill--auto">${t('autoPublishing')}</span>` : nothing}
          <span class="tpw__count" data-testid="tpw-count">${s.label}</span>
          ${s.showPlayPause ? html`
            <button class="tpw__pp" data-testid="tpw-playpause" data-mode=${this.mode} title=${t(s.playPauseAction)}
              aria-label=${t(s.playPauseAction)} @click=${() => void this.toggleMode()}>
              <svg class="tpw__ring" viewBox="0 0 28 28" aria-hidden="true">
                <circle class="tpw__ring-track" cx="14" cy="14" r="12"></circle>
                ${s.ringRunning && this.journal ? keyed(this.journal.review.updatedAt, html`
                  <circle class="tpw__ring-bar" cx="14" cy="14" r="12"
                    style="animation-duration:${total}ms;animation-delay:-${this.ringDelay}ms"></circle>`) : nothing}
              </svg>
              <span aria-hidden="true">${s.playPauseAction === 'pause' ? '⏸' : '▶'}</span>
            </button>` : nothing}
          <button class="tpw__btn" data-testid="tpw-publish" ?disabled=${s.publishDisabled} @click=${() => void this.publish()}>${t('publish')}</button>
        </div>
        ${s.orphanLine ? html`<div class="tpw__line" data-testid="tpw-orphan">${s.orphanLine}</div>` : nothing}
        ${s.errorLine ? html`<div class="tpw__line tpw__line--error" data-testid="tpw-error">${s.errorLine}</div>` : nothing}
      </div>
    `;
  }
}
