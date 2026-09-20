// Reads SWAP (resolved at startup under Bun), rewrites it through Bun.env to
// a different reference, which bypasses the proxy's set trap, then reads it
// through process.env. A cache keyed by name alone would print the old value.
process.stdout.write(String(process.env.SWAP));
Bun.env.SWAP = "kerstel://global/SWAP_B";
process.stdout.write("|" + String(process.env.SWAP));
