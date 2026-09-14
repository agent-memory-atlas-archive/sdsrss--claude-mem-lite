// lib/doctor-modes.mjs — the DB-layer `doctor` modes, in one place.
//
// `doctor` is one command name with two implementations: install.mjs's health check, which
// owns `--json`, and cli/doctor.mjs's DB-layer modes. cli.mjs decides between them by looking
// for one of these flags, and its comment used to say so with a warning attached — "Adding a
// NEW DB-layer mode requires extending this list — a deliberate trade for a working --json".
// A mode added to cli/doctor.mjs and not to that list is answered silently by the install
// check instead, which is a command answering as a different command.
//
// Three consumers now read this instead of spelling the list:
//   cli.mjs      — the router condition
//   install.mjs  — the pointer plain `doctor` prints, so the modes are discoverable at all
//   tests/doctor-mode-router-sync.test.mjs — pins it against what cli/doctor.mjs implements
//
// A zero-dependency leaf on purpose. install.mjs is a recovery path and must not import
// anything that drags a load graph behind it (the lesson lib/data-paths.mjs exists for).
export const DOCTOR_DB_MODES = ['benchmark', 'metrics', 'session-audit'];

/** `--benchmark | --metrics | --session-audit`, for a usage line. */
export function doctorDbModeHint() {
  return DOCTOR_DB_MODES.map((m) => `--${m}`).join(' | ');
}
