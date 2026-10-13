import { disableProjectBilling, handleBudgetAlert } from "./decide.js";

async function accessToken(): Promise<string> {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) throw new Error("Could not read the function access token.");
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("The metadata server returned no access token.");
  return body.access_token;
}

export async function onBudget(event: unknown): Promise<void> {
  const threshold = Number(process.env.BILLING_KILL_THRESHOLD ?? 10);
  const projectId = process.env.BILLING_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  if (!projectId) throw new Error("BILLING_PROJECT_ID is not set.");
  const result = await handleBudgetAlert(event, {
    threshold,
    projectId,
    disable: async (id) => disableProjectBilling(id, await accessToken()),
  });
  console.log(JSON.stringify({ result, threshold }));
}
