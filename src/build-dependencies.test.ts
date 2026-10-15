// Contract tests for article-page cache dependencies.
import {
  templateTypeCollectionDependencies,
  typeCollectionDependencySignature,
} from "./build-dependencies.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const actual = JSON.stringify(got);
  const expected = JSON.stringify(want);
  if (actual === expected) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}\n    got : ${actual}\n    want: ${expected}`);
  }
}

console.log("templateTypeCollectionDependencies");
check(
  "type collection references are extracted, deduplicated and sorted",
  templateTypeCollectionDependencies(`
    [[#each type:products:50]][[/each]]
    [[#each type:news:3]][[/each]]
    [[#each type:products:10]][[/each]]
  `),
  ["news", "products"],
);
check(
  "other data-reference kinds do not become type dependencies",
  templateTypeCollectionDependencies(`
    [[#each category:entamy:50]][[/each]]
    [[#each articles:latest:8]][[/each]]
  `),
  [],
);
check(
  "the optional count and type:all follow the renderer grammar",
  templateTypeCollectionDependencies(
    "[[#each   type:all]][[/each]][[#each type:products:]][[/each]]",
  ),
  ["all", "products"],
);

console.log("typeCollectionDependencySignature");
const maxTs = new Map([
  ["news", "2026-10-01T00:00:00Z"],
  ["products", "2026-10-15T00:00:00Z"],
]);
const liveSig = new Map([
  ["news", "2:2026-10-01T00:00:00Z"],
  ["products", "4:2026-10-15T00:00:00Z"],
]);
check(
  "a named dependency includes only its collection state",
  typeCollectionDependencySignature(["products"], maxTs, liveSig),
  "products=2026-10-15T00:00:00Z:4:2026-10-15T00:00:00Z",
);
const productsBefore = typeCollectionDependencySignature(
  ["products"],
  maxTs,
  liveSig,
);
const changedMaxTs = new Map(maxTs);
changedMaxTs.set("products", "2026-10-15T01:00:00Z");
check(
  "updating the referenced collection invalidates the article cache key",
  typeCollectionDependencySignature(["products"], changedMaxTs, liveSig) ===
    productsBefore,
  false,
);
check(
  "dependency order does not change the cache key",
  typeCollectionDependencySignature(
    ["products", "news", "products"],
    maxTs,
    liveSig,
  ),
  "news=2026-10-01T00:00:00Z:2:2026-10-01T00:00:00Z|products=2026-10-15T00:00:00Z:4:2026-10-15T00:00:00Z",
);
check(
  "type:all includes every known type",
  typeCollectionDependencySignature(["all"], maxTs, liveSig),
  "news=2026-10-01T00:00:00Z:2:2026-10-01T00:00:00Z|products=2026-10-15T00:00:00Z:4:2026-10-15T00:00:00Z",
);
check(
  "no collection reference adds no cache fragment",
  typeCollectionDependencySignature([], maxTs, liveSig),
  "",
);

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall build-dependency tests passed");
