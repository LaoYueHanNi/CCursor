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
    uninstall 按相反顺序还原备份并删除扩展目录。因此
    update == uninstall + install，改了扩展或补丁之后直接 update 即可。

.PARAMETER Action
    要执行的动作，默认 status（只读，最安全）。
      install    安装：释放默认配置 → 解压 vsix → 按顺序打全部补丁
      uninstall  卸载：按备份倒序还原所有补丁 → 删除 cursor2plus 扩展目录
      update     更新：先 uninstall 再 install
      status     检查各组补丁与 ~/.ccursor 配置的当前状态（只读）
      check      干跑：校验所有 AST 补丁锚点是否仍可命中，不改动任何文件
      help       显示本帮助与路径信息

.PARAMETER InstallerDir
    installer 包所在目录，默认为脚本同级的 installer/。

.EXAMPLE
    ./ccursor.ps1 update
    重新部署扩展与全部补丁（先还原再安装）。

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
    [Parameter(Position = 0, HelpMessage = '要执行的动作：install / uninstall / update / status / check / help')]
    [ValidateSet('install', 'uninstall', 'update', 'status', 'check', 'help')]
    [string]$Action = 'status',

    [Parameter(HelpMessage = 'installer 包所在目录，默认为脚本同级的 installer/')]
    [string]$InstallerDir
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
  ./ccursor.ps1 [-Action] <install|uninstall|update|status|check|help> [-InstallerDir <路径>]

动作:
  install      安装：释放 ~/.ccursor 默认配置 → 解压 vsix → 打全部补丁
  uninstall    卸载：按备份倒序还原所有补丁 → 删除 cursor2plus 扩展目录
  update       更新：先 uninstall 再 install（改了扩展或补丁后重新部署）
  status       查看当前安装状态（默认动作，只读）
  check        干跑：校验各补丁锚点是否仍可命中（只读）
  help         显示本帮助

前置条件:
  - Node.js >= 18
  - installer/dist/cli.cjs 已构建：installer 目录下执行 npm run build
  - install / update 需要 installer/vsix/*.vsix：installer 目录下执行 npm run build:vsix

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
Write-Head "ccursor $Action"
& node $cliPath $Action
$exitCode = $LASTEXITCODE

Write-Host ''
if ($exitCode -ne 0) {
    Write-Err "ccursor $Action 失败（退出码 $exitCode）"
    exit $exitCode
}

Write-Ok "ccursor $Action 执行完成"
if ($Action -in 'install', 'uninstall', 'update') {
    Write-Warn '请重启 Cursor 使改动生效。'
}
exit 0
