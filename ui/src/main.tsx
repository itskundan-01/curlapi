import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './shell/Shell.tsx';
import './styles.css';
import './shell.css';
import './doc-runner.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
