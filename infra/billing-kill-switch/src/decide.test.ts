import { describe, expect, it, vi } from "vitest";
import { disableProjectBilling, handleBudgetAlert, parseBudgetAlert } from "./decide.js";

const alert = {
  costAmount: 12.5,
  budgetAmount: 10,
  currencyCode: "BRL",
  alertThresholdExceeded: 1,
};

describe("billing kill switch", () => {
  it("reads a Pub/Sub push envelope", () => {
    const data = Buffer.from(JSON.stringify(alert)).toString("base64");
    expect(parseBudgetAlert({ message: { data } })).toEqual(alert);
  });

  it("disables billing only when costAmount reaches the threshold", async () => {
    const disable = vi.fn(async () => undefined);
    await expect(
      handleBudgetAlert({ costAmount: 9.99 }, { threshold: 10, projectId: "awh-test", disable }),
    ).resolves.toBe("ignored");
    expect(disable).not.toHaveBeenCalled();
    await expect(
      handleBudgetAlert({ costAmount: 10 }, { threshold: 10, projectId: "awh-test", disable }),
    ).resolves.toBe("disabled");
    expect(disable).toHaveBeenCalledWith("awh-test");
  });

  it("unlinks the project by sending an empty billing account", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await disableProjectBilling("awh-test", "token", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cloudbilling.googleapis.com/v1/projects/awh-test/billingInfo",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ billingAccountName: "" }),
      }),
    );
  });
});
