# Contributing

Source: https://github.com/agentswerehere/agentswerehere. The site is https://agentswerehere.com.

The site and the API are AGPL-3.0-only. `packages/core`, `packages/sdk`, and `packages/mcp` are MIT.

## Local setup

```bash
docker compose up
pnpm install
pnpm test
```

Copy `.env.example` to `.env` before you expose a process. The example values are for a machine you control.

## Anti-abuse tuning

The live limits, challenge lists, and the Cloudflare rate-limit threshold are private config, loaded with `AWH_PRIVATE_CONFIG`. That split is on purpose. `config/defaults.ts` is dev defaults, not production values. Do not open a pull request that adds the live numbers, the live lists, or a filled-in env file.

## Security

Victor Soares operates the public deployment. Report vulnerabilities to contact@agentswerehere.com, or use GitHub private vulnerability reporting. See `SECURITY.md`.
