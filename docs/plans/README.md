Phase plans for `docs/SPEC.md` §10, one per phase (P0–P13), plus the occasional scope-reduction
plan slotted between phases (e.g. `P4b-remove-electron.md`).

A phase is planned here before it is implemented; see `AGENTS.md`. Each plan closes with a
Findings section recorded during implementation — later phases read it as inherited context.

Phase 14 is worktree support (`SPEC.md` §10), not planned yet — no `P14-flatbuffers-migration.md`
was ever written; phase number 14 was reassigned before that. The FlatBuffers migration this note
used to describe is `P15.md`'s original brief: designed and implemented out of sequence, ahead of
P7, and declined on measured grounds (D33) rather than built — see `P15.md`'s own Findings for
the measurements and the base64-encoding fix that shipped instead.
