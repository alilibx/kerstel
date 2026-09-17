// Prints the resolved value of the variable named by argv[2], or an error line.
try {
  process.stdout.write(String(process.env[process.argv[2]]));
} catch (error) {
  process.stdout.write(`ERROR:${error.code || "unknown"}:${error.message}`);
  process.exitCode = 3;
}
