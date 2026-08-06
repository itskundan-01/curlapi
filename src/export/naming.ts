import type { RequestRecord } from '../types.ts';
import { disambiguate } from '../analyze/shortname.ts';

/**
 * Resolves the label shown against each entry: an explicit rename wins,
 * otherwise the Chrome-style short name widened just enough to stay unique
 * within this list.
 */
export function resolveNames(records: RequestRecord[]): string[] {
  const widened = disambiguate(records.map((record) => record.url));
  return records.map((record, index) => record.title ?? widened[index]);
}
