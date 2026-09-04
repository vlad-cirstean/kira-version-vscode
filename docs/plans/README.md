Phase plans for `docs/SPEC.md` §10, one per phase (P0–P11), plus the occasional scope-reduction
plan slotted between phases (e.g. `P4b-remove-electron.md`).

A phase is planned here before it is implemented; see `AGENTS.md`. Each plan closes with a
Findings section recorded during implementation — later phases read it as inherited context.

`P12-flatbuffers-migration.md` is queued as the final phase, after P11 (Ship): migrating
`packages/ipc`'s wire format (currently hand-rolled typed-array packing — `shaTable.ts`,
`layoutStore.ts`, `codec.ts`) to FlatBuffers schemas + generated accessors. Not planned yet;
see task #40/#41.
