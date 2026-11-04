import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { t } from '../lib/i18n';
import * as api from '../lib/api';
import { canShowFor } from '../lib/identity';
import { siteFromPage, sortReviews, threadHref } from '../lib/reviews-view';
import type { Journal, ReviewSummary } from '../../types';

import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/dialog/dialog.js';

/** The Reviews tab: published reviews newest first, Discard behind a dialog, the open review's title form. */
@customElement('threads-reviews-panel')
export class ThreadsReviewsPanel extends LitElement {
  override createRenderRoot() { return this; }

  @state() private reviews: ReviewSummary[] = [];
  @state() private journal: Journal | null = null;
  @state() private error: string | null = null;
  @state() private discardId: string | null = null;
  @state() private saving = false;
  @state() private draftTitle = '';
  @state() private draftSummary = '';

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const [reviews, me] = await Promise.all([api.listReviews(), api.whoami()]);
      this.reviews = sortReviews(reviews);
      const prev = this.journal;
      this.journal = me.journal;
      // Keep what the user is typing; reload the fields only when the open review changed.
      if (me.journal && me.journal.review.id !== prev?.review.id) {
        this.draftTitle = me.journal.review.title ?? '';
        this.draftSummary = me.journal.review.summary ?? '';
      }
      this.error = null;
    } catch (err) {
      console.error('[threads] reviews load failed:', err);
      this.error = err instanceof api.ThreadsClientError ? err.text : t('loadFailed');
    }
  }

  private get dialog(): (HTMLElement & { open: boolean }) | null {
    return this.querySelector('[data-testid="discard-dialog"]');
  }

  private askDiscard(id: string): void {
    this.discardId = id;
    const d = this.dialog;
    if (d) d.open = true;
  }

  private cancelDiscard(): void {
    this.discardId = null;
    const d = this.dialog;
    if (d) d.open = false;
  }

  private async confirmDiscard(): Promise<void> {
    const id = this.discardId;
    this.cancelDiscard();
    if (!id) return;
    try {
      await api.discardReview(id);
    } catch (err) {
      this.error = err instanceof api.ThreadsClientError ? err.text : t('discardFailed');
      return;
    }
    // A host that handles the event (and refreshes us as part of it) cancels it; otherwise refresh here.
    const unhandled = this.dispatchEvent(new CustomEvent('reviews-changed', { bubbles: true, composed: true, cancelable: true }));
    if (unhandled) await this.refresh();
  }

  private async save(e: Event): Promise<void> {
    e.preventDefault();
    this.saving = true;
    try {
      this.journal = await api.updateReview({ title: this.draftTitle.trim() || null, summary: this.draftSummary.trim() || null });
      this.error = null;
    } catch (err) {
      this.error = err instanceof api.ThreadsClientError ? err.text : t('saveFailed');
    } finally {
      this.saving = false;
    }
  }

  /** The link already points at the open URL: the browser would do nothing, so ask the host to reveal the thread. */
  private onOpClick(e: Event): void {
    const a = e.currentTarget as HTMLAnchorElement;
    const url = new URL(a.href, location.href);
    if (url.pathname !== location.pathname || url.hash !== location.hash) return;
    // The host cancels the event when it reveals the thread; without a host the link keeps its default.
    const handled = !this.dispatchEvent(new CustomEvent('reveal-thread', { bubbles: true, composed: true, cancelable: true }));
    if (handled) e.preventDefault();
  }

  private renderForm() {
    if (!this.journal) return nothing;
    return html`
      <form class="tc-reviews__form" data-testid="review-form" @submit=${(e: Event) => void this.save(e)}>
        <div class="tc-reviews__form-title">${t('openReview')}</div>
        <input class="tc-reviews__input" data-testid="review-title" type="text" placeholder=${t('reviewTitle')}
          aria-label=${t('reviewTitle')} .value=${this.draftTitle}
          @input=${(e: Event) => { this.draftTitle = (e.target as HTMLInputElement).value; }} />
        <textarea class="tc-reviews__input" data-testid="review-summary" rows="3" placeholder=${t('reviewSummary')}
          aria-label=${t('reviewSummary')} .value=${this.draftSummary}
          @input=${(e: Event) => { this.draftSummary = (e.target as HTMLTextAreaElement).value; }}></textarea>
        <sl-button size="small" variant="neutral" type="submit" data-testid="review-save" ?disabled=${this.saving}>${t('save')}</sl-button>
      </form>`;
  }

  private renderReview(r: ReviewSummary, site: { siteBase: string; srcRoot: string }) {
    const discarded = r.state === 'discarded';
    return html`
      <div class="tc-review ${discarded ? 'tc-review--discarded' : ''}" data-testid="review" data-review-id=${r.id} data-state=${r.state}>
        <div class="tc-review__head">
          <span class="tc-review__title">${r.title || r.id}</span>
          <span class="tc-review__badge" data-testid="review-state">${discarded ? t('discarded') : t('published')}</span>
        </div>
        <div class="tc-review__meta">${r.authorName} · ${new Date(r.publishedAt).toLocaleDateString()}</div>
        <ul class="tc-review__ops">
          ${r.ops.map(op => html`
            <li><a class="tc-review__link" data-testid="review-op"
              href=${threadHref(op.file, op.threadId, site.siteBase, site.srcRoot)}
              @click=${(e: Event) => this.onOpClick(e)}>${op.quote ?? op.pageTitle ?? op.file}</a></li>`)}
        </ul>
        ${discarded || !canShowFor('discard-review', { reviewAuthor: r.authorKey }) ? nothing : html`
          <sl-button size="small" variant="text" data-testid="review-discard" @click=${() => this.askDiscard(r.id)}>${t('discard')}</sl-button>`}
      </div>`;
  }

  override render() {
    const site = siteFromPage(document.body.dataset['sourceFile'] ?? '', location.pathname);
    return html`
      <div class="tc-reviews">
        ${this.error ? html`<div class="tc-reviews__error" data-testid="reviews-error">${this.error}</div>` : nothing}
        ${this.renderForm()}
        ${this.reviews.length === 0 && !this.error ? html`<div class="tc-empty">${t('noReviews')}</div>` : nothing}
        ${this.reviews.map(r => this.renderReview(r, site))}
        <sl-dialog data-testid="discard-dialog" label=${t('discard')} @sl-after-hide=${(e: Event) => { if (e.target === this.dialog) this.discardId = null; }}>
          ${t('discardConfirm')}
          <sl-button slot="footer" variant="neutral" data-testid="discard-cancel" @click=${() => this.cancelDiscard()}>${t('cancel')}</sl-button>
          <sl-button slot="footer" variant="danger" data-testid="discard-confirm" @click=${() => void this.confirmDiscard()}>${t('discard')}</sl-button>
        </sl-dialog>
      </div>`;
  }
}
