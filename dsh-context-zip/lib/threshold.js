// src/threshold.ts
var THRESHOLD_MIN_FORM = "Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))";
var THRESHOLD_RATIO_FORM = "Math.floor(contextWindow * policy.thresholdRatio)";
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}
function inspectThreshold(text) {
  const min = count(text, THRESHOLD_MIN_FORM);
  const ratio = count(text, THRESHOLD_RATIO_FORM);
  if (min === 0 && ratio === 1) return "ratio-only";
  if (min === 1 && ratio === 0) return "stock";
  return "unknown";
}
function planThreshold(source, options = {}) {
  const observed = inspectThreshold(source);
  if (observed === "stock") {
    return {
      state: "ratio-only",
      text: source.replace(THRESHOLD_MIN_FORM, THRESHOLD_RATIO_FORM),
      reason: "second cap removed: the threshold is the ratio alone, as 0.1.5 through 0.1.6-alpha.2 had it"
    };
  }
  if (observed === "ratio-only") {
    return {
      state: "not-needed",
      text: source,
      reason: "this backend already caps by the ratio alone; nothing to change"
    };
  }
  if (options.allowStock === true) {
    return {
      state: "none",
      text: source,
      reason: "backend wired unpatched (--stock-backend)"
    };
  }
  throw new Error(
    `the shipped backend does not carry the threshold expression this plugin patches (0.1.7 form \xD7${count(source, THRESHOLD_MIN_FORM)}, ratio-only form \xD7${count(source, THRESHOLD_RATIO_FORM)}): refusing to wire a redirect whose backend cannot be verified. Re-run install.mjs with --stock-backend to wire it unpatched, then update this plugin.`
  );
}
function thresholdWriteMatches(text, plan) {
  if (text !== plan.text) return false;
  return plan.state === "none" || inspectThreshold(text) === "ratio-only";
}
function thresholdDrift(stamped, text) {
  const observed = inspectThreshold(text);
  if (stamped === "ratio-only" || stamped === "not-needed") return observed !== "ratio-only";
  if (stamped === "none") return false;
  return observed === "stock";
}
export {
  THRESHOLD_MIN_FORM,
  THRESHOLD_RATIO_FORM,
  inspectThreshold,
  planThreshold,
  thresholdDrift,
  thresholdWriteMatches
};
