# Contributing

Thanks for helping. bc-whale is a wrapper: most contributions are catalog entries
or gap-filling features, not re-implementations of existing tools.

## Before you start

- Read the [tool contract](docs/CONTRACT.md).
- For a new third-party tool, open an issue or PR with the catalog entry only.
- For a new own capability, describe the gap it fills and why no catalog tool covers it.

## Workflow

```powershell
npm ci --ignore-scripts
npm --prefix packages/bc-whale ci --ignore-scripts
npm run verify
```

- Keep `packages/bc-whale/runtime/` in sync: run `npm run build` and commit the result.
  CI rejects stale runtime artifacts.
- Add tests for behavior you change. Live BC/Docker/cloud checks go in the package's
  `EVALUATIONS.md`, run only against disposable targets you are authorized to use.
- Never commit secrets, tenant ids, customer data, profiles or personal host configuration.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` ...).
