<#
.SYNOPSIS
    Cursor++ 安装 / 更新 / 卸载入口 —— 校验后转发给 installer 包的 CLI。

.DESCRIPTION
    installer/ 是 Cursor++ 的安装包（npm 包名 @cometix/ccursor）：
    esbuild 把 src/cli.js 打成 dist/cli.cjs，对外暴露 install / uninstall /
    update / status / check 等子命令。本脚本不含任何安装逻辑，只做前置校验
    与参数转发，保证在本地开发时用一条命令就能走完整套流程。

    安装链路（installer/src/install.js）:
      0. detect.js             定位 Cursor 的 resources/app（CCURSOR_CURSOR_ROOT 优先）
      1. release-defaults.js   释放 ~/.ccursor/{routes,providers,web-tools}.json
                               以及 models-catalog.json（routes/catalog 强制覆盖，
                               providers 保留已有 API Key）
      2. extension-embed.js    把 installer/vsix/*.vsix 解压到
                               Cursor/resources/app/extensions/cursor2plus/
      3. patch-inject.js       渲染进程 hook（workbench.desktop.main.js + glass）
      4. patch-always-local.js 扩展宿主签名绕过 + cursor-always-local HTTP/1.1 路由
      5. patch-agent-host.js   cursor-agent-host 独立 transport（Cursor 3.13+）
      6. patch-proxy-39.js     Cursor 3.9+ always-local singleton BYOK router
      7. patch-katex.js        workbench.html 的 KaTeX CSS

    每组补丁在落盘前都会写一份 <file>.backup-byok-<tag>-<ts> 备份；
    uninstall 按相反顺序还原备份并删除扩展目录。

    install / update 均为一条龙部署：前置自动执行 installer 的 build:vsix
    （保证部署的 vsix 与当前源码一致，避免"忘打包部署旧产物"），
    再 uninstall（容错，首次安装时此步失败可忽略）→ install。
    之所以要先卸载：installer 的 install 幂等预检在"扩展已装 + 补丁完好"时
    直接返回，新 vsix 永远不会被解压 —— 必须先卸载重装才能更新扩展。

.PARAMETER Action
    要执行的动作，默认 status（只读，最安全）。
      install    一条龙部署：build:vsix → uninstall(容错) → install
      uninstall  卸载：按备份倒序还原所有补丁 → 删除 cursor2plus 扩展目录
      update     与 install 相同（保留别名兼容）
      build      只打包 vsix（check-types + lint + esbuild + vsce package），不部署
      status     检查各组补丁与 ~/.ccursor 配置的当前状态（只读）
      check      干跑：校验所有 AST 补丁锚点是否仍可命中，不改动任何文件
      help       显示本帮助与路径信息

.PARAMETER InstallerDir
    installer 包所在目录，默认为脚本同级的 installer/。

.PARAMETER SkipBuild
    install / update 时跳过前置 build:vsix（用于手动打包后的纯重装场景）。

.EXAMPLE
    ./ccursor.ps1 install
    改完代码后一条龙部署：自动打包 vsix → 卸载重装 → 提示重启 Cursor。

.EXAMPLE
    ./ccursor.ps1 install -SkipBuild
    跳过打包，用 installer/vsix/ 里现有的包重装。

.EXAMPLE
    ./ccursor.ps1 check
    Cursor 升级之后先干跑一遍，确认补丁锚点仍然命中再 install。

.EXAMPLE
    ./ccursor.ps1 status -InstallerDir D:\work\CCursor\installer
    指定另一份 installer 包查看安装状态。

.NOTES
    Cursor 装在非默认目录时，先把当前会话的 CCURSOR_CURSOR_ROOT 指向
    resources/app 目录，脚本会原样透传给 installer。
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, HelpMessage = '要执行的动作：install / uninstall / update / build / status / check / help')]
    [ValidateSet('install', 'uninstall', 'update', 'build', 'status', 'check', 'help')]
    [string]$Action = 'status',

    [Parameter(HelpMessage = 'installer 包所在目录，默认为脚本同级的 installer/')]
    [string]$InstallerDir,

    [Parameter(HelpMessage = 'install / update 时跳过前置 build:vsix')]
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------- 控制台编码：保证脚本中文与 installer 的 ANSI 着色输出正常 ----------
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}
catch {
    # 受限环境下设置编码可能失败，不影响后续流程
}

function Write-Head { param([string]$Text) Write-Host ''; Write-Host "== $Text ==" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "[OK] $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "[!] $Text" -ForegroundColor Yellow }
function Write-Err  { param([string]$Text) Write-Host "[X] $Text" -ForegroundColor Red }

# ---------- 1. 定位脚本与 installer 包 ----------
$repoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $InstallerDir) { $InstallerDir = Join-Path $repoRoot 'installer' }

if ($Action -eq 'help') {
    Write-Host @'
ccursor.ps1 —— Cursor++ 安装 / 更新 / 卸载入口

用法:
  ./ccursor.ps1 [-Action] <install|uninstall|update|build|status|check|help> [-SkipBuild] [-InstallerDir <路径>]

动作:
  install      一条龙部署：build:vsix → uninstall(容错) → install（改完代码后一条命令）
  uninstall    卸载：按备份倒序还原所有补丁 → 删除 cursor2plus 扩展目录
  update       与 install 相同（保留别名兼容）
  build        只打包 vsix（check-types + lint + esbuild + vsce package），不部署
  status       查看当前安装状态（默认动作，只读）
  check        干跑：校验各补丁锚点是否仍可命中（只读）
  help         显示本帮助

选项:
  -SkipBuild   install / update 时跳过前置打包，直接用 installer/vsix/ 里现有的包

前置条件:
  - Node.js >= 18
  - installer/dist/cli.cjs 已构建：installer 目录下执行 npm run build
  - install / update 的前置打包需要 pnpm（或用 -SkipBuild 跳过）

环境变量:
  CCURSOR_CURSOR_ROOT   Cursor 装在非默认目录时指向其 resources/app，会被透传给 installer
'@
    Write-Host ''
    Write-Host ("  installer 目录 : {0}" -f $InstallerDir)
    Write-Host ("  底层 CLI       : {0}" -f (Join-Path $InstallerDir 'dist\cli.cjs'))
    Write-Host ''
    exit 0
}

if (-not (Test-Path -LiteralPath $InstallerDir -PathType Container)) {
    Write-Err "找不到 installer 目录：$InstallerDir"
    Write-Host '  可用 -InstallerDir 指定安装包位置，例如：./ccursor.ps1 status -InstallerDir D:\work\CCursor\installer'
    exit 1
}
$InstallerDir = (Resolve-Path -LiteralPath $InstallerDir).Path

$pkgJsonPath = Join-Path $InstallerDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgJsonPath -PathType Leaf)) {
    Write-Err "$InstallerDir 不是 installer 包（缺少 package.json）"
    exit 1
}
$pkg = Get-Content -LiteralPath $pkgJsonPath -Raw | ConvertFrom-Json

$cliPath = Join-Path $InstallerDir 'dist\cli.cjs'
$vsixDir = Join-Path $InstallerDir 'vsix'

# ---------- 2. 前置校验 ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err '未找到 node，installer CLI 需要 Node.js >= 18'
    exit 1
}

$nodeVersion = (& node -p 'process.versions.node' 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) {
    Write-Err '无法执行 node，请检查 Node.js 安装是否完整'
    exit 1
}
if ([version]$nodeVersion -lt [version]'18.0.0') {
    Write-Err "Node.js 版本过低：$nodeVersion，需要 >= 18"
    exit 1
}

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    Write-Err "缺少构建产物：$cliPath"
    Write-Host '  请先打包 installer CLI：'
    Write-Host ("    cd `"{0}`"; npm run build" -f $InstallerDir)
    exit 1
}

Write-Host ("{0} v{1}  ·  node {2}" -f $pkg.name, $pkg.version, $nodeVersion)

# ---------- 2.5 install / update / build 的前置打包：保证 vsix 与当前源码一致 ----------
# 踩过的坑：改了扩展源码却直接 install，部署的仍是旧 vsix（扩展目录不变时
# installer 的幂等预检也会跳过重装）。因此 install/update/build 默认先自动打包。
if ($Action -in 'install', 'update', 'build' -and -not ($SkipBuild -and $Action -ne 'build')) {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Err '未找到 pnpm，无法自动打包 vsix（build:vsix 需要 pnpm）'
        Write-Host '  手动打包后可加 -SkipBuild 跳过此步：'
        Write-Host ("    cd `"{0}`"; npm run build:vsix" -f $InstallerDir)
        Write-Host '  或仅用现有 vsix 重装：./ccursor.ps1 install -SkipBuild'
        exit 1
    }
    Write-Head 'build:vsix (前置打包, install/update 可用 -SkipBuild 跳过)'
    # 打包子进程可能向 stderr 写进度, 受限的 ErrorActionPreference 会把它误判为终止错误
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location $InstallerDir
        try { npm run build:vsix }
        finally { Pop-Location }
    }
    finally {
        $ErrorActionPreference = $prevEap
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Err 'build:vsix 失败，中止'
        exit $LASTEXITCODE
    }
}

# build 动作到打包为止, 不转发给 CLI (CLI 无此子命令)
if ($Action -eq 'build') {
    Write-Ok 'build:vsix 完成（未部署；部署请运行 install / update）'
    exit 0
}

# install / update 依赖 vsix：installer 只会解压 vsix 目录里的一个包
if ($Action -in 'install', 'update') {
    $vsixFiles = @()
    if (Test-Path -LiteralPath $vsixDir -PathType Container) {
        $vsixFiles = @(Get-ChildItem -LiteralPath $vsixDir -Filter '*.vsix' -File | Sort-Object LastWriteTime -Descending)
    }
    if ($vsixFiles.Count -eq 0) {
        Write-Err "vsix 目录下没有 .vsix，扩展会安装失败：$vsixDir"
        Write-Host '  请先打包扩展（需要 Cursor++ 依赖已安装）：'
        Write-Host ("    cd `"{0}`"; npm run build:vsix" -f $InstallerDir)
        exit 1
    }

    Write-Host '可用扩展包:'
    foreach ($f in $vsixFiles) {
        Write-Host ("  - {0} ({1:N1} MB)" -f $f.Name, ($f.Length / 1MB))
    }
    if ($vsixFiles.Count -gt 1) {
        Write-Warn "vsix 目录下有 $($vsixFiles.Count) 个包，installer 只会解压其中一个；建议清理到只保留目标版本。"
    }
}

# ---------- 3. 运行中的 Cursor 提示 ----------
if ($Action -in 'install', 'uninstall', 'update') {
    $cursorProcs = @(Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue)
    if ($cursorProcs.Count -gt 0) {
        Write-Warn "检测到 $($cursorProcs.Count) 个 Cursor 进程正在运行；建议完全退出 Cursor 再执行 $Action，改动完成后也需要重启 Cursor 才生效。"
    }
}

# ---------- 4. 转发给 installer CLI ----------
# install / update 一条龙收尾：先卸载（容错，首次安装时此步失败可忽略）再安装。
# 直接 install 会被 installer 的幂等预检拦下（"Already fully installed"），
# 新 vsix 永远不会被解压 —— 必须先卸载重装才能更新扩展。
if ($Action -in 'install', 'update') {
    Write-Head 'ccursor uninstall (重装前置, 首次安装时此步失败可忽略)'
    & node $cliPath uninstall
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'uninstall 未成功（通常是首次安装，无可卸载内容），继续安装'
    }
    $cliAction = 'install'
}
else {
    $cliAction = $Action
}

Write-Head "ccursor $cliAction"
& node $cliPath $cliAction
$exitCode = $LASTEXITCODE

Write-Host ''
if ($exitCode -ne 0) {
    Write-Err "ccursor $cliAction 失败（退出码 $exitCode）"
    exit $exitCode
}

Write-Ok "ccursor $cliAction 执行完成"
if ($Action -in 'install', 'uninstall', 'update') {
    Write-Warn '请重启 Cursor 使改动生效。'
}
exit 0
