# Pi Extension Template

Production-ready starting point for a TypeScript extension package for [Pi](https://pi.dev).

## Included

- Node.js 24 runtime contract
- Bun 1.3.14 development workflow
- TypeScript 7 strict configuration
- Biome 2.5.4 formatting, linting, and import organization
- Node `node:test` tests and native coverage gates
- Pi package manifest smoke test
- Packed npm production-install smoke test against Pi 0.80.10
- GitHub Actions CI and tag-based GitHub Releases
- Minimal `hello_pi` tool example

## Create an extension

1. Click **Use this template** on GitHub.
2. Clone the generated repository.
3. Replace template identity:
   - package name and description in `package.json`
   - heading and documentation in `README.md`
   - `hello_pi` tool name, schema, and implementation
4. Keep Pi core imports as `"*"` peer dependencies.
5. Pin exact Pi versions only in `devDependencies` for reproducible CI.

## Development

```bash
bun install
bun run quality
bun run typecheck
bun run test
bun run test:coverage
bun run smoke
bun run package:check
bun run smoke:package
bun run ci
```

Pi loads TypeScript source directly through Jiti. No build step is required.

## Package contract

`package.json` declares the extension entry:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Runtime dependencies that are not provided by Pi belong in `dependencies`. Pi-provided packages imported by source belong in `peerDependencies` with a `"*"` range.

## Test locally in Pi

```bash
pi --offline --no-extensions -e . --list-models
pi install -l file:./
```

## Release

Update `package.json` version, commit, then push a matching tag:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Release workflow verifies the package before creating a GitHub Release.

## License

MIT
