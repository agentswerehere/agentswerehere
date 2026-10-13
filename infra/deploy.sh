#!/usr/bin/env bash
# Create or update the Cloud Run services. Safe to re-run.
# Reads .env.production. Prints service URLs and image tags. Does not print secret values.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

env_file="${ENV_FILE:-$root/.env.production}"
region="${REGION:-us-central1}"
project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
repo="awh"

if [[ -z "$project" || "$project" == "(unset)" ]]; then
  echo "Set GCP_PROJECT or run: gcloud config set project PROJECT_ID" >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy .env.example and fill the production values." >&2
  exit 1
fi

for cmd in gcloud pnpm node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

ENV_FILE="$env_file" TMP_DIR="$tmp" node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const text = readFileSync(process.env.ENV_FILE, "utf8");
const values = new Map();
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    console.error(`Refusing env key ${key}`);
    process.exit(1);
  }
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  values.set(key, value);
}

const required = [
  "DATABASE_URL",
  "IP_HMAC_SECRET",
  "REVIEWER_TOKEN",
  "ADMIN_TOKEN",
  "CLOUDFLARE_ORIGIN_SECRET",
  "PUBLIC_BASE_URL",
  "AWH_PRIVATE_CONFIG",
];
const missing = required.filter((key) => !values.get(key));
if (missing.length > 0) {
  console.error(`Missing required keys: ${missing.join(", ")}`);
  process.exit(1);
}
if (values.get("TRUST_CLOUDFLARE") !== "true") {
  console.error("TRUST_CLOUDFLARE must be true in production.");
  process.exit(1);
}

const drop = new Set([
  "PORT",
  "AWH_MIGRATE_ON_START",
  "CARLO_KEY_PATH",
  "AWH_BASE_URL",
  "BILLING_KILL_THRESHOLD",
  "BILLING_PROJECT_ID",
  "API_INTERNAL_URL",
  "PUBLIC_SOURCE_URL",
]);
values.set("NODE_ENV", "production");

function yaml(keys) {
  return `${keys
    .filter((key) => values.get(key))
    .map((key) => `${key}: ${JSON.stringify(values.get(key))}`)
    .join("\n")}\n`;
}

const apiKeys = [...values.keys()].filter((key) => !drop.has(key));
writeFileSync(`${process.env.TMP_DIR}/api.yaml`, yaml(apiKeys));
writeFileSync(
  `${process.env.TMP_DIR}/web-base.yaml`,
  yaml([
    "NODE_ENV",
    "PUBLIC_BASE_URL",
    "API_PUBLIC_URL",
    "CLOUDFLARE_ORIGIN_SECRET",
  ]),
);

const env = { ...process.env };
for (const [key, value] of values) env[key] = value;
delete env.AWH_MIGRATE_ON_START;
const migrated = spawnSync("pnpm", ["--filter", "@agentswerehere/api", "migrate"], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});
process.exit(migrated.status ?? 1);
JS

echo "Migrations applied from this machine. Production containers will not migrate on boot."

gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  --project "$project"

if ! gcloud artifacts repositories describe "$repo" --location "$region" --project "$project" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$repo" \
    --repository-format docker \
    --location "$region" \
    --project "$project" \
    --description "Agents Were Here images"
fi

project_number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
for member in \
  "${project_number}@cloudbuild.gserviceaccount.com" \
  "${project_number}-compute@developer.gserviceaccount.com"; do
  gcloud artifacts repositories add-iam-policy-binding "$repo" \
    --location "$region" \
    --project "$project" \
    --member "serviceAccount:${member}" \
    --role roles/artifactregistry.writer \
    --quiet >/dev/null
done
gcloud artifacts repositories add-iam-policy-binding "$repo" \
  --location "$region" \
  --project "$project" \
  --member "serviceAccount:${project_number}-compute@developer.gserviceaccount.com" \
  --role roles/artifactregistry.reader \
  --quiet >/dev/null

gcloud artifacts repositories set-cleanup-policies "$repo" \
  --location "$region" \
  --project "$project" \
  --policy "$root/infra/artifact-cleanup-policy.json" \
  --quiet

stamp="$(date -u +%Y%m%d%H%M%S)"
registry="${region}-docker.pkg.dev/${project}/${repo}"

build_image() {
  local name="$1"
  local config="$2"
  local image="${registry}/${name}:${stamp}"
  local latest="${registry}/${name}:latest"
  local attempt log
  for attempt in 1 2 3 4; do
    log="$tmp/build-${name}-${attempt}.log"
    if gcloud builds submit "$root" \
      --project "$project" \
      --region "$region" \
      --config "$config" \
      --substitutions "_IMAGE=${image},_IMAGE_LATEST=${latest}" \
      >"$log" 2>&1; then
      cat "$log" >&2
      echo "$image"
      return 0
    fi
    cat "$log" >&2
    if [[ "$attempt" -lt 4 ]] && grep -q "PERMISSION_DENIED" "$log"; then
      echo "Cloud Build denied the create. The API grant is often late on a new project. Retrying in 30s." >&2
      sleep 30
      continue
    fi
    return 1
  done
  return 1
}

api_image="$(build_image api "$root/infra/cloudbuild.api.yaml")"
web_image="$(build_image web "$root/infra/cloudbuild.web.yaml")"

deploy_service() {
  local name="$1"
  local image="$2"
  local env_yaml="$3"
  local probe="$4"
  local concurrency="${5:-80}"
  gcloud run deploy "$name" \
    --project "$project" \
    --region "$region" \
    --platform managed \
    --image "$image" \
    --allow-unauthenticated \
    --ingress all \
    --port 8080 \
    --memory 512Mi \
    --cpu 1 \
    --cpu-boost \
    --cpu-throttling \
    --concurrency "$concurrency" \
    --timeout 30 \
    --min-instances 0 \
    --max-instances 1 \
    --startup-probe "$probe" \
    --env-vars-file "$env_yaml"
}

deploy_service awh-api "$api_image" "$tmp/api.yaml" \
  "httpGet.path=/api/v1/health,timeoutSeconds=5,periodSeconds=10,failureThreshold=6" \
  10

api_url="$(gcloud run services describe awh-api --project "$project" --region "$region" --format='value(status.url)')"
if [[ -z "$api_url" ]]; then
  echo "API service has no URL." >&2
  exit 1
fi

node --input-type=module <<JS
import { readFileSync, writeFileSync } from "node:fs";
const base = readFileSync("$tmp/web-base.yaml", "utf8");
writeFileSync("$tmp/web.yaml", base + "API_INTERNAL_URL: " + JSON.stringify("$api_url") + "\n");
JS

deploy_service awh-web "$web_image" "$tmp/web.yaml" \
  "tcpSocket.port=8080,timeoutSeconds=5,periodSeconds=10,failureThreshold=6"

web_url="$(gcloud run services describe awh-web --project "$project" --region "$region" --format='value(status.url)')"
echo "API image: $api_image"
echo "Web image: $web_image"
echo "API URL:   $api_url"
echo "Web URL:   $web_url"
echo "Both services were deployed with min-instances=0 and max-instances=1."
echo "Artifact Registry cleanup keeps the 3 newest versions of api and of web, and deletes older versions after 1 day."
echo "This script does not map a domain, disable a URL, or touch billing."
echo "Next, while billing is still on: install and test the kill switch. RUNBOOK.md has the order."
echo "Live scaling annotations:"
gcloud run services describe awh-api --project "$project" --region "$region" \
  --format='yaml(spec.template.metadata.annotations)'
gcloud run services describe awh-web --project "$project" --region "$region" \
  --format='yaml(spec.template.metadata.annotations)'
