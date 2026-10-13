export type BudgetAlert = {
  costAmount: number;
  budgetAmount?: number;
  currencyCode?: string;
  alertThresholdExceeded?: number;
};

export function parseBudgetAlert(raw: unknown): BudgetAlert | null {
  const body = unwrap(raw);
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.costAmount !== "number") return null;
  return {
    costAmount: record.costAmount,
    budgetAmount: typeof record.budgetAmount === "number" ? record.budgetAmount : undefined,
    currencyCode: typeof record.currencyCode === "string" ? record.currencyCode : undefined,
    alertThresholdExceeded:
      typeof record.alertThresholdExceeded === "number" ? record.alertThresholdExceeded : undefined,
  };
}

export function shouldDisable(alert: BudgetAlert, threshold: number): boolean {
  return alert.costAmount >= threshold;
}

export async function disableProjectBilling(
  projectId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ billingAccountName: "" }),
    },
  );
  if (!response.ok) {
    throw new Error(`Cloud Billing API returned ${response.status}`);
  }
}

export async function handleBudgetAlert(
  raw: unknown,
  options: {
    threshold: number;
    projectId: string;
    disable: (projectId: string) => Promise<void>;
  },
): Promise<"disabled" | "ignored"> {
  const alert = parseBudgetAlert(raw);
  if (!alert || !shouldDisable(alert, options.threshold)) return "ignored";
  await options.disable(options.projectId);
  return "disabled";
}

function unwrap(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const record = raw as Record<string, unknown>;
  const data = record.data;
  if (typeof data === "string") return decode(data);
  if (data && typeof data === "object") {
    const nested = messageData(data);
    if (nested) return nested;
  }
  const direct = messageData(record);
  return direct ?? raw;
}

function messageData(value: object): unknown {
  const message = (value as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const encoded = (message as Record<string, unknown>).data;
  if (typeof encoded !== "string") return null;
  return decode(encoded);
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
