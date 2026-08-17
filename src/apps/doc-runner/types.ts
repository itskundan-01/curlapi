/**
 * What an endpoint looks like once it has been read out of a document.
 *
 * Richer than the captured `RequestRecord` on purpose. A capture knows what was
 * sent and what came back; a document knows what is *meant* to be sent — which
 * fields are required, what the values mean, which responses are expected — and
 * throwing that away would leave the reader with a curl command and none of the
 * context that made the document worth writing.
 */

import type { HeaderPair } from '../../types.ts';

/**
 * Where a field belongs.
 *
 * `response` is not a request location, and is here because these documents put
 * request and response field tables in the same shape, one after the other. A
 * reader shown `publicKey` as something to send would be badly misled — it is
 * what comes back.
 */
export type ParamIn = 'path' | 'query' | 'body' | 'header' | 'response';

export type DocParam = {
  name: string;
  in: ParamIn;
  description: string;
  dataType: string;
  /** Example or permitted values, verbatim from the document. */
  expected: string;
  required: boolean;
};

/** A status code the document says this endpoint can return. */
export type ResponseCode = {
  code: string;
  description: string;
};

/**
 * A base URL for one environment.
 *
 * Documents routinely list Staging and Production side by side, often with the
 * production cell left empty because it does not exist yet. Keeping them as
 * alternatives means the reader can switch without editing the URL by hand.
 */
export type Environment = {
  name: string;
  url: string;
};

/** How an endpoint was found, so a wrong reading can be traced back. */
export type Provenance = {
  /** Which extractor produced it. */
  extractor: 'spec-table' | 'curl' | 'labelled' | 'postman' | 'openapi';
  /** 0-1. Used to pick a winner when two extractors find the same endpoint. */
  confidence: number;
  /** Indices of the document blocks it came from, for "show me where". */
  blocks: number[];
};

export type ParsedEndpoint = {
  id: string;
  /** Position in the document, which is the order a reader expects. */
  position: number;
  name: string;
  /** Heading trail above it, outermost first. */
  section: string[];
  method: string;
  url: string;
  environments: Environment[];
  headers: HeaderPair[];
  body: string | null;
  /** Content type for the body, from a header or inferred from its shape. */
  bodyMime: string;
  /** The response the document claims, kept to compare against a real run. */
  documentedResponse: string | null;
  responseCodes: ResponseCode[];
  params: DocParam[];
  description: string;
  /** Anything nearby that did not fit a field but is worth keeping. */
  notes: string[];
  provenance: Provenance;
  /** Things a person should look at before trusting this. */
  warnings: string[];
};

/**
 * A named value the reader can fill in once and have applied everywhere.
 *
 * Two sources: `{placeholders}` in a URL, and credentials found in headers. The
 * second is what makes an export shareable — a collection with the department's
 * live API key baked into thirty requests cannot be sent to anyone.
 */
export type Variable = {
  key: string;
  value: string;
  /** True when this looks like a credential and should not be shared casually. */
  secret: boolean;
  /** Where it came from, for the UI to explain itself. */
  origin: 'path' | 'placeholder' | 'header' | 'manual';
};

export type ParseResult = {
  endpoints: ParsedEndpoint[];
  variables: Variable[];
  /** Document-level title, when the file declares one. */
  title: string | null;
  warnings: string[];
  /** Counts by extractor, so the UI can say how the document was understood. */
  stats: Record<string, number>;
};
