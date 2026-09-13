#!/usr/bin/env bash
#
# ccursor.sh —— Cursor++ 安装 / 更新 / 卸载入口（macOS / Linux）
#
# installer/ 是 Cursor++ 的安装包（npm 包名 @cometix/ccursor）：
# esbuild 把 src/cli.js 打成 dist/cli.cjs，对外暴露 install / uninstall /
# update / status / check 等子命令。本脚本不含任何安装逻辑，只做前置校验
# 与参数转发，行为与根目录的 ccursor.ps1（Windows）保持一致。
#
# 安装链路（installer/src/install.js）:
#   0. detect.js             定位 Cursor 的 resources/app
#                             macOS: /Applications/Cursor.app/Contents/Resources/app
#                             Linux: /opt/Cursor/resources/app 等
#                             CCURSOR_CURSOR_ROOT 优先级最高
#   1. release-defaults.js   释放 ~/.ccursor/{routes,providers,web-tools}.json
#                            以及 models-catalog.json（routes/catalog 强制覆盖，
#                            providers 保留已有 API Key）
#   2. extension-embed.js    把 installer/vsix/*.vsix 解压到
#                            <app>/extensions/cursor2plus/
#   3. patch-inject.js       渲染进程 hook（workbench.desktop.main.js + glass）
#   4. patch-always-local.js 扩展宿主签名绕过 + cursor-always-local HTTP/1.1 路由
#   5. patch-agent-host.js   cursor-agent-host 独立 transport（Cursor 3.13+）
#   6. patch-proxy-39.js     Cursor 3.9+ always-local singleton BYOK router
#   7. patch-katex.js        workbench.html 的 KaTeX CSS
#
# 每组补丁在落盘前都会写一份 <file>.backup-byok-<tag>-<ts> 备份；
# uninstall 按相反顺序还原备份并删除扩展目录。
#
# install / update 均为一条龙部署：前置自动执行 installer 的 build:vsix
# （保证部署的 vsix 与当前源码一致，避免"忘打包部署旧产物"），
# 再 uninstall（容错，首次安装时此步失败可忽略）→ install。
# 之所以要先卸载：installer 的 install 幂等预检在"扩展已装 + 补丁完好"时
# 直接返回，新 vsix 永远不会被解压 —— 必须先卸载重装才能更新扩展。
#
# 用法:
#   ./ccursor.sh [<install|uninstall|update|build|status|check|help>] [-d <installer 目录>] [--skip-build]
#
# 前置条件:
#   - Node.js >= 18
#   - installer/dist/cli.cjs 已构建（installer 目录下 npm run build）
#   - install / update 需要 installer/vsix/*.vsix（installer 目录下 npm run build:vsix）
#
# 环境变量:
#   CCURSOR_CURSOR_ROOT   Cursor 装在非默认目录时指向其 resources/app，会被透传给 installer
#
# 权限说明:
#   macOS 的 /Applications、Linux 的 /opt 下的 Cursor 目录可能需要对应用户以外的写权限。
#   打补丁若报 EACCES，请修好该目录的属主/权限后仍以当前用户执行；不建议直接 sudo，
#   因为 sudo 会把 ~/.ccursor 写成 root 所有，之后普通用户启动的 Cursor 读不到配置。

set -u

# ---------- 终端着色：非 tty 或 TERM=dumb 时自动降级为纯文本 ----------
if [ -t 1 ] && [ "${TERM:-dumb}" != 'dumb' ]; then
    C_HEAD=$'\033[36m'
    C_OK=$'\033[32m'
    C_WARN=$'\033[33m'
    C_ERR=$'\033[31m'
    C_RST=$'\033[0m'
else
    C_HEAD=''
    C_OK=''
    C_WARN=''
    C_ERR=''
    C_RST=''
fi

head_msg() { printf '\n%s== %s ==%s\n' "$C_HEAD" "$1" "$C_RST"; }
ok_msg() { printf '%s[OK]%s %s\n' "$C_OK" "$C_RST" "$1"; }
warn_msg() { printf '%s[!]%s %s\n' "$C_WARN" "$C_RST" "$1"; }
err_msg() { printf '%s[X]%s %s\n' "$C_ERR" "$C_RST" "$1" >&2; }

usage() {
    cat <<'EOF'
ccursor.sh —— Cursor++ 安装 / 更新 / 卸载入口（macOS / Linux）

用法:
  ./ccursor.sh [<install|uninstall|update|build|status|check|help>] [-d <installer 目录>] [--skip-build]

动作:
  install      一条龙部署：build:vsix → uninstall(容错) → install（改完代码后一条命令）
  uninstall    卸载：按备份倒序还原所有补丁 → 删除 cursor2plus 扩展目录
  update       与 install 相同（保留别名兼容）
  build        只打包 vsix（check-types + lint + esbuild + vsce package），不部署
  status       查看当前安装状态（默认动作，只读）
  check        干跑：校验各补丁锚点是否仍可命中（只读）
  help         显示本帮助

选项:
  -d, --installer-dir <路径>   installer 包所在目录，默认为脚本同级的 installer/
  -a, --action <动作>          等价于把动作写成第一个位置参数
      --skip-build             install / update 时跳过前置打包，用现有的 vsix 重装
  -h, --help                   显示本帮助

前置条件:
  - Node.js >= 18
  - installer/dist/cli.cjs 已构建：installer 目录下执行 npm run build
  - install / update 的前置打包需要 pnpm（或用 --skip-build 跳过）

环境变量:
  CCURSOR_CURSOR_ROOT   Cursor 装在非默认目录时指向其 resources/app，会被透传给 installer
EOF
}

# ---------- 1. 解析参数 ----------
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

action='status'
installer_dir=''
action_given=''
skip_build='no'

while [ $# -gt 0 ]; do
    case "$1" in
        -a|--action)
            if [ $# -lt 2 ]; then err_msg "$1 缺少参数值"; exit 2; fi
            action="$2"
            action_given='yes'
            shift 2
            ;;
        --action=*)
            action="${1#*=}"
            action_given='yes'
            shift
            ;;
        -d|--installer-dir)
            if [ $# -lt 2 ]; then err_msg "$1 缺少参数值"; exit 2; fi
            installer_dir="$2"
            shift 2
            ;;
        --installer-dir=*)
            installer_dir="${1#*=}"
            shift
            ;;
        --skip-build)
            skip_build='yes'
            shift
            ;;
        -h|--help)
            action='help'
            action_given='yes'
            shift
            ;;
        --)
            shift
            break
            ;;
        -*)
            err_msg "未知参数：$1"
            usage >&2
            exit 2
            ;;
        *)
            if [ -n "$action_given" ]; then
                err_msg "多余的参数：$1"
                usage >&2
                exit 2
            fi
            action="$1"
            action_given='yes'
            shift
            ;;
    esac
done

case "$action" in
    install|uninstall|update|build|status|check|help) ;;
    *)
        err_msg "未知动作：$action（可选 install / uninstall / update / build / status / check / help）"
        exit 2
        ;;
esac

if [ -z "$installer_dir" ]; then
    installer_dir="$script_dir/installer"
fi

if [ "$action" = 'help' ]; then
    usage
    printf '\n  installer 目录 : %s\n' "$installer_dir"
    printf '  底层 CLI       : %s\n\n' "$installer_dir/dist/cli.cjs"
    exit 0
fi

# ---------- 2. 定位 installer 包 ----------
if [ ! -d "$installer_dir" ]; then
    err_msg "找不到 installer 目录：$installer_dir"
    printf '  可用 -d/--installer-dir 指定安装包位置，例如：./ccursor.sh status -d /path/to/CCursor/installer\n'
    exit 1
fi
installer_dir=$(CDPATH= cd -- "$installer_dir" && pwd -P)

pkg_json="$installer_dir/package.json"
if [ ! -f "$pkg_json" ]; then
    err_msg "$installer_dir 不是 installer 包（缺少 package.json）"
    exit 1
fi
pkg_name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_json" | head -n 1)
pkg_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_json" | head -n 1)

# ---------- 3. 前置校验 ----------
if ! command -v node >/dev/null 2>&1; then
    err_msg '未找到 node，installer CLI 需要 Node.js >= 18'
    exit 1
fi

node_version=$(node -p 'process.versions.node' 2>/dev/null || true)
if [ -z "$node_version" ]; then
    err_msg '无法执行 node，请检查 Node.js 安装是否完整'
    exit 1
fi

node_major=${node_version%%.*}
case "$node_major" in
    ''|*[!0-9]*)
        err_msg "无法解析 Node.js 版本：$node_version"
        exit 1
        ;;
esac
if [ "$node_major" -lt 18 ]; then
    err_msg "Node.js 版本过低：$node_version，需要 >= 18"
    exit 1
fi

cli_path="$installer_dir/dist/cli.cjs"
if [ ! -f "$cli_path" ]; then
    err_msg "缺少构建产物：$cli_path"
    printf '  请先打包 installer CLI：\n'
    printf '    cd "%s" && npm run build\n' "$installer_dir"
    exit 1
fi

printf '%s v%s  ·  node %s\n' "${pkg_name:-installer}" "${pkg_version:-?}" "$node_version"

# ---------- 3.5 install / update / build 的前置打包：保证 vsix 与当前源码一致 ----------
# 踩过的坑：改了扩展源码却直接 install，部署的仍是旧 vsix（扩展目录不变时
# installer 的幂等预检也会跳过重装）。因此 install/update/build 默认先自动打包。
if [ "$action" = 'build' ]; then
    do_build='yes'
    skip_build='no'   # build 动作本身就是为了打包, --skip-build 无意义
elif [ "$action" = 'install' ] || [ "$action" = 'update' ]; then
    do_build='yes'
else
    do_build='no'
fi

if [ "$do_build" = 'yes' ] && [ "$skip_build" != 'yes' ]; then
    if ! command -v pnpm >/dev/null 2>&1; then
        err_msg '未找到 pnpm，无法自动打包 vsix（build:vsix 需要 pnpm）'
        printf '  手动打包后可加 --skip-build 跳过此步：\n'
        printf '    cd "%s" && npm run build:vsix\n' "$installer_dir"
        printf '  或仅用现有 vsix 重装：./ccursor.sh install --skip-build\n'
        exit 1
    fi
    head_msg 'build:vsix (前置打包, install/update 可用 --skip-build 跳过)'
    if ! (cd "$installer_dir" && npm run build:vsix); then
        err_msg 'build:vsix 失败，中止'
        exit 1
    fi
fi

# build 动作到打包为止, 不转发给 CLI (CLI 无此子命令)
if [ "$action" = 'build' ]; then
    ok_msg 'build:vsix 完成（未部署；部署请运行 install / update）'
    exit 0
fi

# install / update 依赖 vsix：installer 只会解压 vsix 目录里的一个包
if [ "$action" = 'install' ] || [ "$action" = 'update' ]; then
    vsix_dir="$installer_dir/vsix"
    vsix_count=0
    vsix_list=''

    for candidate in "$vsix_dir"/*.vsix; do
        [ -f "$candidate" ] || continue
        vsix_count=$((vsix_count + 1))
        bytes=$(wc -c < "$candidate" | tr -d ' ')
        size_mb=$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')
        vsix_list="$vsix_list  - $(basename "$candidate") ($size_mb MB)
"
    done

    if [ "$vsix_count" -eq 0 ]; then
        err_msg "vsix 目录下没有 .vsix，扩展会安装失败：$vsix_dir"
        printf '  请先打包扩展（需要 Cursor++ 依赖已安装）：\n'
        printf '    cd "%s" && npm run build:vsix\n' "$installer_dir"
        exit 1
    fi

    printf '可用扩展包:\n%s' "$vsix_list"
    if [ "$vsix_count" -gt 1 ]; then
        warn_msg "vsix 目录下有 $vsix_count 个包，installer 只会解压其中一个；建议清理到只保留目标版本。"
    fi
fi

# ---------- 4. 权限与运行中的 Cursor 提示 ----------
if [ "$action" = 'install' ] || [ "$action" = 'update' ]; then
    current_uid=$(id -u 2>/dev/null || echo '')
    if [ "$current_uid" = '0' ]; then
        warn_msg '当前以 root 身份运行：~/.ccursor 会被写成 root 所有，之后以普通用户启动 Cursor 可能读不到配置。'
    fi
fi

if [ "$action" = 'install' ] || [ "$action" = 'uninstall' ] || [ "$action" = 'update' ]; then
    cursor_proc_count=0
    if command -v pgrep >/dev/null 2>&1; then
        cursor_proc_count=$( { pgrep -x Cursor 2>/dev/null; pgrep -x cursor 2>/dev/null; } | sort -u | grep -c . || true)
    elif command -v ps >/dev/null 2>&1; then
        # 兜底：BSD/macOS 的 ps -o comm= 可能输出完整可执行路径，故按路径尾部匹配
        cursor_proc_count=$(ps -A -o comm= 2>/dev/null | tr -d ' ' | grep -E -c '(^|/)(Cursor|cursor)$' || true)
    fi
    case "${cursor_proc_count:-0}" in
        ''|*[!0-9]*) cursor_proc_count=0 ;;
    esac

    if [ "$cursor_proc_count" -gt 0 ]; then
        warn_msg "检测到 $cursor_proc_count 个 Cursor 进程正在运行；建议完全退出 Cursor 再执行 $action，改动完成后也需要重启 Cursor 才生效。"
    fi
fi

# ---------- 5. 转发给 installer CLI ----------
# install / update 一条龙收尾：先卸载（容错，首次安装时此步失败可忽略）再安装。
# 直接 install 会被 installer 的幂等预检拦下（"Already fully installed"），
# 新 vsix 永远不会被解压 —— 必须先卸载重装才能更新扩展。
cli_action="$action"
if [ "$action" = 'install' ] || [ "$action" = 'update' ]; then
    head_msg 'ccursor uninstall (重装前置, 首次安装时此步失败可忽略)'
    if ! node "$cli_path" uninstall; then
        warn_msg 'uninstall 未成功（通常是首次安装，无可卸载内容），继续安装'
    fi
    cli_action='install'
fi

head_msg "ccursor $cli_action"
node "$cli_path" "$cli_action"
exit_code=$?

printf '\n'
if [ "$exit_code" -ne 0 ]; then
    err_msg "ccursor $cli_action 失败（退出码 $exit_code）"
    exit "$exit_code"
fi

ok_msg "ccursor $cli_action 执行完成"
case "$action" in
    install|uninstall|update)
        warn_msg '请重启 Cursor 使改动生效。'
        ;;
esac
exit 0
