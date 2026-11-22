// Evidence package integrity (v1.5.0).
// Stored shape on the task record: task.evidence = { items: [...], sha256 }.
// Legacy records hold a bare array of items; the helpers below read both.
// The hash is SHA-256 over the canonical package — JSON of
// { task_id, items: [{type, url, label, at}, …] } in stored order — so anyone
// holding the package can recompute it and detect later edits.
import { createHash } from "node:crypto";

export function evidenceItems(task) {
  const ev = task?.evidence;
  if (Array.isArray(ev)) return ev;
  if (ev && Array.isArray(ev.items)) return ev.items;
  return [];
}

export function canonicalEvidencePackage(task) {
  return {
    task_id: task.id,
    items: evidenceItems(task).map((it) => ({
      type: it.type ?? null,
      url: it.url ?? null,
      label: it.label ?? "",
      at: it.at ?? null,
    })),
  };
}

export function evidenceSha256(task) {
  const pkg = canonicalEvidencePackage(task);
  if (pkg.items.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
}

// Append an item and (re)stamp the package hash. Mutates and returns
// task.evidence in the current stored shape.
export function attachEvidence(task, item) {
  const items = [...evidenceItems(task), item];
  task.evidence = { items, sha256: null };
  task.evidence.sha256 = evidenceSha256(task);
  return task.evidence;
}

// Read view for get_evidence: items plus the package hash (the stored stamp
// when present, otherwise computed — canonicalisation makes them identical).
export function evidenceView(task) {
  const items = evidenceItems(task);
  const stored = task?.evidence && !Array.isArray(task.evidence) ? task.evidence.sha256 : null;
  return { items, sha256: stored || evidenceSha256(task) };
}
