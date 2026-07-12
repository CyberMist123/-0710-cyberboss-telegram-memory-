#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { createWeatherService } = require("../src/services/weather-service");

function loadEnv() {
  const candidates = [
    process.env.CYBERBOSS_ENV_FILE ? path.resolve(process.env.CYBERBOSS_ENV_FILE) : "",
    process.env.CYBERBOSS_CONFIG_DIR ? path.join(path.resolve(process.env.CYBERBOSS_CONFIG_DIR), ".env") : "",
    process.env.CYBERBOSS_STATE_DIR ? path.join(path.resolve(process.env.CYBERBOSS_STATE_DIR), ".env") : "",
  ].filter(Boolean);
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath, override: true });
  }
}

async function main() {
  loadEnv();
  const config = readConfig();
  const weather = createWeatherService({ config });
  const command = String(process.argv[2] || "summary").trim().toLowerCase();
  const day = String(process.argv[3] || "today").trim().toLowerCase();

  if (command === "current") {
    console.log(JSON.stringify(await weather.getCurrent(), null, 2));
    return;
  }
  if (command === "forecast") {
    console.log(JSON.stringify(await weather.getForecast({ day }), null, 2));
    return;
  }
  if (command === "summary") {
    console.log(JSON.stringify(await weather.getSummary({ day }), null, 2));
    return;
  }
  if (command === "raw") {
    const extensions = day === "base" || day === "all" ? day : "all";
    console.log(JSON.stringify(await weather.getRaw({ extensions }), null, 2));
    return;
  }

  throw new Error(`Unsupported test-weather command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[test-weather] ${message}`);
  process.exitCode = 1;
});
