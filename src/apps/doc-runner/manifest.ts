import type { AppManifest } from '../../platform/app.ts';

export const DOC_RUNNER_ID = 'doc-runner';

export const manifest: AppManifest = {
  id: DOC_RUNNER_ID,
  name: 'Doc → Requests',
  tagline: 'Turn a handed-over API document into runnable requests.',
  description:
    'Upload the PDF, Word or Markdown document a department sends over, and get ' +
    'every endpoint in it back as a request you can read, copy and run in place ' +
    '— instead of retyping each one into Postman to find out whether it works.',
  icon: '📄',
  status: 'ready',
  launch: 'upload',
  highlights: [
    'Reads spec tables, labelled prose and pasted curl commands alike',
    'Run each endpoint and see the response beside the documented one',
    'Export as a Postman collection with credentials as variables',
    'Nothing leaves the machine — the document is parsed locally',
  ],
};
