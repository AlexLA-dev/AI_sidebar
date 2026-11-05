// Safari hands values back from extension storage (get, and onChanged's newValue) with every object's keys in its own
// order, not the order they were written in. The background tells its own writes from changes made elsewhere by
// comparing what comes back with what it wrote: in this form, which is the same whatever order the keys are in.

/** JSON with every object's keys sorted: the same for equal values, whatever order their keys come in. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key]
    return sorted
  })
}
