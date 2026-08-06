/**
 * node:sqlite is still flagged experimental and warns on every run. Using it is
 * a deliberate choice — it removes any native dependency to compile — so the
 * notice is noise for the user rather than information.
 *
 * This lives in its own module, and the entry point must reach node:sqlite
 * through a dynamic `import()` rather than a static one. ES modules link every
 * static import — built-ins included — before any module body executes, so a
 * static `import { Store }` would load node:sqlite and warn before this file
 * ever ran. Import order alone cannot fix that; deferring the load can.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
