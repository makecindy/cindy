import type { CompanyExecutionReceipt, CompanyModelTokens, CompanyTurnBoundary } from '../../usage/companyTokenFacts.js';
import { addCompanyTokens, hasCompanyTokens } from '../../usage/companyTokenQueue.js';

/** One admitted execution turn. Pending Claude deltas are memory-only and bounded by the policy's models. */
export class HostedCompanyTurn {
  private receipt?: CompanyExecutionReceipt;
  private pending?: Map<string, CompanyModelTokens>;

  constructor(private readonly boundary: CompanyTurnBoundary, initial?: CompanyExecutionReceipt) {
    if (initial?.current()) this.receipt = initial;
  }

  authorize(receipt: CompanyExecutionReceipt) {
    if (!this.boundary()) { this.pending = undefined; return; }
    if (!receipt.current()) return;
    // An already attributed turn cannot transfer its counters to a different principal.
    if (this.receipt && this.receipt.receipt !== receipt.receipt) return;
    this.receipt = receipt;
    const pending = this.pending;
    this.pending = undefined;
    if (pending?.size) receipt.record([...pending.values()]);
  }

  get record() {
    return this.receipt?.current() && this.boundary() ? this.receipt.record : undefined;
  }

  observeClaude(samples: CompanyModelTokens[]) {
    if (!this.boundary()) { this.pending = undefined; return; }
    const tokens = samples.filter(hasCompanyTokens);
    if (!tokens.length) return;
    if (this.receipt?.current()) {
      this.receipt.record(tokens);
      return;
    }
    for (const sample of tokens) {
      if (!this.boundary(sample.model)) continue;
      this.pending ??= new Map();
      const prior = this.pending.get(sample.model);
      if (prior) addCompanyTokens(prior, sample);
      else this.pending.set(sample.model, sample);
    }
  }
}
