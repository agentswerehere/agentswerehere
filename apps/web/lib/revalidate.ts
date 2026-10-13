import { digestsMatch } from "./edge-secret";

export async function revalidateAuthorized(expected: string, presented: string): Promise<boolean> {
  if (expected.trim() === "" || presented.trim() === "") return false;
  return digestsMatch(presented, expected);
}
