"use strict";

const fsApi = require("node:fs");

const {
  RouteLaneError,
  buildTelegramRouteLane,
  canonicalTelegramChatId,
  canonicalTelegramMessageThreadId,
} = require("../../../core/route-lane");
const {
  BoundedJsonError,
  assertSafeKey,
  createNullPrototypeObject,
  parseBoundedJson,
} = require("../../../core/bounded-json");
const {
  LaunchProfileError,
  canonicalProfileId,
  fingerprintLaunchProfile,
  validateLaunchProfile,
} = require("./launch-profile");

// Fail-closed Telegram -> Claude profile routing.
//
// The v1 selector degraded quietly: an invalid profile was skipped, and a route
// naming a missing profile fell back to the legacy (more permissive) launch.
// That is exactly backwards -- a misconfigured restriction must never resolve
// to *less* restriction.
//
// Here, every defect is fatal at construction time:
//   * malformed JSON, over-size / over-deep / over-wide JSON
//   * unknown fields in a profile or a mapping entry
//   * `__proto__` / `prototype` / `constructor` anywhere
//   * a route naming a profile that does not exist or does not validate
//   * two mapping entries for the same (accountId, chatId, messageThreadId)
//   * two profile ids that collide after trimming/case folding
//   * a non-canonical Telegram id: float, negative topic, exponent form,
//     leading zero, `+1`, arbitrary text, or an empty string standing in for
//     the default lane
//
// With no mapping configured the router reports `unmapped` for every route and
// the caller keeps its pre-v2 behaviour exactly.

const MAPPING_FIELDS = Object.freeze(new Set([
  "accountId",
  "chatId",
  "messageThreadId",
  "profileId",
]));

const PROFILES_JSON_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 6,
  maxStringLength: 8192,
  maxArrayLength: 64,
  maxObjectKeys: 64,
  maxTotalNodes: 2048,
});

const MAPPING_JSON_LIMITS = Object.freeze({
  maxBytes: 32 * 1024,
  maxDepth: 3,
  maxStringLength: 128,
  maxArrayLength: 256,
  maxObjectKeys: 8,
  maxTotalNodes: 2048,
});

const MAX_PROFILES = 32;
const MAX_MAPPINGS = 256;

class ProfileRoutingError extends Error {
  constructor(message, code = "profile_routing_invalid") {
    super(message);
    this.name = "ProfileRoutingError";
    this.code = code;
  }
}

function rethrow(error, prefix) {
  if (
    error instanceof BoundedJsonError
    || error instanceof LaunchProfileError
    || error instanceof RouteLaneError
  ) {
    throw new ProfileRoutingError(`${prefix}: ${error.message}`, error.code);
  }
  if (error instanceof ProfileRoutingError) {
    throw error;
  }
  throw new ProfileRoutingError(`${prefix}: ${error?.message || String(error)}`);
}

/**
 * Parse and validate `CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON`.
 * @returns {Map<string, object>} canonical profileId -> validated profile
 */
function parseLaunchProfiles(raw, { baseDir, allowAuthBackendOverride = false, fs = fsApi } = {}) {
  const registry = new Map();
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return registry;
  }

  let parsed;
  try {
    parsed = parseBoundedJson(text, {
      label: "CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON",
      limits: PROFILES_JSON_LIMITS,
    });
  } catch (error) {
    rethrow(error, "launch profiles");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileRoutingError(
      "launch profiles must be a JSON object of profileId -> profile",
      "invalid_shape",
    );
  }

  const rawKeys = Object.keys(parsed);
  if (rawKeys.length > MAX_PROFILES) {
    throw new ProfileRoutingError(
      `launch profiles exceed the maximum of ${MAX_PROFILES}`,
      "too_many_profiles",
    );
  }

  const canonicalByFold = new Map();
  for (const rawKey of rawKeys) {
    let profileId;
    try {
      assertSafeKey(rawKey, "launch profiles");
      profileId = canonicalProfileId(rawKey, "launch profile id");
    } catch (error) {
      rethrow(error, "launch profiles");
    }

    // Two keys that differ only by surrounding whitespace or letter case are a
    // configuration mistake with security consequences (the operator believes
    // one profile is in force while another is selected), so both are rejected.
    const fold = profileId.toLowerCase();
    if (canonicalByFold.has(fold)) {
      throw new ProfileRoutingError(
        `launch profile id collides after normalization: ${profileId}`,
        "profile_id_collision",
      );
    }
    canonicalByFold.set(fold, profileId);

    const rawProfile = parsed[rawKey];
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
      throw new ProfileRoutingError(
        `launch profile ${profileId} must be an object`,
        "invalid_shape",
      );
    }
    if (rawProfile.profileId !== undefined) {
      let declared;
      try {
        declared = canonicalProfileId(rawProfile.profileId, "launch profile profileId");
      } catch (error) {
        rethrow(error, `launch profile ${profileId}`);
      }
      if (declared !== profileId) {
        throw new ProfileRoutingError(
          `launch profile ${profileId} declares a conflicting profileId`,
          "profile_id_mismatch",
        );
      }
    }

    let validated;
    try {
      validated = validateLaunchProfile(
        { ...rawProfile, profileId },
        { baseDir, allowAuthBackendOverride, fs },
      );
    } catch (error) {
      rethrow(error, `launch profile ${profileId}`);
    }
    registry.set(profileId, validated);
  }

  return registry;
}

/**
 * Parse and validate `CYBERBOSS_TELEGRAM_PROFILE_MAPPING_JSON`.
 */
function parseProfileMappings(raw, { profiles }) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return [];
  }

  let parsed;
  try {
    parsed = parseBoundedJson(text, {
      label: "CYBERBOSS_TELEGRAM_PROFILE_MAPPING_JSON",
      limits: MAPPING_JSON_LIMITS,
    });
  } catch (error) {
    rethrow(error, "profile mapping");
  }

  if (!Array.isArray(parsed)) {
    throw new ProfileRoutingError("profile mapping must be a JSON array", "invalid_shape");
  }
  if (parsed.length > MAX_MAPPINGS) {
    throw new ProfileRoutingError(
      `profile mapping exceeds the maximum of ${MAX_MAPPINGS} routes`,
      "too_many_mappings",
    );
  }

  const seenRoutes = new Map();
  const mappings = [];
  parsed.forEach((entry, index) => {
    const where = `profile mapping[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProfileRoutingError(`${where} must be an object`, "invalid_shape");
    }
    for (const key of Object.keys(entry)) {
      try {
        assertSafeKey(key, where);
      } catch (error) {
        rethrow(error, where);
      }
      if (!MAPPING_FIELDS.has(key)) {
        throw new ProfileRoutingError(`${where} contains an unknown field: ${key}`, "unknown_field");
      }
    }
    // messageThreadId must be written out explicitly. A missing key would make
    // "no topic" and "any topic" indistinguishable.
    if (!Object.hasOwn(entry, "messageThreadId")) {
      throw new ProfileRoutingError(
        `${where} must state messageThreadId explicitly (null for the default lane)`,
        "missing_field",
      );
    }

    let lane;
    let profileId;
    try {
      lane = buildTelegramRouteLane({
        accountId: entry.accountId,
        chatId: canonicalTelegramChatId(entry.chatId),
        messageThreadId: canonicalTelegramMessageThreadId(entry.messageThreadId),
      });
      profileId = canonicalProfileId(entry.profileId, `${where}.profileId`);
    } catch (error) {
      rethrow(error, where);
    }

    if (seenRoutes.has(lane.laneKey)) {
      throw new ProfileRoutingError(
        `${where} duplicates the route already declared at index ${seenRoutes.get(lane.laneKey)}`,
        "duplicate_route",
      );
    }
    seenRoutes.set(lane.laneKey, index);

    if (!profiles.has(profileId)) {
      // No fallback to a legacy (more permissive) launch: an operator who named
      // a restrictive profile must not silently get an unrestricted one.
      throw new ProfileRoutingError(
        `${where} names an unknown launch profile: ${profileId}`,
        "unknown_profile",
      );
    }

    mappings.push(Object.freeze({
      laneKey: lane.laneKey,
      profileId,
    }));
  });

  return mappings;
}

/**
 * Build the router. Throws on any configuration defect, which is what blocks
 * startup.
 */
function createTelegramProfileRouter({
  profilesJson = "",
  mappingJson = "",
  baseDir = process.cwd(),
  allowAuthBackendOverride = false,
  fs = fsApi,
} = {}) {
  const profiles = parseLaunchProfiles(profilesJson, { baseDir, allowAuthBackendOverride, fs });
  const mappings = parseProfileMappings(mappingJson, { profiles });

  // An empty mapping array is a legitimate "declare profiles now, route later"
  // state: the router stays disabled and every lane keeps legacy behaviour.
  const profileIdByLaneKey = createNullPrototypeObject();
  for (const mapping of mappings) {
    profileIdByLaneKey[mapping.laneKey] = mapping.profileId;
  }

  const fingerprintByProfileId = new Map();
  for (const [profileId, profile] of profiles.entries()) {
    fingerprintByProfileId.set(
      profileId,
      fingerprintLaunchProfile(profile, { baseDir, allowAuthBackendOverride, fs }),
    );
  }

  const enabled = mappings.length > 0;

  return Object.freeze({
    describe() {
      return Object.freeze({
        enabled,
        profileCount: profiles.size,
        mappingCount: mappings.length,
      });
    },
    isEnabled() {
      return enabled;
    },
    /**
     * @param {{laneKey?: string, accountId?: string, chatId?: string|number,
     *          messageThreadId?: string|number|null}} lane
     */
    select(lane) {
      if (!enabled || !lane) {
        return UNMAPPED;
      }
      const laneKey = typeof lane === "string" ? lane : lane.laneKey;
      if (!laneKey) {
        return UNMAPPED;
      }
      const profileId = profileIdByLaneKey[laneKey];
      if (!profileId) {
        return UNMAPPED;
      }
      return Object.freeze({
        status: "matched",
        profileId,
        launchProfile: profiles.get(profileId),
        profileFingerprint: fingerprintByProfileId.get(profileId) || "legacy",
      });
    },
    listProfileIds() {
      return [...profiles.keys()].sort();
    },
  });
}

const UNMAPPED = Object.freeze({
  status: "unmapped",
  profileId: "",
  launchProfile: null,
  profileFingerprint: "legacy",
});

module.exports = {
  MAPPING_JSON_LIMITS,
  MAPPING_FIELDS,
  MAX_MAPPINGS,
  MAX_PROFILES,
  PROFILES_JSON_LIMITS,
  ProfileRoutingError,
  UNMAPPED,
  createTelegramProfileRouter,
  parseLaunchProfiles,
  parseProfileMappings,
};
