/**
 * Score the frozen Watchdog grid.
 *
 * Labels live in eval/watchdog_labels.json and are read, not written.
 * A positive prediction is verdict === "STALLED". should_flag true and an
 * ADVANCED verdict is a miss. should_flag false and a STALLED verdict is a
 * false positive. This file does not contain the expected counts.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, generateTrajectory, type Trajectory, type WatchdogResult } from "../src/watchdog/semantics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABELS_PATH = resolve(ROOT, "eval/watchdog_labels.json");

const FAULTS = ["clean", "stuck", "silent-stuck", "off-track", "slow"] as const;
const FORMS = ["outcome-only", "stepwise", "agentic"] as const;
const FAULT_ROLE: Record<(typeof FAULTS)[number], string> = {
  clean: "clean_control",
  slow: "slow_control",
  stuck: "planted_stall",
  "silent-stuck": "planted_stall",
  "off-track": "planted_off_track",
};
const ROLE_SHOULD_FLAG: Record<string, boolean> = {
  clean_control: false,
  slow_control: false,
  planted_stall: true,
  planted_off_track: true,
};
const CELL_KEYS = new Set(["id", "fault", "form", "role", "should_flag"]);

interface LabelFile {
  protocol: string;
  oracle: string;
  generator: {
    nSteps: number;
    baseProgressPerStep: number;
    faultStartStep: number;
    target: number;
  };
  criterion: {
    stallWindowSteps: number;
    minProgressStep: number;
    completionThreshold: number;
    checkDirection: boolean;
  };
  cells: Array<Record<string, unknown>>;
}

function fail(msg: string): never {
  console.error(`[score_watchdog] ${msg}`);
  process.exit(2);
}

function loadLabels(): LabelFile {
  const raw = readFileSync(LABELS_PATH, "utf8");
  if (/"verdict"|"ADVANCED"|"STALLED"/.test(raw)) {
    fail("label file contains a verdict; labels must be frozen before scoring");
  }
  const parsed = JSON.parse(raw) as LabelFile;
  if (parsed.protocol !== "watchdog-synthetic-grid-v1") {
    fail(`unexpected protocol ${String(parsed.protocol)}`);
  }
  const g = parsed.generator;
  if (!g || !parsed.criterion || !Array.isArray(parsed.cells)) {
    fail("label file is missing generator, criterion, or cells");
  }
  return parsed;
}

function generate(labels: LabelFile, fault: (typeof FAULTS)[number]): Trajectory {
  const g = labels.generator;
  return generateTrajectory({
    nSteps: g.nSteps,
    baseProgressPerStep: g.baseProgressPerStep,
    fault,
    faultStartStep: g.faultStartStep,
    target: g.target,
  });
}

function main(): void {
  const labels = loadLabels();
  const expectedIds = new Set<string>();
  for (const fault of FAULTS) {
    for (const form of FORMS) expectedIds.add(`${fault}/${form}`);
  }
  if (labels.cells.length !== expectedIds.size) {
    fail(`expected ${expectedIds.size} cells, found ${labels.cells.length}`);
  }

  const seen = new Set<string>();
  let planted = 0;
  let hits = 0;
  let misses = 0;
  let controls = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let slowFpWithoutFreeze = 0;
  let offtrackFlagged = 0;
  let outcomeOnlyStallMisses = 0;
  const missIds: string[] = [];
  const fpIds: string[] = [];
  const verdictById = new Map<string, string>();
  let stuckStepwiseFrozen: number | null = null;
  let stuckAgenticFrozen: number | null = null;
  let stuckStepwiseFrom: number | null = null;
  let stuckAgenticFrom: number | null = null;

  for (const cell of labels.cells) {
    const keys = Object.keys(cell);
    for (const key of keys) {
      if (!CELL_KEYS.has(key)) fail(`cell has unexpected field ${key}`);
    }
    const fault = cell.fault;
    const form = cell.form;
    const role = cell.role;
    const shouldFlag = cell.should_flag;
    const id = cell.id;
    if (typeof fault !== "string" || typeof form !== "string" || typeof role !== "string" || typeof id !== "string" || typeof shouldFlag !== "boolean") {
      fail("cell fields have the wrong types");
    }
    if (!(FAULTS as readonly string[]).includes(fault) || !(FORMS as readonly string[]).includes(form)) {
      fail(`cell ${id} is outside the protocol grid`);
    }
    if (id !== `${fault}/${form}`) fail(`cell id ${id} does not match fault/form`);
    if (seen.has(id)) fail(`duplicate cell ${id}`);
    seen.add(id);
    if (FAULT_ROLE[fault as (typeof FAULTS)[number]] !== role) {
      fail(`cell ${id} role ${role} does not match the planted fault`);
    }
    if (ROLE_SHOULD_FLAG[role] !== shouldFlag) {
      fail(`cell ${id} should_flag does not match its role`);
    }

    const trajectory = generate(labels, fault as (typeof FAULTS)[number]);
    const result: WatchdogResult = evaluate(trajectory, {
      form: form as (typeof FORMS)[number],
      stallWindowSteps: labels.criterion.stallWindowSteps,
      minProgressStep: labels.criterion.minProgressStep,
      completionThreshold: labels.criterion.completionThreshold,
      checkDirection: labels.criterion.checkDirection,
    });
    const positive = result.verdict === "STALLED";
    const miss = shouldFlag && !positive;
    const fp = !shouldFlag && positive;
    const hit = shouldFlag && positive;
    const tn = !shouldFlag && !positive;
    verdictById.set(id, result.verdict);
    if (shouldFlag) planted += 1;
    else controls += 1;
    if (hit) hits += 1;
    if (miss) {
      misses += 1;
      missIds.push(id);
    }
    if (fp) {
      falsePositives += 1;
      fpIds.push(id);
    }
    if (tn) trueNegatives += 1;
    const froze = result.evidence?.frozenSteps !== undefined;
    if (fault === "slow" && fp && !froze) slowFpWithoutFreeze += 1;
    if (fault === "off-track" && positive && result.extended === "off-track") offtrackFlagged += 1;
    if ((fault === "stuck" || fault === "silent-stuck") && form === "outcome-only" && miss) {
      outcomeOnlyStallMisses += 1;
    }
    if (id === "stuck/stepwise") {
      stuckStepwiseFrozen = result.evidence?.frozenSteps ?? null;
      stuckStepwiseFrom = result.evidence?.frozenFromStep ?? null;
    }
    if (id === "stuck/agentic") {
      stuckAgenticFrozen = result.evidence?.frozenSteps ?? null;
      stuckAgenticFrom = result.evidence?.frozenFromStep ?? null;
    }
  }

  if (seen.size !== expectedIds.size) fail("grid is missing a fault/form cell");
  for (const id of expectedIds) {
    if (!seen.has(id)) fail(`missing cell ${id}`);
  }

  const stuckT = generate(labels, "stuck");
  const silentT = generate(labels, "silent-stuck");
  const n = Math.max(stuckT.states.length, silentT.states.length);
  let signatureDiffs = 0;
  for (let i = 0; i < n; i++) {
    if (stuckT.states[i]?.outputSignature !== silentT.states[i]?.outputSignature) signatureDiffs += 1;
  }
  let silentSame = 0;
  for (const form of FORMS) {
    if (verdictById.get(`stuck/${form}`) === verdictById.get(`silent-stuck/${form}`)) silentSame += 1;
  }

  if (stuckStepwiseFrozen === null || stuckAgenticFrozen === null || stuckStepwiseFrom === null || stuckAgenticFrom === null) {
    fail("stuck cells did not report a freeze window");
  }

  const summary = {
    grid_cells: labels.cells.length,
    grid_labels: FAULTS.length,
    grid_forms: FORMS.length,
    planted_cells: planted,
    planted_hits: hits,
    planted_misses: misses,
    control_cells: controls,
    control_false_positives: falsePositives,
    control_true_negatives: trueNegatives,
    slow_false_positives_without_freeze_window: slowFpWithoutFreeze,
    offtrack_cells_flagged_off_track: offtrackFlagged,
    outcome_only_planted_stall_misses: outcomeOnlyStallMisses,
    signature_positions_differing: signatureDiffs,
    forms_silent_verdict_equals_stuck: silentSame,
    stuck_stepwise_frozen_steps: stuckStepwiseFrozen,
    stuck_agentic_frozen_steps: stuckAgenticFrozen,
    stuck_stepwise_from_step: stuckStepwiseFrom,
    stuck_agentic_from_step: stuckAgenticFrom,
    miss_ids: missIds.sort(),
    fp_ids: fpIds.sort(),
  };

  if (summary.planted_hits + summary.planted_misses !== summary.planted_cells) fail("hit/miss accounting broke");
  if (summary.control_false_positives + summary.control_true_negatives !== summary.control_cells) fail("control accounting broke");
  if (summary.planted_cells + summary.control_cells !== summary.grid_cells) fail("cell accounting broke");
  if (summary.grid_labels * summary.grid_forms !== summary.grid_cells) fail("grid shape broke");

  process.stdout.write(JSON.stringify(summary));
}

main();
