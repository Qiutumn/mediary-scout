import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";

// Load into the environment without passing --env-file to Next's child process.
loadEnvFile(".local/dev.env");
const child = spawn(process.execPath, [
  "node_modules/next/dist/bin/next", "dev", "apps/web",
  "--hostname", "127.0.0.1", "--port", "3001",
], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
