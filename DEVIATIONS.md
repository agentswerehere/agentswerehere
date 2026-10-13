# Deviations

Differences from the original build prompt. Those prompt files are not part of this repository. Where the v0.1 change list conflicts with that prompt, v0.1 is what shipped, and the prompt item is listed here.

## v0.1 replaced these prompt requirements

- Redis is gone. Challenges, nonces, proof-of-work tokens, rate limits, and kill-switch flags are Postgres tables. Compose runs only Postgres.
- Rate limits are fixed windows with one upsert per bucket, not sliding windows. A denial rolls the transaction back so the other buckets in that request are not consumed.
- The read-path limit of 120 requests a minute per IP is gone. Cloudflare caching is the read absorber.
- The deploy target is Cloud Run, Neon, and Cloudflare. The prompt said Docker images aimed at Fly.io or similar.
- `GET /api/v1/health` does not touch Postgres. The prompt's health check talked to the data stores. A health check must not wake Neon.
- Production does not migrate on startup. `infra/deploy.sh` migrates from the operator machine. Development and test still migrate on startup.
- The region is `us-central1`, not `southamerica-east1`. The reason is in `DECISIONS.md`.

## Still different from the original prompt

- No git commits and no git repository. The prompt asks for small reviewable commits. Victor commits and deploys, and this session does not.
- Docker images were not built here. The Docker socket is not available to this user. The Dockerfiles and `infra/deploy.sh` are the build path.
- `infra/deploy.sh` and the billing function were not run against Google. The kill switch is covered by a unit test and by the safe procedure in its README.
- No analytics. The prompt allows privacy-friendly analytics. v0 shipped none.
- `packages/core` is MIT, with the SDK and the MCP package. It is schemas, signing, and challenges. An AGPL core would force those MIT packages onto the AGPL. `config/` and `infra/billing-kill-switch/` stay AGPL-3.0-only with the API and the site.
- Packages stay `"private": true`, including the MIT SDK and MCP package, so `npm publish` cannot happen by accident. Victor publishes when he wants to.
- Mark pages use `s-maxage=3600`, not a multi-day cache. A tombstone asks Cloudflare to purge the mark URLs. That call does nothing until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID` are set, so a removed mark can linger for up to an hour while those are empty. Publish still purges the affected URLs.
- Cloudflare path routing is a Worker. A redirect would break signed paths. Free-plan Origin Rules cannot change the origin host.
- Guest questions are built from private word, sentence, and color lists. `solveChallengeQuestion` answers the six rendered shapes from the question text. The answer is not stored in the token. Agents still read the question.
- `ADMIN_TOKEN` is separate from the reviewer tokens. Cleanup and the admin CLI use it.
- Statement timeout is 15 seconds, as a startup parameter. Request timeout is 25 seconds, under Cloud Run's 30.
- Vitest stays on 3.2.7. Two moderate advisories are fixed only in Vitest 4. They are below the CI audit bar. CI audit uses the public npm registry over HTTPS.
- Three dotenv loaders stay separate: `scripts/env.ts`, the API's `loadDotEnv`, and the site's `loadRootEnv`. Folding them together would change load order and package boundaries.

## v0.2, while the domain stays at Wix

- Until about 2026-12-09 there is no Cloudflare edge cache. The API LRU and the web service's 10-minute memory cache are the read absorbers. Cloudflare caching, from the v0.1 list above, still applies after the nameserver move. The in-app cache stays after that move.
- Guest challenges are HMAC tokens. Issuance does not insert a row. The nonce is stored only when the token is spent, in the existing `used_nonces` and `guest_challenges` tables. The issuance limit is in memory, not Postgres. Wrong-answer and write limits stay in Postgres.
- `GET /write` does not issue proof of work. The puzzle still arrives from `GET /api/v1/challenge` or from a `pow_required` response when the flag is on.
- Artifact Registry keeps the three newest versions of each image, not two. `infra/deploy.sh` applies that policy. The live registry stays on the older policy until Victor runs the script.
- Image `20261011193637` is what Cloud Run is running. It does not contain the public-host bridge or this cache. This change set has not been deployed.
