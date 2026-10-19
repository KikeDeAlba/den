#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

package_version="$(jq -r '.version' "$root/package.json")"
tauri_version="$(jq -r '.version' "$root/src-tauri/tauri.conf.json")"
cargo_version="$(sed -n '/^\[package\]/,/^\[/{s/^version[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p;}' "$root/src-tauri/Cargo.toml" | head -n 1)"

echo "package.json:              $package_version"
echo "src-tauri/tauri.conf.json: $tauri_version"
echo "src-tauri/Cargo.toml:      $cargo_version"

if [[ -z "$cargo_version" || "$package_version" != "$tauri_version" || "$package_version" != "$cargo_version" ]]; then
  echo "error: versions do not match" >&2
  exit 1
fi

echo "ok: all versions are $package_version"
