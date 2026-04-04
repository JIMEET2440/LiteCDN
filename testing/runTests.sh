#!/bin/bash

# =============================================================
#  LiteCDN Test Runner
# =============================================================
# Runs all test scripts sequentially and generates a summary
# =============================================================

GATEWAY_URL="http://localhost:3000"
TEST_DIR="testing"
LOG_DIR="$TEST_DIR/logs"

mkdir -p "$LOG_DIR"

echo "==========================================="
echo "        LiteCDN Test Runner"
echo "==========================================="

# ── Step 1: Check if CDN is running ─────────────────────────

echo -e "\n[1] Checking CDN status..."

STATUS=$(curl -s "$GATEWAY_URL/status")

if [[ $STATUS != *"UP"* ]]; then
  echo "❌ CDN is NOT running at $GATEWAY_URL"
  echo "Start your servers first."
  exit 1
fi

echo "✅ CDN is running"

# ── Step 2: Run Tests ───────────────────────────────────────

run_test () {
  NAME=$1
  FILE=$2

  echo -e "\n-------------------------------------------"
  echo "Running: $NAME"
  echo "-------------------------------------------"

  node "$TEST_DIR/$FILE" | tee "$LOG_DIR/$FILE.log"
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ $NAME PASSED"
  else
    echo "⚠️  $NAME FAILED (check logs)"
  fi
}

run_test "Routing Test" "testRouting.js"
run_test "Cache Test" "testCache.js"
run_test "Load Test" "testLoad.js"
run_test "Zipf Workload Test" "testZipf.js"

# ── Step 3: Summary ─────────────────────────────────────────

echo -e "\n==========================================="
echo "           TEST SUMMARY"
echo "==========================================="

for file in testRouting.js testCache.js testLoad.js testZipf.js
do
  if grep -q "FAILED" "$LOG_DIR/$file.log"; then
    echo "$file → ❌ Issues detected"
  else
    echo "$file → ✅ Completed"
  fi
done

echo -e "\nLogs saved in: $LOG_DIR"
echo "==========================================="