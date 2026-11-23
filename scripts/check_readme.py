#!/usr/bin/env python3
"""Recompute every README number and fail if the documented claims drift.

The grid labels are read from eval/watchdog_labels.json. Verdicts are produced
by eval/score_watchdog.ts. This script does not hard-code the hit, miss, or
false-positive counts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
FAILURES = ROOT / "FAILURE_MODES.md"
LABELS = ROOT / "eval" / "watchdog_labels.json"
BIN = ROOT / "node_modules" / ".bin"

FORBIDDEN = (
    "生产级",
    "production-grade",
    "production-shaped",
    "前缀缓存",
    "prefix caching",
    "prefix cache",
    "0.000",
    "1.000",
    "判别力",
    "Express",
)

SCORE_INT_KEYS = (
    "grid_cells",
    "grid_labels",
    "grid_forms",
    "planted_cells",
    "planted_hits",
    "planted_misses",
    "control_cells",
    "control_false_positives",
    "control_true_negatives",
    "slow_false_positives_without_freeze_window",
    "offtrack_cells_flagged_off_track",
    "outcome_only_planted_stall_misses",
    "signature_positions_differing",
    "forms_silent_verdict_equals_stuck",
    "stuck_stepwise_frozen_steps",
    "stuck_agentic_frozen_steps",
    "stuck_stepwise_from_step",
    "stuck_agentic_from_step",
)


def die(msg: str) -> None:
    print(f"[check] {msg}", file=sys.stderr)
    raise SystemExit(1)


def run(cmd: list[str], *, allow_code: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
    if proc.returncode not in allow_code:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        die(f"command failed ({proc.returncode}): {' '.join(cmd)}")
    return proc


def load_json_stdout(proc: subprocess.CompletedProcess[str]) -> dict:
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        die(f"expected JSON on stdout: {exc}")


def require_bin(name: str) -> str:
    path = BIN / name
    if not path.is_file():
        die(f"missing {path}; run npm ci before make check")
    return str(path)


def read_ci_node() -> int:
    pins: set[str] = set()
    for rel in (".github/workflows/ci.yml", ".github/workflows/pr-checks.yml"):
        text = (ROOT / rel).read_text(encoding="utf-8")
        found = re.findall(r'node-version:\s*"(\d+)"', text)
        if not found:
            die(f"{rel} does not pin node-version")
        pins.update(found)
    if len(pins) != 1:
        die(f"CI Node pins disagree: {sorted(pins)}")
    return int(pins.pop())


def read_port() -> int:
    text = (ROOT / "src" / "index.ts").read_text(encoding="utf-8")
    found = re.findall(r"process\.env\.PORT \?\? (\d+)", text)
    if found != ["3081"] and len(set(found)) != 1:
        die(f"default port literals disagree: {found}")
    if len(found) != 1:
        die(f"expected one default port, found {found}")
    return int(found[0])


def read_package_version() -> str:
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = pkg.get("version")
    if not isinstance(version, str):
        die("package.json version is missing")
    return version


def read_description() -> str:
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    description = pkg.get("description")
    if not isinstance(description, str) or not description.strip():
        die("package.json description is missing")
    return description


def read_policy_version() -> str:
    text = (ROOT / "src" / "config" / "config.ts").read_text(encoding="utf-8")
    found = re.findall(r"version: '(\d+\.\d+\.\d+)'", text)
    if len(found) != 1:
        die(f"expected one policy version literal, found {found}")
    return found[0]


def align_generator(labels: dict) -> None:
    watchdog = (ROOT / "src" / "watchdog" / "watchdog.ts").read_text(encoding="utf-8")
    semantics = (ROOT / "src" / "watchdog" / "semantics.ts").read_text(encoding="utf-8")
    nsteps = re.findall(r"nSteps = (\d+)", watchdog)
    bases = re.findall(r"baseProgressPerStep: (\d+)", watchdog)
    targets = re.findall(r"target: (\d+)", watchdog)
    offsets = re.findall(r"nSteps - (\d+)", watchdog + "\n" + semantics)
    if len(set(nsteps)) != 1 or len(set(bases)) != 1 or len(set(targets)) != 1 or len(set(offsets)) != 1:
        die(f"generator literals disagree: nSteps={nsteps} base={bases} target={targets} offset={offsets}")
    gen = labels["generator"]
    fault_start = int(nsteps[0]) - int(offsets[0])
    actual = {
        "nSteps": int(nsteps[0]),
        "baseProgressPerStep": int(bases[0]),
        "faultStartStep": fault_start,
        "target": int(targets[0]),
    }
    if actual != gen:
        die(f"label generator {gen} does not match makeFaultTrajectory literals {actual}")
    calls = re.findall(r"makeFaultTrajectory\('[^']+',\s*(\d+)\)", (ROOT / "tests" / "watchdog.test.ts").read_text(encoding="utf-8"))
    if not calls or any(int(n) != actual["nSteps"] for n in calls):
        die(f"watchdog tests must call makeFaultTrajectory at nSteps={actual['nSteps']}, found {calls}")


def align_criterion(labels: dict) -> None:
    texts = []
    for rel in ("src/config/config.ts", "src/core/types.ts", "tests/watchdog.test.ts"):
        texts.append((ROOT / rel).read_text(encoding="utf-8"))
    blob = "\n".join(texts)
    criterion = labels["criterion"]
    for field in ("stallWindowSteps", "minProgressStep", "completionThreshold"):
        vals = re.findall(rf"{field}:\s*(\d+(?:\.\d+)?)", blob)
        vals += re.findall(rf"{field}[^\n]*\.default\((\d+(?:\.\d+)?)\)", blob)
        if not vals:
            die(f"no literals found for {field}")
        expected = criterion[field]
        normalized = {float(v) for v in vals}
        if normalized != {float(expected)}:
            die(f"{field} literals {sorted(normalized)} do not match label value {expected}")
    flags = re.findall(r"checkDirection:\s*(true|false)", blob)
    flags += re.findall(r"checkDirection[^\n]*\.default\((true|false)\)", blob)
    if not flags or any(flag != str(criterion["checkDirection"]).lower() for flag in flags):
        die(f"checkDirection literals {flags} do not match {criterion['checkDirection']}")


def score_grid() -> dict:
    proc = run([require_bin("tsx"), "eval/score_watchdog.ts"])
    data = load_json_stdout(proc)
    for key in SCORE_INT_KEYS:
        if not isinstance(data.get(key), int):
            die(f"scorer did not return an integer {key}")
    for key in ("miss_ids", "fp_ids"):
        if not isinstance(data.get(key), list) or not all(isinstance(x, str) for x in data[key]):
            die(f"scorer did not return string ids for {key}")
    if data["planted_hits"] + data["planted_misses"] != data["planted_cells"]:
        die("planted hit/miss counts do not add up")
    if data["control_false_positives"] + data["control_true_negatives"] != data["control_cells"]:
        die("control counts do not add up")
    if data["planted_cells"] + data["control_cells"] != data["grid_cells"]:
        die("planted and control cells do not add up to the grid")
    if data["grid_labels"] * data["grid_forms"] != data["grid_cells"]:
        die("label and form counts do not multiply to the grid size")
    if data["outcome_only_planted_stall_misses"] != data["planted_misses"]:
        die("a miss is not the outcome-only stall miss the README sentence attributes")
    if data["slow_false_positives_without_freeze_window"] != data["control_false_positives"]:
        die("a false positive is not the slow-control completion flag the README sentence attributes")
    if data["stuck_stepwise_from_step"] != data["stuck_agentic_from_step"]:
        die("stepwise and agentic from-steps differ; the README sentence says they match")
    if len(data["miss_ids"]) != data["planted_misses"] or len(data["fp_ids"]) != data["control_false_positives"]:
        die("id lists do not match the miss and false-positive counts")
    return data


def vitest_counts() -> dict[str, int]:
    with tempfile.TemporaryDirectory(prefix="sap-vitest-") as tmp:
        out = Path(tmp) / "vitest.json"
        run([require_bin("vitest"), "run", "--reporter=json", f"--outputFile={out}"])
        data = json.loads(out.read_text(encoding="utf-8"))
    if data.get("numFailedTests") != 0 or data.get("success") is not True:
        die(f"vitest reported failures: {data.get('numFailedTests')}")
    files = data.get("testResults") or []
    by_name: dict[str, int] = {}
    for item in files:
        name = Path(item["name"]).name
        asserts = item.get("assertionResults") or []
        if item.get("status") != "passed" or any(a.get("status") != "passed" for a in asserts):
            die(f"vitest file not fully passed: {name}")
        by_name[name] = len(asserts)
    if set(by_name) != {"router.test.ts", "watchdog.test.ts"}:
        die(f"unexpected vitest files: {sorted(by_name)}")
    total = int(data["numTotalTests"])
    if total != sum(by_name.values()) or int(data["numPassedTests"]) != total:
        die("vitest totals do not match the per-file counts")
    return {
        "unit_test_files": len(by_name),
        "unit_tests": total,
        "unit_tests_failed": int(data["numFailedTests"]),
        "router_tests": by_name["router.test.ts"],
        "watchdog_tests": by_name["watchdog.test.ts"],
    }


def eval_counts() -> dict[str, int]:
    proc = run([sys.executable, "eval/run_cases.py", "--json"])
    data = load_json_stdout(proc)
    total = int(data["total"])
    passed = int(data["passed"])
    if passed != total or int(data["failed"]) != 0:
        die(f"regression harness {passed}/{total}")
    selftest = run([sys.executable, "eval/run_cases.py", "--selftest", "--json"])
    red = load_json_stdout(selftest)
    if int(red["total"]) != total or int(red["failed"]) != 1 or int(red["passed"]) != total - 1:
        die(f"selftest did not turn exactly one case red: {red['passed']}/{red['total']}")
    return {"eval_cases": total, "eval_passed": passed}


def build_claims() -> dict:
    if not (ROOT / "node_modules").is_dir():
        die("node_modules is missing; run npm ci before make check")
    labels = json.loads(LABELS.read_text(encoding="utf-8"))
    align_generator(labels)
    align_criterion(labels)
    run([require_bin("tsc"), "--noEmit"])
    run([require_bin("tsc"), "--noEmit", "-p", "tsconfig.tests.json"])
    run([require_bin("tsc")])
    score = score_grid()
    counts = vitest_counts()
    cases = eval_counts()
    claims: dict = {
        "ci_node": read_ci_node(),
        "default_port": read_port(),
        "package_version": read_package_version(),
        "policy_version": read_policy_version(),
        "labels_sha256": hashlib.sha256(LABELS.read_bytes()).hexdigest(),
    }
    for key in SCORE_INT_KEYS:
        claims[key] = score[key]
    claims["miss_ids"] = score["miss_ids"]
    claims["fp_ids"] = score["fp_ids"]
    claims.update(counts)
    claims.update(cases)
    return claims


def required_sentences(m: dict) -> list[str]:
    misses = " and ".join(f"`{item}`" for item in m["miss_ids"])
    fps = ", ".join(f"`{item}`" for item in m["fp_ids"])
    return [
        (
            f"Result (n = {m['grid_cells']} cells: {m['grid_labels']} labels × {m['grid_forms']} forms, "
            f"one trajectory each). The watchdog records {m['planted_hits']} hits and {m['planted_misses']} misses "
            f"out of {m['planted_cells']} planted-defect cells, and false-flags {m['control_false_positives']} of "
            f"{m['control_cells']} non-defect controls."
        ),
        f"Both misses are outcome-only on a progress freeze that stops on the completion threshold: {misses}.",
        (
            f"All {m['control_false_positives']} false positives are the slow control ({fps}), "
            "and none of them comes from a freeze window."
        ),
        (
            f"The {m['control_true_negatives']} true negatives are the clean control on every form."
        ),
        (
            f"The {m['offtrack_cells_flagged_off_track']} off-track cells are all flagged, and that flag is the "
            "shared direction check rather than a form-specific freeze window."
        ),
        (
            f"Stepwise and agentic flag the stuck trajectory from step {m['stuck_stepwise_from_step']}, "
            f"the same index; frozen-step counts at detection are {m['stuck_stepwise_frozen_steps']} (stepwise) "
            f"and {m['stuck_agentic_frozen_steps']} (agentic)."
        ),
        (
            f"`silent-stuck` differs from `stuck` in the output signature at {m['signature_positions_differing']} "
            f"positions and still receives the same verdict on all {m['forms_silent_verdict_equals_stuck']} forms."
        ),
        (
            f"Passing the {m['unit_tests']} unit tests ({m['unit_test_files']} files: router {m['router_tests']}, "
            f"watchdog {m['watchdog_tests']}, {m['unit_tests_failed']} failed) is a regression check, not a reliability result."
        ),
        (
            f"A separate {m['eval_cases']}-case regression harness passes {m['eval_passed']} of {m['eval_cases']} "
            "under `make check`."
        ),
        f"The HTTP server defaults to port {m['default_port']}.",
        f"package.json version is {m['package_version']}; the default policy version field is {m['policy_version']}.",
        f"GitHub Actions `ci.yml` pins Node {m['ci_node']}.",
    ]


def extract_claims(readme: str) -> dict:
    match = re.search(r"<!-- claims:start -->\s*```json\s*(.*?)\s*```\s*<!-- claims:end -->", readme, re.S)
    if not match:
        die("README is missing the claims json block")
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        die(f"README claims block is not JSON: {exc}")


def prose_without_claims(readme: str) -> str:
    return re.sub(r"<!-- claims:start -->.*?<!-- claims:end -->", "", readme, flags=re.S)


def check_problem(readme: str) -> None:
    match = re.search(r"<!-- problem:start -->\n(.*?)<!-- problem:end -->", readme, re.S)
    if not match:
        die("README is missing the problem block")
    lines = [line for line in match.group(1).splitlines() if line.strip()]
    if len(lines) != 3:
        die(f"problem statement must be 3 non-empty lines, found {len(lines)}")
    if any(re.search(r"\d", line) for line in lines):
        die("problem statement must not contain a number; put numbers in the result lines")
    if readme.find("<!-- problem:start -->") > readme.find("Result (n ="):
        die("problem statement must open the README before the result")


def check_numbers(readme: str, claims: dict) -> None:
    prose = prose_without_claims(readme)
    for literal in (claims["package_version"], claims["policy_version"]):
        if literal not in prose:
            die(f"README prose is missing the checked version {literal}")
        prose = prose.replace(literal, "")
    allowed: set[str] = set()
    for value in claims.values():
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and not isinstance(value, bool):
            allowed.add(str(value))
        elif isinstance(value, float):
            allowed.add(str(value))
    unknown = []
    for token in re.findall(r"\d+(?:\.\d+)?", prose):
        if token not in allowed:
            unknown.append(token)
    if unknown:
        die(f"README numbers that are not recomputed claims: {unknown}")


def check_sentences(readme: str, claims: dict) -> None:
    prose = prose_without_claims(readme)
    for sentence in required_sentences(claims):
        if sentence not in prose:
            die(f"README is missing the recomputed sentence:\n{sentence}")


def check_description(readme: str) -> None:
    description = read_description()
    for phrase in FORBIDDEN:
        if phrase in description:
            die(f"package.json description contains withdrawn wording {phrase!r}")
    if description not in readme:
        die("README does not quote the package.json description")
    if "proposed GitHub About text" not in readme:
        die("README must say the package.json description is the proposed GitHub About text")


def check_forbidden() -> None:
    paths = [README, ROOT / "package.json", ROOT / "Makefile"]
    paths += list((ROOT / "src").rglob("*.ts"))
    paths += list((ROOT / "tests").rglob("*.ts"))
    paths += list((ROOT / "eval").glob("*.py"))
    paths += list((ROOT / "eval").glob("*.ts"))
    paths += list((ROOT / "eval").glob("*.json"))
    paths += list((ROOT / ".github").rglob("*.yml"))
    for path in paths:
        text = path.read_text(encoding="utf-8", errors="replace")
        for phrase in FORBIDDEN:
            if phrase in text:
                die(f"{path.relative_to(ROOT)} contains withdrawn wording {phrase!r}")


def check_failure_modes(claims: dict) -> None:
    if not FAILURES.is_file():
        die("FAILURE_MODES.md is missing")
    text = FAILURES.read_text(encoding="utf-8")
    if not text.startswith("# Failure modes"):
        die("FAILURE_MODES.md must start with its title")
    prose = text
    for literal in (claims["package_version"], claims["policy_version"]):
        prose = prose.replace(literal, "")
    allowed = {str(v) for v in claims.values() if isinstance(v, int) and not isinstance(v, bool)}
    unknown = [token for token in re.findall(r"\d+(?:\.\d+)?", prose) if token not in allowed]
    if unknown:
        die(f"FAILURE_MODES.md numbers that are not recomputed claims: {unknown}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--show", action="store_true", help="print claims and required sentences")
    args = parser.parse_args()
    claims = build_claims()
    if args.show:
        print(json.dumps(claims, indent=2, ensure_ascii=False, sort_keys=True))
        print("\n--- sentences ---")
        for sentence in required_sentences(claims):
            print(sentence)
            print()
        return
    if not README.is_file():
        die("README.md is missing")
    readme = README.read_text(encoding="utf-8")
    documented = extract_claims(readme)
    if documented != claims:
        print(json.dumps(claims, indent=2, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        die("README claims block does not match the recomputed claims")
    check_problem(readme)
    check_sentences(readme, claims)
    check_numbers(readme, claims)
    check_description(readme)
    check_forbidden()
    check_failure_modes(claims)
    print("[check] ok")


if __name__ == "__main__":
    main()
