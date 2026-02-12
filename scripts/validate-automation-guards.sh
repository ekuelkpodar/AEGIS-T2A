#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/3] Validating action examples against canonical schema"
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { Validator } = require('jsonschema');

const schemaPath = path.join(process.cwd(), 'docs/automation/schemas/action.schema.json');
const examplesDir = path.join(process.cwd(), 'docs/automation/examples');

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const v = new Validator();

const files = fs.readdirSync(examplesDir).filter((name) => name.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('No action example files found under docs/automation/examples');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const payload = JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8'));
  const result = v.validate(payload, schema);
  if (!result.valid) {
    failures += 1;
    console.error(`Validation failed: ${file}`);
    for (const err of result.errors) {
      console.error(`  - ${err.stack}`);
    }
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log(`Validated ${files.length} action examples`);
NODE

echo "[2/3] Parsing OpenAPI file"
if python3 <<'PY'
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    raise SystemExit(2)

openapi_path = Path('docs/automation/openapi/action-registry.openapi.yaml')
yaml.safe_load(openapi_path.read_text(encoding='utf-8'))
print(f"Parsed OpenAPI YAML via PyYAML: {openapi_path}")
PY
then
  :
elif command -v ruby >/dev/null 2>&1; then
  ruby -e "require 'yaml'; YAML.safe_load(File.read('docs/automation/openapi/action-registry.openapi.yaml')); puts 'Parsed OpenAPI YAML via Ruby YAML'" 
else
  echo "Unable to parse OpenAPI YAML: neither PyYAML nor Ruby YAML is available." >&2
  exit 1
fi

run_opa() {
  if command -v opa >/dev/null 2>&1; then
    opa "$@"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$ROOT_DIR":/work -w /work openpolicyagent/opa:latest "$@"
    return
  fi

  echo "OPA not found (and Docker unavailable). Install OPA or Docker to run Rego checks." >&2
  exit 1
}

validate_decision() {
  local rego_file="$1"
  local data_path="$2"
  local input_file="$3"

  local decision
  decision="$(run_opa eval -d "$rego_file" -I -f raw "$data_path" < "$input_file")"
  case "$decision" in
    allow|require_approval|deny)
      echo "Decision OK for $rego_file: $decision"
      ;;
    *)
      echo "Unexpected decision '$decision' from $rego_file" >&2
      exit 1
      ;;
  esac
}

echo "[3/3] Running OPA format and decision checks"
run_opa fmt --fail policies/examples/industry/*.rego >/dev/null

validate_decision \
  policies/examples/industry/healthcare.rego \
  data.aegis.industry.healthcare.output.decision \
  policies/examples/industry/healthcare.input.json

validate_decision \
  policies/examples/industry/logistics.rego \
  data.aegis.industry.logistics.output.decision \
  policies/examples/industry/logistics.input.json

validate_decision \
  policies/examples/industry/finance.rego \
  data.aegis.industry.finance.output.decision \
  policies/examples/industry/finance.input.json

echo "Automation guard checks passed"
