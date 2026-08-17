/**
 * The contract between the shell and the utilities it hosts.
 *
 * curlapi started as one tool with one lifecycle: the process launched Chrome,
 * recorded, and exited. That shape cannot hold a second utility — a document
 * importer has nothing to do with a browser — so the process now boots a shell
 * that owns nothing but the server, the database and the window, and each
 * utility is an app that starts its own work when the user asks for it.
 *
 * An app is three things: a manifest the dashboard can render without loading
 * any of the app's code, a set of routes under its own path, and a `dispose`
 * that releases whatever it started.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store/db.ts';

/** What an app needs before it can do anything useful. */
export type LaunchKind =
  /** Nothing — the app opens straight into its workspace. */
  | 'none'
  /** A target URL, confirmed by the user, before any work begins. */
  | 'url'
  /** One or more uploaded files. */
  | 'upload';

/**
 * Everything the dashboard needs to render an app's card.
 *
 * Deliberately plain data with no behaviour: the shell serves the whole registry
 * over `/api/apps` on first paint, and an app that is still `coming-soon` should
 * cost nothing but a card.
 */
export type AppManifest = {
  /** Stable id — used in URLs and route prefixes, so keep it kebab-case. */
  id: string;
  name: string;
  /** One line, on the dashboard card. */
  tagline: string;
  /** A paragraph, on the app's own launch screen. */
  description: string;
  /** Emoji shown on the card. Kept to one glyph so cards line up. */
  icon: string;
  status: 'ready' | 'coming-soon';
  launch: LaunchKind;
  /** Short bullets on the card explaining what the app gives you. */
  highlights: string[];
};

/** Services the shell hands every app. */
export type AppContext = {
  store: Store;
  /**
   * The shell's own origin. An app that instruments a browser has to tell it to
   * ignore this, or the review UI shows up as traffic in its own capture.
   */
  serverUrl: string;
  /** Pushes a message to every connected client, tagged with this app's id. */
  broadcast(message: Record<string, unknown>): void;
  /** Asks the shell to push fresh status now, rather than on the next tick. */
  pushStatus(): void;
};

/** One HTTP request, with the app's own prefix already stripped from the path. */
export type RouteRequest = {
  /** Path relative to the app, always starting with `/`. */
  path: string;
  method: string;
  /** The full URL, for query parameters. */
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
};

export type AppInstance = {
  /**
   * Handles a request, or returns false to let the shell answer 404.
   *
   * Returning a boolean rather than throwing keeps "this app has no such route"
   * distinct from "this route failed", which the shell reports differently.
   */
  handle(request: RouteRequest): Promise<boolean>;
  /**
   * Compact live state, pushed to clients over the WebSocket.
   *
   * Null means the app has nothing running, which is what lets the dashboard
   * show a card as idle without the app doing any work to say so.
   */
  status(): unknown;
  /** Releases anything the app started. Called once, on process shutdown. */
  dispose(): Promise<void>;
};

export type AppModule = {
  manifest: AppManifest;
  create(context: AppContext): AppInstance;
};
