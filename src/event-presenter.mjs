import { TaskProgress } from './progress.mjs';

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
