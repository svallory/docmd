import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Thread } from '../../types';
import { canShowFor } from '../lib/identity';

import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/divider/divider.js';
import '@shoelace-style/shoelace/dist/components/tag/tag.js';

import './threads-comment';
import './threads-compose';

@customElement('threads-thread')
export class ThreadsThread extends LitElement {
  override createRenderRoot() { return this; }

  @property({ type: Object }) thread!: Thread;
  @property({ type: Boolean }) focused = false;
  @property({ type: Boolean }) orphan = false;
  @property({ type: String }) currentAuthor: string | null = null;
  @property({ type: String }) quote: string | null = null;

  private scrollToHighlight(): void {
    this.dispatchEvent(new CustomEvent('thread-scroll-to', {
      bubbles: true, composed: true,
      detail: { threadId: this.thread.id },
    }));
  }

  private toggleResolve(): void {
    this.dispatchEvent(new CustomEvent('thread-resolve', {
      bubbles: true, composed: true,
      detail: { threadId: this.thread.id },
    }));
  }

  private requestDelete(): void {
    this.dispatchEvent(new CustomEvent('thread-delete', {
      bubbles: true, composed: true,
      detail: { threadId: this.thread.id },
    }));
  }

  private handleReply(e: CustomEvent): void {
    this.dispatchEvent(new CustomEvent('thread-reply', {
      bubbles: true, composed: true,
      detail: { threadId: this.thread.id, body: e.detail.body },
    }));
  }

  override render() {
    const t = this.thread;
    const truncatedQuote = this.quote
      ? (this.quote.length > 100 ? this.quote.slice(0, 100) + '...' : this.quote)
      : null;

    return html`
      <div class="tc-thread ${this.focused ? 'tc-thread--focused' : ''} ${t.resolved ? 'tc-thread--resolved' : ''}">
        ${truncatedQuote ? html`
          <div class="tc-thread__quote" @click=${this.scrollToHighlight}>
            <div class="tc-thread__quote-text">${truncatedQuote}</div>
            ${this.orphan ? html`<sl-tag size="small" variant="warning" pill>orphaned</sl-tag>` : nothing}
          </div>
        ` : nothing}

        <div class="tc-thread__comments">
          ${t.comments.map(c => html`
            <threads-comment
              .comment=${c}
              .isOpenerWithReplies=${c === t.comments[0] && !c.draft && t.comments.filter(x => !x.draft).length > 1}
              .currentAuthor=${this.currentAuthor}
            ></threads-comment>
          `)}
        </div>

        <div class="tc-thread__reply">
          <threads-compose
            placeholder="Reply to this thread..."
            submit-label="Reply"
            @compose-submit=${this.handleReply}
          ></threads-compose>
        </div>

        <div class="tc-thread__footer">
          ${canShowFor('resolve-thread', { threadAuthor: t.comments[0]?.authorKey, drafted: !!t.draft }) ? html`
            <sl-button size="small" variant="text" style=${t.resolved ? '' : 'color: var(--sl-color-success-600);'} @click=${this.toggleResolve}>
              ${t.resolved ? 'Unresolve' : 'Resolve'}
            </sl-button>` : nothing}
          ${canShowFor('delete-thread', { authorKeys: t.comments.filter(c => !c.draft).map(c => c.authorKey), drafted: !!t.draft }) ? html`
            <sl-button size="small" variant="text" style="color: var(--sl-color-danger-600);" @click=${this.requestDelete}>Delete</sl-button>` : nothing}
        </div>
      </div>
    `;
  }
}