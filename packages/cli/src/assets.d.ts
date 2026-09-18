/**
 * `import x from "./thing.cjs" with { type: "file" }` is a Bun bundler feature:
 * the import evaluates to a PATH string, and `bun build --compile` embeds the
 * file's bytes in the binary. TypeScript has no notion of it, and the target
 * (packages/hook/dist/*.cjs) is a build artifact that need not exist when
 * `tsc` runs, so declare the shape here rather than depending on the file.
 */
declare module "*.cjs" {
  const path: string;
  export default path;
}
