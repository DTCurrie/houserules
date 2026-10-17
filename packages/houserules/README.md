# houserules

The bare-name shim for [`@houserules/cli`](https://www.npmjs.com/package/@houserules/cli), so
`npx houserules` resolves. It holds no code of its own: the bin defers to the cli.

`@houserules/cli` is the real package. Read its README for what houserules does and how to
configure it. This split follows `changesets` and `@changesets/cli`.

## Usage

```sh
npx houserules init
npx houserules doctor
npx houserules update
```

## License

MIT
