// ETA's canonical form of a document: what gets hashed and signed
// (https://sdk.invoicing.eta.gov.eg/document-serialization-approach/).
//
// Walk the ONE document (not the {documents:[...]} wrapper) in JSON order; every property
// name upper-cased and quoted; every simple value quoted exactly as it is written in the JSON
// sent (so numbers must be the same text: build the object once and JSON.stringify that same
// object); nested objects add their children with no braces; an array writes its name once,
// then its name again before each element. The signatures are left out.
//
// Checked byte-for-byte against the SDK's one-doc.json → one-doc-serialized.json.txt
// (test/eta-canonical.test.ts).

export function etaCanonical(doc: Record<string, unknown>): string {
  const { signatures: _signatures, ...body } = doc;
  return object(body);
}

function object(o: Record<string, unknown>): string {
  let out = "";
  for (const [key, value] of Object.entries(o)) {
    if (value === undefined) continue; // JSON.stringify leaves it out too
    const name = `"${key.toUpperCase()}"`;
    if (Array.isArray(value)) {
      out += name;
      for (const element of value) out += name + simple(element);
    } else {
      out += name + simple(value);
    }
  }
  return out;
}

function simple(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("ETA documents can't hold a non-finite number");
    return `"${String(value)}"`; // String(n) is what JSON.stringify writes
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (value && typeof value === "object") return object(value as Record<string, unknown>);
  // Null and booleans have no agreed canonical form: such fields are left out instead.
  throw new Error("ETA documents can't hold null or boolean values");
}
