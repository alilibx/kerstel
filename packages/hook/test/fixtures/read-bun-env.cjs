// Prints Bun.env[argv[2]] (the raw object the hook cannot proxy), then a
// separator, then the same variable through process.env, or an error line for
// the second read. Under Node, where Bun is undefined, prints NOBUN.
const name = process.argv[2];
if (typeof Bun === "undefined") {
  process.stdout.write("NOBUN");
} else {
  process.stdout.write(String(Bun.env[name]));
  process.stdout.write("|");
  try {
    process.stdout.write(String(process.env[name]));
  } catch (error) {
    process.stdout.write(`ERROR:${error.code || "unknown"}`);
  }
}
