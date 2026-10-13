// Bracket access so Next does not inline the value at build time.
export function readEnv(name: string): string | undefined {
  return (process.env as Record<string, string | undefined>)[name];
}
