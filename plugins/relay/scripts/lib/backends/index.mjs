import { UsageError } from "../util/errors.mjs";
import { codexBackend } from "./codex/index.mjs";
import { grokBackend } from "./grok/index.mjs";
import { zcodeBackend } from "./zcode/index.mjs";


export const BACKENDS = [codexBackend, grokBackend, zcodeBackend];
export const DEFAULT_BACKEND = BACKENDS[0];

export function backendNames(separator = ", ", lastSeparator = " or ") {
  const names = BACKENDS.map(backend => backend.name);
  return names.slice(0, -1).join(separator) + lastSeparator + names.at(-1);
}

export function backendNamed(name) {
  const backend = BACKENDS.find(backend => backend.name === name);
  if (!backend) throw new UsageError(`backend must be ${backendNames()}.`);
  return backend;
}

export function backendFor(request) {
  return request?.backend == null ? DEFAULT_BACKEND : backendNamed(request.backend);
}

export function backendWith(capability) {
  const matches = BACKENDS.filter(backend => backend.capabilities[capability]);
  if (matches.length !== 1) throw new Error(`Expected one backend with ${capability}.`);
  return matches[0];
}

export const BACKEND_HEADER_KEYS = Object.assign({}, ...BACKENDS.map(backend => backend.request.headerKeys));

export function backendHeaderValues(options) {
  return Object.fromEntries(Object.entries(BACKEND_HEADER_KEYS).map(([key, field]) => [field, options[key]]));
}
