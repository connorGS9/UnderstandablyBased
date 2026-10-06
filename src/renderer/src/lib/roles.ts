import type { Confidence, Role } from '../../../engine/types';

export interface RoleInfo {
  label: string;
  short: string;
  /** Plain-language explanation, written for someone new to this kind of architecture. */
  explain: string;
}

export const ROLES: Record<Role, RoleInfo> = {
  route: { label: 'Route', short: 'route', explain: 'An address the app answers, like GET /orders. A request from a browser or another program enters the code here.' },
  page: { label: 'Page', short: 'page', explain: 'A screen in the user interface that a URL leads to.' },
  entry: { label: 'Entry point', short: 'entry', explain: 'Where a program starts running: a main() function or a startup script.' },
  middleware: { label: 'Middleware', short: 'middleware', explain: 'Runs before the main handler: checks who is logged in, validates input, logs requests and so on.' },
  controller: { label: 'Controller / handler', short: 'controller', explain: 'Receives a request and decides what to do with it. Good controllers stay thin and hand real work to services.' },
  service: { label: 'Service / business logic', short: 'service', explain: 'The rules of the application, such as placing an order or calculating a price. Most of the interesting decisions live here.' },
  repository: { label: 'Repository / data access', short: 'data access', explain: 'Reads and writes the database, so the rest of the code does not have to know how storage works.' },
  model: { label: 'Model / entity', short: 'model', explain: 'Describes the shape of a piece of data, often matching a database table.' },
  view: { label: 'View / UI component', short: 'view', explain: 'User-interface code that draws what the user sees.' },
  client: { label: 'Client / integration', short: 'client', explain: 'Talks to another system: an external API, a message broker, a socket.' },
  util: { label: 'Utility', short: 'util', explain: 'Helper code shared across the codebase.' },
  config: { label: 'Configuration', short: 'config', explain: 'Wires the app together: settings, dependency injection, startup configuration.' },
  test: { label: 'Test', short: 'test', explain: 'Automated tests that check the code behaves correctly.' },
  table: { label: 'Database table', short: 'table', explain: 'Where data is stored. Arrows show which code reads or writes it.' },
  external: { label: 'External service', short: 'external', explain: 'Something outside this codebase that the code calls over the network.' },
  channel: { label: 'Channel / IPC', short: 'channel', explain: 'A pipe between processes or services: shared memory, a socket, or a message queue topic.' },
  other: { label: 'Other', short: 'code', explain: 'Code without a clear architectural role.' },
};

/** Ordering used for diagram columns: request enters on the left, data leaves on the right. */
export const ROLE_RANK: Record<Role, number> = {
  route: 0,
  page: 0,
  entry: 0,
  middleware: 1,
  controller: 2,
  view: 2,
  service: 3,
  util: 4,
  config: 4,
  other: 4,
  client: 5,
  repository: 5,
  model: 6,
  test: 6,
  table: 7,
  external: 7,
  channel: 7,
};

export const roleColor = (r: Role | undefined) => `var(--role-${r ?? 'other'})`;

export const CONFIDENCE: Record<Confidence, { label: string; explain: string }> = {
  certain: { label: 'Certain', explain: 'The link is written explicitly in the code (an import, a declared type, the same class).' },
  likely: { label: 'Likely', explain: 'Very probably right: resolved through an interface, inheritance, or a framework convention.' },
  guess: { label: 'Guess', explain: 'Matched by name only because the type could not be determined. Check the code to confirm.' },
};

export const METHOD_COLORS: Record<string, string> = {
  GET: 'var(--m-get)',
  POST: 'var(--m-post)',
  PUT: 'var(--m-put)',
  PATCH: 'var(--m-patch)',
  DELETE: 'var(--m-delete)',
  ANY: 'var(--m-any)',
  WS: 'var(--m-ws)',
  PAGE: 'var(--m-page)',
  ROUTE: 'var(--m-any)',
};
