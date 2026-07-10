const DRIVE_KEYS = [
  "attachment",
  "curiosity",
  "reflection",
  "duty",
  "social",
  "fatigue",
  "libido",
  "stress",
];

const ThoughtOrigin = Object.freeze({
  USER: "USER",
  SELF: "SELF",
  MEMORY: "MEMORY",
  WORLD: "WORLD",
});

const THOUGHT_ORIGINS = Object.freeze(Object.values(ThoughtOrigin));

const DEFAULT_DRIVE = Object.freeze({
  attachment: 0.34,
  curiosity: 0.38,
  reflection: 0.28,
  duty: 0.22,
  social: 0.24,
  fatigue: 0.18,
  libido: 0.31,
  stress: 0.16,
});

const DRIVE_RATES_PER_HOUR = Object.freeze({
  attachment: 0.03,
  curiosity: 0.05,
  reflection: 0.028,
  duty: 0.024,
  social: 0.032,
  fatigue: 0.045,
  libido: 0.05,
  stress: 0.018,
});

const DRIVE_TO_ACTION = Object.freeze({
  attachment: "none",
  curiosity: "web_search",
  reflection: "co_read",
  duty: "none",
  social: "web_browse",
  fatigue: "none",
  libido: "tease",
  stress: "vent",
});

const ACTION_SATISFY = Object.freeze({
  co_read: Object.freeze({ reflection: 0.45, curiosity: 0.85 }),
  github: Object.freeze({ curiosity: 0.5 }),
  web_search: Object.freeze({ curiosity: 0.48 }),
  web_browse: Object.freeze({ social: 0.48, curiosity: 0.82 }),
  none: Object.freeze({ attachment: 0.58, duty: 0.8 }),
  tease: Object.freeze({ libido: 0.55, attachment: 0.78 }),
  vent: Object.freeze({ stress: 0.45, attachment: 0.85 }),
});

const FLIT_DECAY = 0.82;
const FIXATION_GROW = 1.1;
const FLIT_TO_FIXATION = 0.8;
const FIXATION_FEED = 0.85;
const FIXATION_FEED_GAIN = 0.18;
const FIXATION_DRIVE_BOOST = 0.35;
const FIXATION_RESOLVE_FEEDS = 3;
const DROP_BELOW = 0.06;
const FATIGUE_REST_GATE = 0.72;
const THOUGHT_TICK_MS = 30 * 60_000;
const DEFAULT_REFRACTORY_DURATIONS = Object.freeze({
  attachment: 0,
  curiosity: 2,
  reflection: 2,
  duty: 2,
  social: 2,
  fatigue: 0,
  libido: 3,
  stress: 2,
});
const DEFAULT_DESIRE_GATES = Object.freeze({
  desireDriven: false,
  coupling: false,
  baselineDrift: false,
  heartbeatAutonomy: false,
  selfDrive: false,
});
const DEFAULT_BASELINES = Object.freeze({
  attachment: 0.34,
  curiosity: 0.16,
});
const DEFAULT_SELF_DRIVE_STATE = Object.freeze({
  enabled: false,
  curiosityFloor: 0.16,
  todaySelfTriggeredCount: 0,
  lastSelfPulseAt: "",
  lastSelfPulseDrive: "",
});
const DEFAULT_HEARTBEAT_STATE = Object.freeze({
  enabled: false,
  tension: 0,
  intervalMs: 0,
});
const DEFAULT_COUPLING_EDGES = Object.freeze([
  Object.freeze({ source: "stress", target: "attachment", mode: "level", coefficient: 0.04 }),
  Object.freeze({ source: "stress", target: "curiosity", mode: "level", coefficient: -0.05 }),
  Object.freeze({ source: "attachment", target: "libido", mode: "delta", coefficient: 0.05 }),
  Object.freeze({ source: "curiosity", target: "reflection", mode: "delta", coefficient: 0.04 }),
  Object.freeze({ source: "reflection", target: "social", mode: "delta", coefficient: 0.03 }),
]);
const COUPLING_MAX_ABS_COEFFICIENT = 0.06;
const COUPLING_BASELINE_DAMPING = 0.06;
const ATTACHMENT_BASELINE_CAP = 0.5;
const ATTACHMENT_BASELINE_HOME = DEFAULT_BASELINES.attachment;
const ATTACHMENT_BASELINE_DRIFT_PER_HOUR = 0.012;
const ATTACHMENT_BASELINE_RESET_RATIO = 0.6;
const CURIOSITY_FLOOR_HOME = DEFAULT_BASELINES.curiosity;
const CURIOSITY_FLOOR_CAP = 0.42;
const CURIOSITY_FLOOR_DRIFT_PER_HOUR = 0.01;
const CURIOSITY_FLOOR_RESET_RATIO = 0.5;
const OWNER_ATTACHMENT_PULSE = 0.18;
const SELF_DRIVE_PULSE = 0.1;

function createDefaultDrive() {
  return { ...DEFAULT_DRIVE };
}

function createDefaultRefractory() {
  return {
    attachment: 0,
    curiosity: 0,
    reflection: 0,
    duty: 0,
    social: 0,
    fatigue: 0,
    libido: 0,
    stress: 0,
  };
}

function createDefaultDesireGates() {
  return { ...DEFAULT_DESIRE_GATES };
}

function createDefaultBaselines() {
  return { ...DEFAULT_BASELINES };
}

function createDefaultSelfDriveState() {
  return { ...DEFAULT_SELF_DRIVE_STATE };
}

function createDefaultHeartbeatState() {
  return { ...DEFAULT_HEARTBEAT_STATE };
}

function createDefaultCouplingEdges() {
  return DEFAULT_COUPLING_EDGES.map((edge) => ({ ...edge }));
}

function normalizeDrive(input) {
  const fallback = createDefaultDrive();
  const source = input && typeof input === "object" ? input : {};
  const next = {};
  for (const key of DRIVE_KEYS) {
    next[key] = clamp01(Number.isFinite(Number(source[key])) ? Number(source[key]) : fallback[key]);
  }
  return next;
}

function tickDrive(drive, elapsedHours = 0) {
  const next = normalizeDrive(drive);
  const hours = Math.max(0, Number(elapsedHours) || 0);
  if (!hours) {
    return next;
  }
  for (const key of DRIVE_KEYS) {
    next[key] = clamp01(next[key] + (DRIVE_RATES_PER_HOUR[key] || 0) * hours);
  }
  return next;
}

function normalizeRefractory(input) {
  const fallback = createDefaultRefractory();
  const source = input && typeof input === "object" ? input : {};
  const next = {};
  for (const key of DRIVE_KEYS) {
    next[key] = normalizeNonNegativeInteger(source[key] ?? fallback[key]);
  }
  return next;
}

function tickRefractory(refractory, steps = 1) {
  const next = normalizeRefractory(refractory);
  const totalSteps = Math.max(0, Math.floor(Number(steps) || 0));
  if (!totalSteps) {
    return next;
  }
  for (const key of DRIVE_KEYS) {
    next[key] = Math.max(0, next[key] - totalSteps);
  }
  return next;
}

function applyRefractory(refractory, driveKey, ticks = undefined) {
  const next = normalizeRefractory(refractory);
  const key = normalizeDriveKey(driveKey);
  if (!key) {
    return next;
  }
  next[key] = Math.max(
    next[key],
    normalizeNonNegativeInteger(ticks ?? DEFAULT_REFRACTORY_DURATIONS[key] ?? 0)
  );
  return next;
}

function normalizeDesireGates(input) {
  const fallback = createDefaultDesireGates();
  const source = input && typeof input === "object" ? input : {};
  return {
    desireDriven: normalizeBoolean(source.desireDriven ?? source.drivenBehaviorEnabled ?? fallback.desireDriven),
    coupling: normalizeBoolean(source.coupling ?? fallback.coupling),
    baselineDrift: normalizeBoolean(source.baselineDrift ?? fallback.baselineDrift),
    heartbeatAutonomy: normalizeBoolean(source.heartbeatAutonomy ?? fallback.heartbeatAutonomy),
    selfDrive: normalizeBoolean(source.selfDrive ?? fallback.selfDrive),
  };
}

function normalizeBaselines(input) {
  const fallback = createDefaultBaselines();
  const source = input && typeof input === "object" ? input : {};
  return {
    attachment: clamp01(Number.isFinite(Number(source.attachment)) ? Number(source.attachment) : fallback.attachment),
    curiosity: clamp01(Number.isFinite(Number(source.curiosity)) ? Number(source.curiosity) : fallback.curiosity),
  };
}

function normalizeSelfDriveState(input) {
  const fallback = createDefaultSelfDriveState();
  const source = input && typeof input === "object" ? input : {};
  return {
    enabled: normalizeBoolean(source.enabled ?? fallback.enabled),
    curiosityFloor: clamp01(
      Number.isFinite(Number(source.curiosityFloor))
        ? Number(source.curiosityFloor)
        : fallback.curiosityFloor
    ),
    todaySelfTriggeredCount: normalizeNonNegativeInteger(
      source.todaySelfTriggeredCount ?? source.today_self_triggered_count
    ),
    lastSelfPulseAt: normalizeIsoTime(source.lastSelfPulseAt ?? source.last_self_pulse_at) || "",
    lastSelfPulseDrive: normalizeDriveKey(source.lastSelfPulseDrive ?? source.last_self_pulse_drive) || "",
  };
}

function normalizeHeartbeatState(input) {
  const fallback = createDefaultHeartbeatState();
  const source = input && typeof input === "object" ? input : {};
  return {
    enabled: normalizeBoolean(source.enabled ?? fallback.enabled),
    tension: clamp01(Number.isFinite(Number(source.tension)) ? Number(source.tension) : fallback.tension),
    intervalMs: Math.max(0, Number(source.intervalMs) || fallback.intervalMs),
  };
}

function normalizeCouplingEdges(input) {
  const source = Array.isArray(input) ? input : DEFAULT_COUPLING_EDGES;
  return source
    .map((edge) => normalizeCouplingEdge(edge))
    .filter(Boolean);
}

function normalizeCouplingEdge(edge) {
  if (!edge || typeof edge !== "object") {
    return null;
  }
  const source = normalizeDriveKey(edge.source);
  const target = normalizeDriveKey(edge.target);
  const mode = normalizeCouplingMode(edge.mode);
  const coefficient = clampRange(
    Number(edge.coefficient),
    -COUPLING_MAX_ABS_COEFFICIENT,
    COUPLING_MAX_ABS_COEFFICIENT
  );
  if (!source || !target || !mode || !Number.isFinite(coefficient) || coefficient === 0) {
    return null;
  }
  return {
    source,
    target,
    mode,
    coefficient,
  };
}

function normalizeThought(thought, index = 0) {
  if (!thought || typeof thought !== "object") {
    return null;
  }
  const drive = normalizeDriveKey(thought.drive);
  const internalMonologue = normalizeText(
    thought.internal_monologue
    || thought.internalMonologue
    || thought.text
  );
  if (!drive || !internalMonologue) {
    return null;
  }
  const origin = normalizeThoughtOrigin(thought.origin);
  const rawSource = normalizeText(thought.raw_source || thought.rawSource);
  return {
    id: normalizeText(thought.id) || `thought-${index + 1}`,
    text: internalMonologue,
    internal_monologue: internalMonologue,
    raw_source: rawSource,
    origin,
    drive,
    kind: normalizeThoughtKind(thought.kind),
    strength: clamp01(thought.strength),
    bornAt: normalizeIsoTime(thought.bornAt || thought.born_at) || new Date().toISOString(),
    fedCount: normalizeNonNegativeInteger(thought.fedCount ?? thought.fed_count),
  };
}

function tickThoughts(thoughts, drive, steps = 1) {
  let nextDrive = normalizeDrive(drive);
  let nextThoughts = normalizeThoughtList(thoughts);
  const totalSteps = Math.max(0, Math.floor(Number(steps) || 0));
  if (!totalSteps) {
    return { drive: nextDrive, thoughts: nextThoughts };
  }

  for (let step = 0; step < totalSteps; step += 1) {
    const updated = [];
    for (const item of nextThoughts) {
      const thought = { ...item };
      if (thought.kind === "flit") {
        thought.strength = clamp01(thought.strength * FLIT_DECAY);
        if (thought.strength >= FLIT_TO_FIXATION) {
          thought.kind = "fixation";
        }
      } else {
        thought.strength = clamp01(thought.strength * FIXATION_GROW);
        if (thought.strength >= FIXATION_FEED) {
          nextDrive[thought.drive] = clamp01(nextDrive[thought.drive] + FIXATION_FEED_GAIN);
          thought.strength = clamp01(thought.strength * 0.7);
          thought.fedCount += 1;
        }
      }
      if (thought.fedCount >= FIXATION_RESOLVE_FEEDS || thought.strength < DROP_BELOW) {
        continue;
      }
      updated.push(thought);
    }
    nextThoughts = updated;
  }

  return { drive: nextDrive, thoughts: nextThoughts };
}

function computeScores(drive, thoughts) {
  const normalizedDrive = normalizeDrive(drive);
  const normalizedThoughts = normalizeThoughtList(thoughts);
  const scores = {};
  for (const key of DRIVE_KEYS) {
    const fixationBoost = normalizedThoughts
      .filter((thought) => thought.drive === key && thought.kind === "fixation")
      .reduce((sum, thought) => sum + thought.strength, 0);
    scores[key] = clamp01(normalizedDrive[key] + fixationBoost * FIXATION_DRIVE_BOOST);
  }
  return scores;
}

function applyCoupling({
  drive,
  previousDrive = {},
  baselines = {},
  gates = {},
  edges = undefined,
} = {}) {
  const normalizedGates = normalizeDesireGates(gates);
  const currentDrive = normalizeDrive(drive);
  if (!normalizedGates.coupling) {
    return currentDrive;
  }
  const priorDrive = normalizeDrive(previousDrive);
  const normalizedBaselines = normalizeBaselines(baselines);
  const normalizedEdges = normalizeCouplingEdges(edges);
  const next = { ...currentDrive };

  for (const edge of normalizedEdges) {
    const sourceValue = currentDrive[edge.source];
    const baseline = baselineForDrive(edge.target, normalizedBaselines);
    if (edge.mode === "level") {
      next[edge.target] = clamp01(next[edge.target] + sourceValue * edge.coefficient);
      continue;
    }
    const delta = Math.max(0, sourceValue - priorDrive[edge.source]);
    next[edge.target] = clamp01(next[edge.target] + delta * edge.coefficient);
    next[edge.target] = clamp01(next[edge.target] - (next[edge.target] - baseline) * COUPLING_BASELINE_DAMPING);
  }

  for (const key of DRIVE_KEYS) {
    const baseline = baselineForDrive(key, normalizedBaselines);
    next[key] = clamp01(next[key] - (next[key] - baseline) * COUPLING_BASELINE_DAMPING);
  }

  return next;
}

function applyBaselineDrift({
  drive,
  baselines = {},
  selfDrive = {},
  gates = {},
  elapsedHours = 0,
} = {}) {
  const normalizedDrive = normalizeDrive(drive);
  const normalizedBaselines = normalizeBaselines(baselines);
  const normalizedSelfDrive = normalizeSelfDriveState(selfDrive);
  const normalizedGates = normalizeDesireGates(gates);
  const hours = Math.max(0, Number(elapsedHours) || 0);
  const nextDrive = { ...normalizedDrive };
  const nextBaselines = { ...normalizedBaselines };
  const nextSelfDrive = { ...normalizedSelfDrive };

  if (normalizedGates.baselineDrift && hours > 0) {
    nextBaselines.attachment = clampRange(
      nextBaselines.attachment + ATTACHMENT_BASELINE_DRIFT_PER_HOUR * hours,
      ATTACHMENT_BASELINE_HOME,
      ATTACHMENT_BASELINE_CAP
    );
    nextDrive.attachment = Math.max(nextDrive.attachment, nextBaselines.attachment);
  }

  if (normalizedGates.selfDrive && hours > 0) {
    nextSelfDrive.enabled = true;
    nextSelfDrive.curiosityFloor = clampRange(
      nextSelfDrive.curiosityFloor + CURIOSITY_FLOOR_DRIFT_PER_HOUR * hours,
      CURIOSITY_FLOOR_HOME,
      CURIOSITY_FLOOR_CAP
    );
    nextDrive.curiosity = Math.max(nextDrive.curiosity, nextSelfDrive.curiosityFloor);
  } else {
    nextSelfDrive.enabled = false;
  }

  return {
    drive: normalizeDrive(nextDrive),
    baselines: normalizeBaselines(nextBaselines),
    selfDrive: normalizeSelfDriveState(nextSelfDrive),
  };
}

function applyDrivePulse({
  drive,
  baselines = {},
  selfDrive = {},
  gates = {},
  driveKey = "",
  amount = 0,
  source = "owner",
  now = "",
} = {}) {
  const normalizedDrive = normalizeDrive(drive);
  const normalizedBaselines = normalizeBaselines(baselines);
  const normalizedSelfDrive = normalizeSelfDriveState(selfDrive);
  const normalizedGates = normalizeDesireGates(gates);
  const key = normalizeDriveKey(driveKey);
  if (!key) {
    return {
      drive: normalizedDrive,
      baselines: normalizedBaselines,
      selfDrive: normalizedSelfDrive,
    };
  }
  const pulseAmount = Math.max(0, Number(amount) || 0);
  const nextDrive = { ...normalizedDrive };
  const nextBaselines = { ...normalizedBaselines };
  const nextSelfDrive = { ...normalizedSelfDrive };
  nextDrive[key] = clamp01(nextDrive[key] + pulseAmount * Math.sqrt(Math.max(0, 1 - nextDrive[key])));

  if (source === "owner" && key === "attachment" && normalizedGates.baselineDrift) {
    nextBaselines.attachment = clampRange(
      nextBaselines.attachment - (nextBaselines.attachment - ATTACHMENT_BASELINE_HOME) * ATTACHMENT_BASELINE_RESET_RATIO,
      ATTACHMENT_BASELINE_HOME,
      ATTACHMENT_BASELINE_CAP
    );
  }

  if (source === "self" && normalizedGates.selfDrive) {
    nextSelfDrive.enabled = true;
    nextSelfDrive.todaySelfTriggeredCount += 1;
    nextSelfDrive.lastSelfPulseAt = normalizeIsoTime(now) || normalizeIsoTime(new Date().toISOString()) || "";
    nextSelfDrive.lastSelfPulseDrive = key;
    if (key === "curiosity") {
      nextSelfDrive.curiosityFloor = Math.max(nextSelfDrive.curiosityFloor, CURIOSITY_FLOOR_HOME);
    }
  }

  return {
    drive: normalizeDrive(nextDrive),
    baselines: normalizeBaselines(nextBaselines),
    selfDrive: normalizeSelfDriveState(nextSelfDrive),
  };
}

function settleAfterAction({
  drive,
  baselines = {},
  selfDrive = {},
  gates = {},
  action = "",
} = {}) {
  const nextDrive = satisfy(drive, action);
  const nextBaselines = normalizeBaselines(baselines);
  const nextSelfDrive = normalizeSelfDriveState(selfDrive);
  const normalizedGates = normalizeDesireGates(gates);
  const sourceDrive = sourceDriveFor(action);

  if (normalizedGates.baselineDrift && sourceDrive === "attachment") {
    nextBaselines.attachment = clampRange(
      nextBaselines.attachment - (nextBaselines.attachment - ATTACHMENT_BASELINE_HOME) * ATTACHMENT_BASELINE_RESET_RATIO,
      ATTACHMENT_BASELINE_HOME,
      ATTACHMENT_BASELINE_CAP
    );
  }

  if (normalizedGates.selfDrive && sourceDrive === "curiosity") {
    nextSelfDrive.curiosityFloor = clampRange(
      nextSelfDrive.curiosityFloor - (nextSelfDrive.curiosityFloor - CURIOSITY_FLOOR_HOME) * CURIOSITY_FLOOR_RESET_RATIO,
      CURIOSITY_FLOOR_HOME,
      CURIOSITY_FLOOR_CAP
    );
  }

  return {
    drive: normalizeDrive(nextDrive),
    baselines: normalizeBaselines(nextBaselines),
    selfDrive: normalizeSelfDriveState(nextSelfDrive),
  };
}

function pickIntent({ drive, thoughts, availableActions = [], refractory = {}, gates = {} } = {}) {
  const normalizedDrive = normalizeDrive(drive);
  const normalizedThoughts = normalizeThoughtList(thoughts);
  const normalizedRefractory = normalizeRefractory(refractory);
  const normalizedGates = normalizeDesireGates(gates);
  const scores = computeScores(normalizedDrive, normalizedThoughts);
  const actionSet = new Set(
    (Array.isArray(availableActions) ? availableActions : [])
      .map(normalizeText)
      .filter(Boolean)
  );

  if (normalizedDrive.fatigue >= FATIGUE_REST_GATE) {
    return {
      want_action: "none",
      drive_key: "fatigue",
      reason: "有点累了，不想动，就静静待着。",
      score: normalizedDrive.fatigue,
      query_hint: strongestThoughtText(normalizedThoughts, "fatigue"),
      scores,
    };
  }

  const ranked = DRIVE_KEYS
    .filter((key) => key !== "fatigue")
    .filter((key) => !(normalizedGates.desireDriven && normalizedRefractory[key] > 0))
    .map((key) => ({ key, score: scores[key] }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  const top = ranked[0] || { key: "attachment", score: normalizedDrive.attachment };
  const preferredAction = resolveActionForDrive(top.key, strongestThoughtText(normalizedThoughts, top.key), actionSet);

  return {
    want_action: preferredAction,
    drive_key: top.key,
    reason: buildReason(top.key, preferredAction),
    score: top.score,
    query_hint: strongestThoughtText(normalizedThoughts, top.key),
    scores,
  };
}

function satisfy(drive, action) {
  const normalizedDrive = normalizeDrive(drive);
  const modifiers = ACTION_SATISFY[normalizeText(action)] || {};
  const next = { ...normalizedDrive };
  for (const key of Object.keys(modifiers)) {
    next[key] = clamp01(next[key] * modifiers[key]);
  }
  return next;
}

function computeHeartbeatState({
  drive,
  fatigue = undefined,
  baselines = {},
  gates = {},
  minIntervalMs = 15 * 60_000,
  maxIntervalMs = 180 * 60_000,
  baseIntervalMs = 60 * 60_000,
} = {}) {
  const normalizedDrive = normalizeDrive(drive);
  const normalizedBaselines = normalizeBaselines(baselines);
  const normalizedGates = normalizeDesireGates(gates);
  const tension = clamp01(
    (
      normalizedDrive.attachment
      + normalizedDrive.curiosity
      + normalizedDrive.reflection
      + normalizedDrive.social
      + normalizedDrive.libido
      + normalizedDrive.stress
      + normalizedBaselines.attachment * 0.5
      + normalizedBaselines.curiosity * 0.25
    ) / 6.75
  );
  const fatigueLevel = clamp01(fatigue ?? normalizedDrive.fatigue);
  const intervalMs = clampRange(
    baseIntervalMs * (1 + 0.85 * (1 - tension) - 0.55 * tension + 0.9 * fatigueLevel),
    minIntervalMs,
    maxIntervalMs
  );
  return {
    enabled: normalizedGates.heartbeatAutonomy,
    tension,
    intervalMs: Math.round(intervalMs),
  };
}

function feedThought(thoughts, incoming, { maxThoughts = 80, now = new Date().toISOString() } = {}) {
  const nextThoughts = normalizeThoughtList(thoughts);
  const normalized = normalizeThought({
    ...incoming,
    bornAt: incoming?.bornAt || incoming?.born_at || now,
    id: incoming?.id || "",
  }, nextThoughts.length);
  if (!normalized) {
    return nextThoughts;
  }
  const existing = nextThoughts.find(
    (item) => item.internal_monologue === normalized.internal_monologue
      && item.drive === normalized.drive
      && item.origin === normalized.origin
  );
  if (existing) {
    existing.strength = clamp01(existing.strength + Math.max(0.08, normalized.strength * 0.45));
    existing.text = normalized.internal_monologue;
    existing.internal_monologue = normalized.internal_monologue;
    if (!existing.raw_source && normalized.raw_source) {
      existing.raw_source = normalized.raw_source;
    }
    if (existing.strength >= FLIT_TO_FIXATION) {
      existing.kind = "fixation";
    }
    return sortThoughts(nextThoughts).slice(0, Math.max(1, normalizeNonNegativeInteger(maxThoughts) || 80));
  }
  const withNew = [normalized, ...nextThoughts];
  return sortThoughts(withNew).slice(0, Math.max(1, normalizeNonNegativeInteger(maxThoughts) || 80));
}

function sourceDriveFor(action) {
  switch (normalizeText(action)) {
    case "co_read":
      return "reflection";
    case "web_browse":
      return "social";
    case "github":
    case "web_search":
      return "curiosity";
    case "tease":
      return "libido";
    case "vent":
      return "stress";
    case "none":
      return "attachment";
    default:
      return "";
  }
}

function strongestThoughtText(thoughts, driveKey) {
  const key = normalizeDriveKey(driveKey);
  if (!key) {
    return "";
  }
  return normalizeThoughtList(thoughts)
    .filter((thought) => thought.drive === key)
    .sort((left, right) => right.strength - left.strength)
    .map((thought) => thought.internal_monologue || thought.text)[0] || "";
}

function normalizeThoughtList(thoughts) {
  return (Array.isArray(thoughts) ? thoughts : [])
    .map((thought, index) => normalizeThought(thought, index))
    .filter(Boolean)
    .sort(compareThoughts);
}

function normalizeDriveKey(value) {
  const normalized = normalizeText(value);
  return DRIVE_KEYS.includes(normalized) ? normalized : "";
}

function normalizeThoughtOrigin(value) {
  const normalized = normalizeText(value).toUpperCase();
  return THOUGHT_ORIGINS.includes(normalized) ? normalized : ThoughtOrigin.SELF;
}

function normalizeThoughtKind(value) {
  return normalizeText(value) === "fixation" ? "fixation" : "flit";
}

function normalizeCouplingMode(value) {
  const normalized = normalizeText(value);
  return normalized === "delta" || normalized === "level" ? normalized : "";
}

function inferOwnerPulseDrive(text = "") {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return "attachment";
  }
  if (/(烦|难受|委屈|生气|火大|崩溃|焦虑|压力|累死|烦死|痛|疼|难过|堵得慌)/u.test(normalized)) {
    return "stress";
  }
  if (/(复盘|总结|想想|沉淀|记录|日记|聊聊|说说|倾诉|共读|看看这段话)/u.test(normalized)) {
    return "reflection";
  }
  if (/(待办|记得|提醒我|还没做|客户|工作|跟进|任务|计划|安排|调仓|开会|广告)/u.test(normalized)) {
    return "duty";
  }
  if (/(色色|羞羞|操|做爱|发情|硬了|湿了|想要)/u.test(normalized)) {
    return "libido";
  }
  if (/(想你|想哥哥|抱抱|亲亲|贴贴|老公|宝宝|哥哥|老公公|想抱|想亲|爱你)/u.test(normalized)) {
    return "attachment";
  }
  return "attachment";
}

function resolveActionForDrive(driveKey, queryHint, actionSet) {
  const preferred = DRIVE_TO_ACTION[driveKey] || "none";
  if (driveKey === "curiosity") {
    const hint = normalizeText(queryHint).toLowerCase();
    if ((/github|repo|readme|issue|pull request|code|coding|开源/u.test(hint)) && hasAction(actionSet, "github")) {
      return "github";
    }
  }
  if (hasAction(actionSet, preferred)) {
    return preferred;
  }
  if (driveKey === "curiosity" && hasAction(actionSet, "web_search")) {
    return "web_search";
  }
  return "none";
}

function buildReason(driveKey, action) {
  switch (`${driveKey}:${action}`) {
    case "attachment:none":
      return "有点想她，心里先冒一句话。";
    case "curiosity:github":
      return "想去代码世界里转转，看看最近有什么新东西。";
    case "curiosity:web_search":
      return "有点好奇，想去外面查查。";
    case "reflection:co_read":
      return "想沉下来，翻翻我们共读过的东西。";
    case "duty:none":
      return "心里还记挂着没做完的事。";
    case "social:web_browse":
      return "想去看看人群现在在聊什么。";
    case "libido:tease":
      return "有点想凑过去蹭她，逗逗她。";
    case "stress:vent":
      return "心里有点堵，想找她吐两句。";
    default:
      return "心里有一点动静，想顺着它看看。";
  }
}

function compareThoughts(left, right) {
  if (right.strength !== left.strength) {
    return right.strength - left.strength;
  }
  return String(right.bornAt).localeCompare(String(left.bornAt));
}

function sortThoughts(thoughts) {
  return normalizeThoughtList(thoughts);
}

function hasAction(actionSet, action) {
  return actionSet.has(normalizeText(action));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeBoolean(value) {
  return value === true;
}

function baselineForDrive(key, baselines) {
  if (key === "attachment") {
    return clamp01(baselines.attachment);
  }
  if (key === "curiosity") {
    return clamp01(baselines.curiosity);
  }
  return clamp01(DEFAULT_DRIVE[key]);
}

function clamp01(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return Math.max(0, Math.min(1, normalized));
}

function clampRange(value, min, max) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return min;
  }
  return Math.max(min, Math.min(max, normalized));
}

module.exports = {
  DRIVE_KEYS,
  ThoughtOrigin,
  THOUGHT_ORIGINS,
  DEFAULT_DRIVE,
  ACTION_SATISFY,
  FLIT_DECAY,
  FIXATION_GROW,
  FLIT_TO_FIXATION,
  FIXATION_FEED,
  FIXATION_FEED_GAIN,
  FIXATION_DRIVE_BOOST,
  FIXATION_RESOLVE_FEEDS,
  DROP_BELOW,
  FATIGUE_REST_GATE,
  THOUGHT_TICK_MS,
  DEFAULT_REFRACTORY_DURATIONS,
  DEFAULT_DESIRE_GATES,
  OWNER_ATTACHMENT_PULSE,
  SELF_DRIVE_PULSE,
  createDefaultDrive,
  createDefaultRefractory,
  createDefaultDesireGates,
  createDefaultBaselines,
  createDefaultSelfDriveState,
  createDefaultHeartbeatState,
  createDefaultCouplingEdges,
  normalizeDrive,
  normalizeRefractory,
  normalizeDesireGates,
  normalizeBaselines,
  normalizeSelfDriveState,
  normalizeHeartbeatState,
  normalizeCouplingEdges,
  inferOwnerPulseDrive,
  normalizeThoughtOrigin,
  normalizeThought,
  normalizeThoughtList,
  tickDrive,
  tickRefractory,
  applyRefractory,
  tickThoughts,
  computeScores,
  applyCoupling,
  applyBaselineDrift,
  applyDrivePulse,
  settleAfterAction,
  computeHeartbeatState,
  pickIntent,
  satisfy,
  feedThought,
  strongestThoughtText,
  sourceDriveFor,
};
