#!/bin/bash
set -euo pipefail

PORTABLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORTABLE_PORT="${STUDIO_PORT:-8768}"
PORTABLE_PYTHON="${STUDIO_PYTHON:-python3}"
PORTABLE_FILM_DIR="$PORTABLE_ROOT/prompts/影视Agent团队提示词"
PORTABLE_GAME_DIR="$PORTABLE_ROOT/prompts/游戏Agent团队提示词"

if ! command -v "$PORTABLE_PYTHON" >/dev/null 2>&1; then
  printf '%s\n' '未找到 Python 3。请安装 Python 3 后重新打开此脚本。'
  exit 1
fi
if [[ ! "$PORTABLE_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( PORTABLE_PORT > 65535 )); then
  printf '%s\n' 'STUDIO_PORT 必须是 1—65535 的端口号。'
  exit 1
fi
for PORTABLE_PROMPT_DIR in "$PORTABLE_FILM_DIR" "$PORTABLE_GAME_DIR"; do
  if [[ ! -d "$PORTABLE_PROMPT_DIR" ]]; then
    printf '缺少提示词目录：%s\n请使用包含 prompts 文件夹的完整交付包。\n' "$PORTABLE_PROMPT_DIR"
    exit 1
  fi
done

cd "$PORTABLE_ROOT"
printf '正在启动庞巴迪影视工作台…\n启动成功后打开：http://127.0.0.1:%s/\n运行数据保存在：%s/data/portable-runtime\n按 Control+C 停止服务。\n\n' "$PORTABLE_PORT" "$PORTABLE_ROOT"
exec "$PORTABLE_PYTHON" -m server.httpd \
  --port "$PORTABLE_PORT" \
  --data-dir "$PORTABLE_ROOT/data/portable-runtime" \
  --film-dir "$PORTABLE_FILM_DIR" \
  --game-dir "$PORTABLE_GAME_DIR"
