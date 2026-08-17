import type { HeaderPair } from '../../../types.ts';
import type { Environment, Provenance } from '../types.ts';

/**
 * One extractor's reading of one endpoint, before merging.
 *
 * Deliberately narrower than {@link import('../types.ts').ParsedEndpoint}: an
 * extractor reports only what it can see in the text in front of it. Names,
 * sections, parameter tables and variables are attached afterwards by the
 * enrichment pass, which can look at the whole document.
 */
export type Candidate = {
  method: string;
  url: string;
  environments: Environment[];
  headers: HeaderPair[];
  body: string | null;
  bodyMime: string;
  documentedResponse: string | null;
  /** Document block indices this reading came from. */
  blocks: number[];
  extractor: Provenance['extractor'];
  confidence: number;
  warnings: string[];
};
