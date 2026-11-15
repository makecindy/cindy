/**
 * Suggestions for the sender formats in maker-scheduler/webhook-formats.ts.
 * These are common events, not an allowlist: unknown saved filters stay editable.
 * Match the extracted event/action, not the sender's webhook subscription label.
 * Sources: https://docs.github.com/en/webhooks/webhook-events-and-payloads
 * https://docs.gitea.com/usage/repository/webhooks/
 * https://docs.gitlab.com/user/project/integrations/webhook_events/
 * https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/
 * https://linear.app/developers/webhooks · https://docs.stripe.com/api/events/types
 */
export interface WebhookEventOption {
  value: string;
  label: string;
  parent?: string;
  coversActions?: boolean;
}
export interface WebhookEventGroup {
  label: string;
  options: WebhookEventOption[];
}

const group = (label: string, entries: [string, string][]): WebhookEventGroup => ({
  label,
  options: entries.map(([value, label]) => ({ value, label })),
});
const actions = (label: string, event: string, entries: [string, string][]): WebhookEventGroup => ({
  label,
  options: [
    { value: event, label: 'all', coversActions: true },
    ...entries.map(([action, name]) => ({
      value: `${event}.${action}`,
      label: name,
      parent: event,
    })),
  ],
});

const issues = actions('issues', 'issues', [
  ['opened', 'created'],
  ['closed', 'closed'],
  ['reopened', 'reopened'],
  ['edited', 'edited'],
]);
const pullRequests = (sync: string) =>
  actions('pullRequests', 'pull_request', [
    ['opened', 'created'],
    ['closed', 'closed'],
    ['reopened', 'reopened'],
    [sync, 'commitsUpdated'],
  ]);
const comments = actions('issueComments', 'issue_comment', [
  ['created', 'created'],
  ['edited', 'edited'],
]);
const repository = group('repository', [['push', 'pushed']]);
const gitlab = [
  actions('issues', 'issue', [
    ['open', 'created'],
    ['close', 'closed'],
    ['reopen', 'reopened'],
    ['update', 'updated'],
  ]),
  actions('mergeRequests', 'merge_request', [
    ['open', 'created'],
    ['close', 'closed'],
    ['merge', 'merged'],
    ['update', 'updated'],
  ]),
  group('repository', [
    ['push', 'pushed'],
    ['tag_push', 'tagsChanged'],
  ]),
  group('comments', [['note', 'all']]),
  group('pipelines', [['pipeline', 'all']]),
];

const byPreset: Record<string, WebhookEventGroup[]> = {
  'github-app': [
    issues,
    pullRequests('synchronize'),
    comments,
    actions('reviews', 'pull_request_review', [['submitted', 'submitted']]),
    actions('reviewComments', 'pull_request_review_comment', [['created', 'created'], ['edited', 'edited']]),
    group('reviewThreads', [['pull_request_review_thread', 'all']]),
    actions('checkRuns', 'check_run', [['completed', 'completed']]),
    actions('checks', 'check_suite', [['completed', 'completed']]),
    group('commitStatus', [['status', 'all']]),
    actions('workflows', 'workflow_run', [['completed', 'completed']]),
    repository,
    actions('releases', 'release', [['published', 'published']]),
  ],
  github: [
    issues,
    pullRequests('synchronize'),
    comments,
    actions('reviews', 'pull_request_review', [['submitted', 'submitted']]),
    actions('checks', 'check_suite', [['completed', 'completed']]),
    actions('workflows', 'workflow_run', [['completed', 'completed']]),
    repository,
    actions('releases', 'release', [['published', 'published']]),
  ],
  gitea: [
    issues,
    pullRequests('synchronized'),
    comments,
    repository,
    actions('releases', 'release', [['published', 'published']]),
  ],
  'gitlab-token': gitlab,
  gitlab,
  bitbucket: [
    group('pullRequests', [
      ['pullrequest:created', 'created'],
      ['pullrequest:updated', 'updated'],
      ['pullrequest:fulfilled', 'merged'],
      ['pullrequest:rejected', 'declined'],
    ]),
    group('comments', [
      ['pullrequest:comment_created', 'created'],
      ['pullrequest:comment_updated', 'updated'],
    ]),
    group('repository', [['repo:push', 'pushed']]),
  ],
  linear: [
    actions('issues', 'Issue', [
      ['create', 'created'],
      ['update', 'updated'],
      ['remove', 'deleted'],
    ]),
    actions('comments', 'Comment', [
      ['create', 'created'],
      ['update', 'updated'],
      ['remove', 'deleted'],
    ]),
    actions('projects', 'Project', [
      ['create', 'created'],
      ['update', 'updated'],
      ['remove', 'deleted'],
    ]),
  ],
  stripe: [
    group('payments', [
      ['payment_intent.succeeded', 'succeeded'],
      ['payment_intent.payment_failed', 'failed'],
    ]),
    group('checkout', [['checkout.session.completed', 'completed']]),
    group('invoices', [
      ['invoice.paid', 'paid'],
      ['invoice.payment_failed', 'failed'],
    ]),
    group('subscriptions', [
      ['customer.subscription.created', 'created'],
      ['customer.subscription.updated', 'updated'],
      ['customer.subscription.deleted', 'deleted'],
    ]),
  ],
};

export function webhookEventOptions(preset: string): readonly WebhookEventGroup[] {
  return Object.hasOwn(byPreset, preset) ? byPreset[preset]! : [];
}

export function parseWebhookEventSelection(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
