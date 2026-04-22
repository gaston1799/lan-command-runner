function parseArgs(argv) {
  const options = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--") {
      options._.push(...argv.slice(index + 1));
      break;
    }

    if (!value.startsWith("--")) {
      options._.push(value);
      continue;
    }

    const eq = value.indexOf("=");
    if (eq !== -1) {
      options[value.slice(2, eq)] = value.slice(eq + 1);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

function numberOption(value, fallback) {
  if (value == null || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  numberOption,
  parseArgs,
};
