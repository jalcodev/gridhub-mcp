// Derive a permissive JSON Schema (2020-12) from a real example value.
// Used for the Bazaar output schema and MCP tool outputSchema. The example
// always validates against its own schema by construction (the Coinbase
// facilitator ajv-checks info against schema when a payment settles).
// Permissive on purpose: leaves are nullable, nothing is required, extra
// fields are allowed, so a zone that omits a metric or an error body never
// fails a client's validation.
const MAP_KEYS = new Set(["zones", "metrics", "current", "context", "trend", "trends"]); // keyed by zone id / metric name

export function schemaOf(v: unknown, key?: string, root = true): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (Array.isArray(v)) {
    return { type: root ? "array" : ["array", "null"], items: v.length ? schemaOf(v[0], undefined, false) : {} };
  }
  switch (typeof v) {
    case "number": return { type: ["number", "null"] };
    case "string": return { type: ["string", "null"] };
    case "boolean": return { type: ["boolean", "null"] };
    case "object": {
      const o = v as Record<string, unknown>;
      const type = root ? "object" : ["object", "null"];
      if (key && MAP_KEYS.has(key)) {
        const first = Object.values(o)[0];
        return { type, additionalProperties: first === undefined ? {} : schemaOf(first, undefined, false) };
      }
      return { type, properties: Object.fromEntries(Object.entries(o).map(([k, x]) => [k, schemaOf(x, k, false)])) };
    }
  }
  return {};
}
