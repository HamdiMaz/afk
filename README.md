# afk

A Pi package extension that allows the agent to communicate with the user when they're afk.

## Status

This repository is scaffolded as a Pi extension package. The extension entry point is in `extensions/index.ts`; no runtime tools or commands are registered yet.

## Install for local development

```bash
npm install
npm run check
```

## Use with Pi during development

```bash
pi -e .
```

Pi loads the package through `package.json`:

```json
{ "pi": { "extensions": ["./extensions/index.ts"] } }
```

## Project layout

```text
extensions/index.ts      Pi extension entry point
extensions/README.md     Extension-specific notes
tests/                   Node test runner tests
```

## Release checks

```bash
npm run check
```
