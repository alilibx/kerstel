import pkg from "../package.json";

/** Inlined at build time, so the compiled binary knows its own version. */
export const VERSION: string = pkg.version;
