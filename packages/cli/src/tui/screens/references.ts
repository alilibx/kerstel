import type { ProjectRefs } from "../../project-refs";
import type { Row } from "../widgets/list";

/**
 * The References screen: the `kerstel refs` scan as a tree, scope then
 * checkout then file then reference, or by key with `b`. Spec §4.5. Every row
 * that names a stored secret carries its reference, so Enter can jump to it.
 */

export function referenceRows(refs: ProjectRefs, byKey: boolean, stored: Set<string>): Row[] {
  const rows: Row[] = [];
  const known = (reference: string) => (stored.has(reference) ? reference : undefined);

  if (!byKey) {
    for (const checkout of refs.checkouts) {
      rows.push({ cells: [checkout.scope, checkout.rootPath, ""], tone: "heading" });
      const files = checkout.files.filter((f) => f.references.length > 0);
      if (files.length === 0) rows.push({ cells: ["", "no references", ""], tone: "dim" });
      for (const file of files) {
        const seen = new Set<string>();
        for (const r of file.references) {
          if (seen.has(r.reference)) continue;
          seen.add(r.reference);
          rows.push({
            cells: [seen.size === 1 ? `  ${file.name}` : "", r.reference, r.inVault ? "" : "✗ not in the vault"],
            tone: r.inVault ? "normal" : "problem",
            reference: known(r.reference),
          });
        }
      }
    }
  } else {
    const byRef = new Map<string, { scope: string; path: string }[]>();
    for (const checkout of refs.checkouts) {
      for (const file of checkout.files) {
        for (const r of file.references) {
          if (!r.inVault) continue;
          const list = byRef.get(r.reference) ?? [];
          if (!list.some((x) => x.path === file.path)) list.push({ scope: checkout.scope, path: file.path });
          byRef.set(r.reference, list);
        }
      }
    }
    for (const reference of [...byRef.keys()].sort()) {
      rows.push({ cells: [reference, "", ""], tone: "heading", reference: known(reference) });
      for (const x of byRef.get(reference)!) {
        rows.push({ cells: [`  ${x.scope}`, x.path, ""], tone: "normal", reference: known(reference) });
      }
    }
    if (refs.unresolvable.length > 0) {
      rows.push({ cells: ["Not in the vault", "", ""], tone: "heading" });
      for (const u of refs.unresolvable) rows.push({ cells: [`  ${u.reference}`, u.file, u.scope], tone: "problem" });
    }
  }

  if (refs.unreachable.length > 0) {
    rows.push({ cells: ["Unreachable", "", ""], tone: "heading" });
    for (const u of refs.unreachable) rows.push({ cells: [`  ${u.scope}`, u.rootPath, u.reason], tone: "problem" });
  }
  if (refs.unreadable.length > 0) {
    rows.push({ cells: ["Could not read", "", ""], tone: "heading" });
    for (const u of refs.unreadable) rows.push({ cells: [`  ${u.scope}`, u.file, u.reason], tone: "problem" });
  }
  if (refs.unused.length > 0) {
    const partial = refs.unreachable.length + refs.unreadable.length > 0;
    rows.push({
      cells: [partial ? "Referenced by no project that could be read" : "Referenced by no project", "", ""],
      tone: "heading",
    });
    for (const reference of refs.unused) {
      rows.push({ cells: [`  ${reference}`, "", ""], tone: "normal", reference: known(reference) });
    }
  }
  return rows;
}
