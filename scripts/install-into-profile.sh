#!/bin/sh
# 把 dsh-yuque-mcp 安装到 DSH 的某个 profile。
#
#   sh scripts/install-into-profile.sh                 # 默认 desktop
#   sh scripts/install-into-profile.sh desktop web     # 装进多个 profile
#   DSH_BIN=/path/to/dsh sh scripts/install-into-profile.sh tui
#
# 说明：profile 目录在 $DSH_HOME（默认 ~/.dsh）下，Agent 的沙箱写不进去，
# 所以这一步要在终端里手动跑。
set -e

PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"

if [ ! -x "$DSH_BIN" ]; then
  echo "找不到 dsh CLI：$DSH_BIN" >&2
  echo "请用 DSH_BIN=/path/to/dsh 指定，或确认 DeepSeek Harness 已安装。" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- desktop
fi

for profile in "$@"; do
  echo "==> 安装到 profile：$profile"
  "$DSH_BIN" plugin --profile "$profile" add "file:$PLUGIN_DIR"
done

echo
echo "完成。重启 Harness 后可用："
echo "  - yuque_status（诊断 / 换令牌）"
echo "  - mcp__yuque__*（19 个语雀工具）"
