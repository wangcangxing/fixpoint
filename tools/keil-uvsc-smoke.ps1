#requires -version 5
<#
.SYNOPSIS
    Smoke test for the locally built KeilUvscMcp.exe (route 3: UVSOCK debug bridge).

.DESCRIPTION
    Drives the MCP server over real stdio with a pipelined JSON-RPC handshake and
    prints one line per response, so every claim is checkable.

    Facts this script encodes, all verified on this machine (2026-10-15):
      - Framing is newline-delimited JSON (one JSON object per line); stdout carries
        protocol frames only, stderr is separate.
      - initialize answers protocolVersion 2024-11-05, serverInfo keil-uvsc-mcp 0.2.0.
      - 22 tools are registered.
      - attach mode (port 4823) uses the project already open in uVision and never
        replaces it; auto mode may start a dedicated uVision.
      - If UVSOCK is off / uVision is not in Debug, keil_connect fails with
        "UVSC_OpenConnection failed with UVSC status 1" - that is the expected
        negative result, not a bug.

    Order required on the Keil side (cannot be reordered):
      Edit > Configuration > Other > UVSOCK: Enable, Port 4823   (one time, GUI only)
      -> open the project -> enter Debug (Ctrl+F5, Simulator needs no hardware)
      -> then run this script.

.EXAMPLE
    .\keil-uvsc-smoke.ps1
    .\keil-uvsc-smoke.ps1 -ReadVariables 'g_tick','g_led','P1'
#>
param(
    [string]$Exe = 'D:\program\keil-ai-loop\vendor\keil-uvsc-mcp\build\KeilUvscMcp.exe',
    [int]$Port = 4823,
    [string[]]$ReadVariables = @(),
    [switch]$SkipConnect,
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Exe)) { throw "Exe not found: $Exe" }

$tmp = Join-Path $env:TEMP ('keil-uvsc-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$reqFile = Join-Path $tmp 'req.jsonl'
$outFile = Join-Path $tmp 'out.jsonl'
$errFile = Join-Path $tmp 'err.txt'

$requests = New-Object System.Collections.ArrayList
[void]$requests.Add('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"keil-uvsc-smoke","version":"0"}}}')
[void]$requests.Add('{"jsonrpc":"2.0","method":"notifications/initialized"}')
[void]$requests.Add('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
[void]$requests.Add('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"keil_uvsc_info","arguments":{}}}')
if (-not $SkipConnect) {
    [void]$requests.Add(('{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"keil_connect","arguments":{{"mode":"attach","port":{0}}}}}}}' -f $Port))
    [void]$requests.Add('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"keil_get_status","arguments":{}}}')
    if ($ReadVariables.Count -gt 0) {
        $quoted = ($ReadVariables | ForEach-Object { '"' + ($_ -replace '\\', '\\') + '"' }) -join ','
        [void]$requests.Add(('{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"keil_read_variables","arguments":{{"variables":[{0}]}}}}}}' -f $quoted))
    }
    [void]$requests.Add('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"keil_disconnect","arguments":{}}}')
}

Set-Content -LiteralPath $reqFile -Value ($requests -join "`n") -Encoding ASCII -NoNewline
Add-Content -LiteralPath $reqFile -Value "`n" -Encoding ASCII

# Drive the EXE through cmd so stdin/stdout redirection and the exit code are both
# reliable (Start-Process -PassThru did not populate ExitCode on this machine).
$cmdLine = '"{0}" < "{1}" > "{2}" 2> "{3}"' -f $Exe, $reqFile, $outFile, $errFile
& cmd.exe /c $cmdLine | Out-Null
Write-Host ("exit code = {0}" -f $LASTEXITCODE)
Write-Host ("--- stdout frames ({0} file) ---" -f $outFile)

$byId = @{}
foreach ($line in (Get-Content -LiteralPath $outFile -ErrorAction SilentlyContinue)) {
    $text = $line.Trim()
    if (-not $text) { continue }
    try { $obj = $text | ConvertFrom-Json } catch { Write-Host "  [non-JSON line] $text"; continue }
    if ($obj.id) { $byId[[string]$obj.id] = $obj }
}

if ($byId.ContainsKey('1')) {
    $info = $byId['1'].result
    Write-Host ("initialize : protocolVersion={0} server={1} {2}" -f $info.protocolVersion, $info.serverInfo.name, $info.serverInfo.version)
}
if ($byId.ContainsKey('2')) {
    $names = @($byId['2'].result.tools | ForEach-Object { $_.name })
    Write-Host ("tools/list : {0} tools" -f $names.Count)
    Write-Host ("             " + ($names -join ', '))
}
foreach ($id in @('3', '4', '5', '6', '99')) {
    if (-not $byId.ContainsKey($id)) { continue }
    $entry = $byId[$id]
    if ($entry.error) {
        Write-Host ("id={0} ERROR: {1}" -f $id, ($entry.error.message))
        continue
    }
    $result = $entry.result
    $body = $null
    if ($result.structuredContent) { $body = ($result.structuredContent | ConvertTo-Json -Depth 6 -Compress) }
    elseif ($result.content) { $body = (($result.content | ForEach-Object { $_.text }) -join ' | ') }
    else { $body = ($result | ConvertTo-Json -Depth 6 -Compress) }
    Write-Host ("id={0} isError={1}: {2}" -f $id, [bool]$result.isError, $body)
}

$err = Get-Content -LiteralPath $errFile -ErrorAction SilentlyContinue
if ($err) { Write-Host "--- stderr ---"; $err | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" } }
Write-Host ("artifacts kept in: {0}" -f $tmp)
