#!/usr/bin/env bash
set -euo pipefail

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_json="$root/package.json"
tauri_conf="$root/src-tauri/tauri.conf.json"
cargo_toml="$root/src-tauri/Cargo.toml"

for file in "$package_json" "$tauri_conf" "$cargo_toml"; do
  [[ -f "$file" ]] || { echo "error: missing ${file#"$root"/}" >&2; exit 1; }
done

package_version="$(jq -r '.version' "$package_json")"
tauri_version="$(jq -r '.version' "$tauri_conf")"
cargo_version="$(sed -n '/^\[package\]/,/^\[/{s/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p;}' "$cargo_toml" | head -n 1)"

echo "package.json:              $package_version"
echo "src-tauri/tauri.conf.json: $tauri_version"
echo "src-tauri/Cargo.toml:      $cargo_version"

if [[ -z "$cargo_version" || "$package_version" != "$tauri_version" || "$package_version" != "$cargo_version" ]]; then
  echo "error: versions do not match" >&2
  exit 1
fi

echo "ok: all versions are $package_version"
