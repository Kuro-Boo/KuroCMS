/**
 * Dynamic article collections embedded by a template.
 *
 * An article detail page can contain a collection that is unrelated to that
 * article itself, for example `[[#each type:products:50]]`.  The collection is
 * therefore an input to the rendered page and must participate in its build
 * cache key.  Keep the token grammar identical to public.ts' data-ref parser.
 */
const TYPE_COLLECTION_RE =
  /\[\[#each\s+type:([a-z0-9_-]+)(?::[a-z0-9_-]*)?\]\]/g;

/** Return the distinct type slugs referenced by dynamic `#each` collections. */
export function templateTypeCollectionDependencies(
  sourceHtml: string,
): string[] {
  return [
    ...new Set(
      [...String(sourceHtml || "").matchAll(TYPE_COLLECTION_RE)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

/**
 * Build the cache-key fragment for the referenced type collections.
 *
 * `type:all` depends on every type.  A named type only depends on that type, so
 * adding a product does not unnecessarily invalidate article pages whose
 * template embeds an unrelated collection.
 */
export function typeCollectionDependencySignature(
  dependencies: readonly string[],
  typeMaxTs: ReadonlyMap<string, string>,
  typeLiveSig: ReadonlyMap<string, string>,
): string {
  if (!dependencies.length) return "";
  const wanted = dependencies.includes("all")
    ? [...new Set([...typeMaxTs.keys(), ...typeLiveSig.keys()])].sort()
    : [...new Set(dependencies)].sort();
  return wanted
    .map(
      (tid) =>
        `${tid}=${typeMaxTs.get(tid) || ""}:${typeLiveSig.get(tid) || "0:"}`,
    )
    .join("|");
}
