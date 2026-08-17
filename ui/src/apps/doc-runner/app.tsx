import type { UiApp } from '../../shell/apps.tsx';
import { DOC_RUNNER_ID } from './api.ts';
import { DocRunner } from './index.tsx';

export const docRunnerUi: UiApp = {
  id: DOC_RUNNER_ID,
  component: DocRunner,
  activity(status) {
    const importing = (status as { importing?: string | null } | null)?.importing;
    return importing ? { label: `Reading ${importing}`, tone: 'warn' } : null;
  },
};
