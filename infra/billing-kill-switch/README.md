# Billing kill switch

Google budget alerts send mail. They do not stop billing. This function does.

When a budget notification arrives and `costAmount` is at least `BILLING_KILL_THRESHOLD` (default 10), the function unlinks the project from its billing account:

```
PUT https://cloudbilling.googleapis.com/v1/projects/{projectId}/billingInfo
{ "billingAccountName": "" }
```

The threshold is a number in the budget's currency. Create the budget in BRL. Then 10 means R$10. The function does not convert currencies.

Google's cost figures lag by a few hours. The stop is approximate. A burst can pass R$10 before the notification exists. Disabling billing takes the site offline, including Cloud Run, until someone links the billing account again. That trade-off is intentional. A surprise bill is worse than an outage you can reverse.

## Permissions

The function's service account needs `billing.resourceAssociations.delete` on the billing account, not only on the project. The Cloud Billing API checks the account.

Prefer a custom role that contains only that permission, granted on the billing account. Custom roles that a project creates cannot be attached to a billing account unless the role lives on the organization. If this account has no organization, the smallest predefined role that can unlink a project is Billing Account Administrator (`roles/billing.admin`) on that billing account. Do not grant it on unrelated accounts.

The function reads its own access token from the metadata server. It has no other GCP calls.

## Deploy

Run this once, after `pnpm install` at the repo root. Use the production project only after the safe test below has succeeded on a throwaway project.

```bash
gcloud iam service-accounts create awh-billing-kill --project "$PROJECT"

# Organization available: a one-permission role, granted on the billing account.
# gcloud iam roles create billingKill --organization "$ORG" \
#   --permissions billing.resourceAssociations.delete --title "Disable project billing"
# gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
#   --member "serviceAccount:awh-billing-kill@${PROJECT}.iam.gserviceaccount.com" \
#   --role "organizations/${ORG}/roles/billingKill"

# No organization: predefined admin on this billing account only.
gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
  --member "serviceAccount:awh-billing-kill@${PROJECT}.iam.gserviceaccount.com" \
  --role roles/billing.admin

gcloud pubsub topics create awh-billing-alerts --project "$PROJECT"

# The function calls the Cloud Billing API. A new project does not have it enabled.
gcloud services enable cloudbilling.googleapis.com --project "$PROJECT"

gcloud functions deploy awh-billing-kill \
  --project "$PROJECT" \
  --gen2 \
  --runtime nodejs22 \
  --region us-central1 \
  --source infra/billing-kill-switch \
  --entry-point onBudget \
  --trigger-topic awh-billing-alerts \
  --service-account "awh-billing-kill@${PROJECT}.iam.gserviceaccount.com" \
  --set-env-vars "BILLING_KILL_THRESHOLD=10,BILLING_PROJECT_ID=${PROJECT}" \
  --max-instances 1 \
  --memory 256Mi \
  --timeout 30s \
  --retry

# The trigger identity is the default compute service account unless
# --trigger-service-account was set. Without roles/run.invoker, Pub/Sub
# retries and the function never runs. Do not grant allUsers.
trigger_sa="$(gcloud functions describe awh-billing-kill \
  --project "$PROJECT" \
  --region us-central1 \
  --gen2 \
  --format='value(eventTrigger.serviceAccountEmail)')"
gcloud run services add-iam-policy-binding awh-billing-kill \
  --project "$PROJECT" \
  --region us-central1 \
  --member "serviceAccount:${trigger_sa}" \
  --role roles/run.invoker

gcloud billing budgets create \
  --billing-account "$BILLING_ACCOUNT" \
  --display-name "awh hard stop" \
  --budget-amount 10BRL \
  --calendar-period month \
  --filter-projects "projects/${PROJECT}" \
  --threshold-rule percent=1.0 \
  --notifications-rule-pubsub-topic "projects/${PROJECT}/topics/awh-billing-alerts"
```

Leave the budget's default email on. A threshold rule wants a notification channel, and the email is how you hear about the stop before you look at the project. The Pub/Sub message is what actually disables billing.

`infra/deploy.sh` does not deploy this function. Shipping the site and arming the kill switch are separate steps so a deploy cannot disable billing by accident.

## Safe test

Use a throwaway project with its own billing link. Do not point this at the production project.

1. Deploy the function there with `BILLING_PROJECT_ID` set to the throwaway project and a throwaway topic.
2. Publish a fake notification. `costAmount` is 15, above the threshold of 10:

```bash
gcloud pubsub topics publish awh-billing-alerts \
  --project "$TEST_PROJECT" \
  --message '{"costAmount":15,"currencyCode":"BRL","budgetAmount":10,"budgetAmountType":"SPECIFIED_AMOUNT","alertThresholdExceeded":1}'
```

3. Wait for the function log to say `{"result":"disabled","threshold":10}`.
4. Confirm the link is gone:

```bash
gcloud billing projects describe "$TEST_PROJECT"
```

`billingAccountName` is empty. Cloud Run on that project stops.

5. Put billing back:

```bash
gcloud billing projects link "$TEST_PROJECT" --billing-account "$BILLING_ACCOUNT"
```

A message with `costAmount` under the threshold logs `ignored` and does not call the API. The unit test in `src/decide.test.ts` covers that decision without calling Google.

## Re-enable production

After a real stop:

```bash
gcloud billing projects link "$PROJECT" --billing-account "$BILLING_ACCOUNT"
```

Cloud Run services come back with the same configuration. Neon is independent of this billing account and is still there. Then read `RUNBOOK.md` if the project itself was deleted rather than only unlinked.
