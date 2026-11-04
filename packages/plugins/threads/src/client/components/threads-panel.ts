import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { t } from '../lib/i18n';
import { partitionThreads } from '../lib/reviews-view';
import type { Thread, Anchor } from '../../types';

import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/badge/badge.js';
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/divider/divider.js';

import './threads-thread';
import './threads-compose';
import './threads-reviews-panel';

type FilterType = 'all' | 'open' | 'resolved' | 'reviews';

@customElement('threads-panel')
export class ThreadsPanel extends LitElement {
  override createRenderRoot() { return this; }

  @property({ type: Boolean }) open = false;
  @property({ type: Array }) threads: Thread[] = [];
  @property({ type: String }) filter: FilterType = 'all';
  @property({ type: String, attribute: 'focused-thread' }) focusedThreadId: string | null = null;
  @property({ type: Object }) composing: { anchor?: Anchor } | null = null;
  @property({ type: String }) currentAuthor: string | null = null;
  @property({ attribute: false }) orphanIds: Set<string> = new Set();
  @property({ attribute: false }) threadQuotes: Map<string, string> = new Map();

  private get filteredThreads(): Thread[] {
    return this.threads.filter(t => {
      if (t.orphaned) return false;
      if (this.filter === 'open') return !t.resolved;
      if (this.filter === 'resolved') return t.resolved;
      return true;
    });
  }

  private setFilter(f: FilterType): void {
    this.filter = f;
    this.requestUpdate();
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent('panel-close', {
      bubbles: true, composed: true,
    }));
  }

  private handleNewThreadSubmit(e: CustomEvent): void {
    this.dispatchEvent(new CustomEvent('compose-new-thread', {
      bubbles: true, composed: true,
      detail: { body: e.detail.body },
    }));
  }

  private handleCancelCompose(): void {
    this.dispatchEvent(new CustomEvent('compose-cancel-new', {
      bubbles: true, composed: true,
    }));
  }

  private handleAddGeneralComment(): void {
    this.dispatchEvent(new CustomEvent('compose-general-comment', {
      bubbles: true, composed: true,
    }));
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has('focusedThreadId') && this.focusedThreadId) {
      setTimeout(() => {
        const el = this.querySelector(`threads-thread[data-thread-id="${this.focusedThreadId}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }

  override render() {
    if (!this.open) return nothing;

    const filtered = this.filteredThreads;
    const orphaned = partitionThreads(this.threads).orphaned;

    const filterBtn = (f: FilterType, label: string) => html`
      <sl-button
        size="small"
        variant=${this.filter === f ? 'neutral' : 'text'}
        @click=${() => this.setFilter(f)}
      >${label}</sl-button>
    `;

    const quote = this.composing?.anchor?.quote ?? '';
    const truncatedQuote = quote.length > 120
      ? quote.slice(0, 120) + '...'
      : quote;

    return html`
      <div class="tc-panel">
        <div class="tc-panel__header">
          <div class="tc-panel__title">
            <span>${t('threads')}</span>
            <sl-badge variant="neutral" pill>${this.threads.filter(t => !t.resolved).length}</sl-badge>
          </div>
          <div class="tc-panel__header-actions">
            <sl-button size="small" variant="text" title=${t('addGeneralComment')} @click=${this.handleAddGeneralComment}>
              <sl-icon name="plus-lg"></sl-icon>
            </sl-button>
            <sl-button size="small" variant="text" title=${t('collapseSidebar')} @click=${this.handleClose}>
              <sl-icon name="chevron-double-right"></sl-icon>
            </sl-button>
          </div>
        </div>

        <div class="tc-panel__filters">
          ${filterBtn('all', t('all'))}
          ${filterBtn('open', t('open'))}
          ${filterBtn('resolved', t('resolved'))}
          ${filterBtn('reviews', t('reviews'))}
        </div>

        <div class="tc-panel__body">
          ${this.filter === 'reviews' ? html`<threads-reviews-panel></threads-reviews-panel>` : html`
          ${this.composing ? html`
            <div class="tc-new-thread">
              <threads-compose
                quote=${truncatedQuote}
                placeholder="Add a comment..."
                submit-label="Comment"
                ?cancellable=${true}
                @compose-submit=${this.handleNewThreadSubmit}
                @compose-cancel=${this.handleCancelCompose}
              ></threads-compose>
            </div>
          ` : nothing}

          ${filtered.length === 0 && !this.composing ? html`
            <div class="tc-empty">
              <sl-icon name="chat-dots" style="font-size:32px; opacity:0.4; margin-bottom:8px;"></sl-icon>
              ${t('noThreads')}<br>${t('selectTextToStart')}
            </div>
          ` : nothing}

          ${filtered.map(thread => html`
            <threads-thread
              data-thread-id=${thread.id}
              .thread=${thread}
              .quote=${this.threadQuotes.get(thread.id) ?? null}
              ?focused=${this.focusedThreadId === thread.id}
              ?orphan=${this.orphanIds.has(thread.id)}
              .currentAuthor=${this.currentAuthor}
            ></threads-thread>
          `)}

          ${orphaned.length > 0 ? html`
            <div class="tc-orphaned" data-testid="orphaned-group">
              <div class="tc-orphaned__title">${t('orphaned')}</div>
              ${orphaned.map(thread => html`
                <div class="tc-orphaned__item" data-thread-id=${thread.id}>
                  <span class="tc-orphaned__quote">${thread.anchor?.quote ?? ''}</span>
                </div>`)}
            </div>` : nothing}`}
        </div>
      </div>
    `;
  }
}