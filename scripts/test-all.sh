#!/bin/bash
# test-all.sh -- Runs all test suites: unit, e2e, and build/codegen.
#
# - Unit tests: always run (node --test on tests/*.test.js).
# - E2E tests: auto-skip when ELEVENLABS_API_KEY is unset; run end-to-end
#   smoke against the ElevenLabs API otherwise.
# - Build/codegen tests: syntax-scan generate.cjs + run tests/build/*.test.js
#   which validate SKILL.md frontmatter + structural invariants.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── CONFIGURE ──────────────────────────────────────────────────────
UNIT_TEST_CMD='node --test tests/*.test.js'
E2E_TEST_CMD='node tests/e2e/audiogen-e2e.js'
BUILD_TEST_CMD='node -c .claude/skills/audiogen/generate.cjs && node --test tests/build/*.test.js'
# ────────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

# Track results: name:status pairs (status: pass, fail, skip)
declare -a RESULT_NAMES=()
declare -a RESULT_STATUSES=()

header() {
  printf '\n%b%s%b\n' "$BOLD" "$(printf '=%.0s' {1..60})" "$RESET"
  printf '%b  %s%b\n' "$BOLD" "$1" "$RESET"
  printf '%b%s%b\n\n' "$BOLD" "$(printf '=%.0s' {1..60})" "$RESET"
}

record() {
  RESULT_NAMES+=("$1")
  RESULT_STATUSES+=("$2")
}

has_build_prerequisite() {
  command -v node >/dev/null
}

# ── 1. Unit + integration tests (always) ───────────────────────────

header "Unit + Integration Tests ($UNIT_TEST_CMD)"
if eval "$UNIT_TEST_CMD"; then
  record "Unit/integration" "pass"
else
  record "Unit/integration" "fail"
fi

# ── 2. E2E tests (auto-skip when ELEVENLABS_API_KEY unset) ─────────

header "E2E Tests ($E2E_TEST_CMD)"
E2E_OUT=$(eval "$E2E_TEST_CMD" 2>&1)
EXIT=$?
echo "$E2E_OUT"
if [ "$EXIT" -eq 0 ]; then
  if echo "$E2E_OUT" | grep -q "^\[skipped\]"; then
    record "E2E" "skip"
  else
    record "E2E" "pass"
  fi
else
  record "E2E" "fail"
fi

# ── 3. Build/codegen tests (if prerequisites are met) ──────────────

if has_build_prerequisite; then
  header "Build/Codegen Tests ($BUILD_TEST_CMD)"
  if eval "$BUILD_TEST_CMD"; then
    record "Build/codegen" "pass"
  else
    record "Build/codegen" "fail"
  fi
else
  header "Build/Codegen Tests ($BUILD_TEST_CMD)"
  printf '%b! SKIPPED -- build prerequisite not available%b\n\n' "$YELLOW" "$RESET"
  record "Build/codegen" "skip"
fi

# ── Summary ─────────────────────────────────────────────────────────

header "Summary"

all_passed=true
skip_count=0

for i in "${!RESULT_NAMES[@]}"; do
  name="${RESULT_NAMES[$i]}"
  status="${RESULT_STATUSES[$i]}"
  case "$status" in
    pass) printf '  %bv %s: PASSED%b\n' "$GREEN" "$name" "$RESET" ;;
    fail) printf '  %bx %s: FAILED%b\n' "$RED" "$name" "$RESET"; all_passed=false ;;
    skip) printf '  %b! %s: SKIPPED%b\n' "$YELLOW" "$name" "$RESET"; ((skip_count++)) ;;
  esac
done

if (( skip_count > 0 )); then
  printf '\n%b  %d suite(s) skipped -- see above for how to enable them.%b\n' "$YELLOW" "$skip_count" "$RESET"
fi

echo ''

if $all_passed; then
  exit 0
else
  exit 1
fi
