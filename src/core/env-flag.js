"use strict";

// One truthiness rule for every `CYBERBOSS_*_ENABLED` style switch.
//
// Why this module exists (2026-08-05, first fable-chat canary): the deployment
// writes `CYBERBOSS_SUBJECT_SIGNING_ENABLED=1` -- the repo convention every
// other switch uses -- while two readers of that *same* variable disagreed on
// what counts as on. The bridge used the permissive form, judged the flag on
// and forwarded the string "true" into the tool server's environment; the tool
// server (which, since the env-file forwarding fix, really does load the
// deployment env file, with override) had it replaced by `1` again and used
// `=== "true"`, so it judged the same flag off and never registered
// memory_candidate_submit.
//
// Same semantics, two implementations, only one of them updated. Every reader
// of a deployment switch goes through here so that cannot recur -- and so a
// deployment can write `1`, `true`, `yes` or `on` without having to know which
// process reads it.
const ENABLED_PATTERN = /^(?:1|true|yes|on)$/i;

/** True when a raw environment value means "on". */
function isEnabledFlagValue(value) {
  return ENABLED_PATTERN.test(String(value ?? "").trim());
}

/** True when `name` is set to an "on" value in `env`. */
function envFlagEnabled(name, env = process.env) {
  return isEnabledFlagValue(env?.[name]);
}

module.exports = { ENABLED_PATTERN, envFlagEnabled, isEnabledFlagValue };
