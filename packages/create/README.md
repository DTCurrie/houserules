# @houserules/create

The initializer for [`@houserules/cli`](https://www.npmjs.com/package/@houserules/cli). It adds
the cli to the repo's devDependencies with the package manager that invoked it and runs
`houserules init`. It holds no logic of its own beyond that.

`@houserules/cli` is the real package. Read its README for what houserules does and how to
configure it.

## Usage

In the repo to set up:

```sh
npm create @houserules
pnpm create @houserules
yarn create @houserules
```

Everything after the name goes to `init`, so `pnpm create @houserules --yes` skips the prompts
and `--dry-run` previews the writes. The install happens either way. After that, the binary is
local, and every later command is `pnpm houserules <cmd>` or `npx houserules <cmd>`.

## License

MIT
