/** Minimal stderr logger with secret redaction. stdout belongs to MCP. */

const secrets = new Set<string>();

export function registerSecrets(...values: readonly (string | undefined)[]): void {
  for (const value of values) {
    if (value) secrets.add(value);
  }
}

export function log(message: string): void {
  console.error(redact(message));
}

export function redact(message: string): string {
  let out = message;
  for (const secret of secrets) {
    out = out.split(secret).join("***");
  }
  return out;
}
