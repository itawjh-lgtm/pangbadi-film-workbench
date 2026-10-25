#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
studio_python="/Library/Frameworks/Python.framework/Versions/3.14/bin/python3"
if [[ ! -x "$studio_python" ]]; then
  studio_python="$(command -v python3)"
fi
"$studio_python" desktop/service_manager.py ensure --project-root "$PWD" --port 8767
