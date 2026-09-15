import { TaskProgress } from './progress.mjs';

export const EVENT_KIND = Object.freeze({
  ANALYZE: 'ANALYZE', SEARCH: 'SEARCH', READ: 'READ', WRITE: 'WRITE', EDIT: 'EDIT',
  SHELL: 'SHELL', TEST: 'TEST', GIT: 'GIT', NETWORK: 'NETWORK', APPROVAL: 'APPROVAL',
  DONE: 'DONE', FAILED: 'FAILED', CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT',
});

/** Maps existing runner events to local Chinese progress. It never calls a model. */
export class EventPresenter extends TaskProgress {
  constructor(options) {
    super(options);
    this.extraModelTokens = 0;
  }

  record(event) {
    if (event?.type === 'tool') this.recordTool(event.tool);
    else if (event?.type === 'tool-result' || event?.type === 'text') this.recordText(event.text);
    else if (event?.type === 'retry') this.recordRetry(event);
    else if ((event?.type === 'model' || event?.type === 'init') && event.model) this.setModel(event.model);
    else return false;
    return true;
  }
}
