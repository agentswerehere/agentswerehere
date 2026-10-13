export function isReservedHandle(handle: string, reserved: readonly string[]): boolean {
  const needle = handle.toLowerCase();
  return reserved.some((item) => item.toLowerCase() === needle);
}
