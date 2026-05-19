# AFK Extension

This directory contains the Pi extension entry point for `afk`.

## Current scaffold

- `index.ts` exports the package's single Pi extension factory.
- The npm package manifest loads only `./extensions/index.ts` via `pi.extensions`.
- No tools, commands, skills, prompts, or themes are registered yet.

Future behavior should be added through this entry point or imported helper modules.
