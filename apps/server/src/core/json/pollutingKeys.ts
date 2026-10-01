// JSON.parse reviver shared by hook ingest and redaction: drops `__proto__` and `constructor.prototype`
// keys at any depth (secure-json-parse `protoAction/constructorAction: 'remove'` semantics).
export function removePollutingKeys(this: unknown, key: string, value: unknown): unknown {
  if (key === '__proto__') return undefined; // a reviver returning undefined deletes the property
  if (key === 'constructor' && typeof value === 'object' && value !== null && Object.hasOwn(value, 'prototype')) {
    delete (value as Record<string, unknown>).prototype;
  }
  return value;
}
