$ErrorActionPreference = 'Stop'
$protocol = 'aab.power/v1'
$leaseId = $env:AAB_POWER_LEASE_ID
$mode = $env:AAB_POWER_MODE
$ttlMs = [int]::Parse($env:AAB_POWER_TTL_MS)
$held = $false
$requestId = $null
function Send-Power($value) {
    $value.protocol = $protocol
    [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}
try {
    if ($mode -notin @('system', 'display', 'both') -or $ttlMs -lt 1 -or $ttlMs -gt 300000) { throw 'Invalid power worker configuration.' }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
public static class AabPowerNative {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    public static readonly BlockingCollection<string> Input = new BlockingCollection<string>();
    public static void StartInput() {
        Thread reader = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) Input.Add(line);
            } finally { Input.CompleteAdding(); }
        });
        reader.IsBackground = true;
        reader.Name = "aab-power-input";
        reader.Start();
    }
}
'@
    [uint32]$flags = 2147483648 # ES_CONTINUOUS
    if ($mode -ne 'display') { $flags = $flags -bor 1 } # ES_SYSTEM_REQUIRED
    if ($mode -ne 'system') { $flags = $flags -bor 2 } # ES_DISPLAY_REQUIRED
    $threadId = [AabPowerNative]::GetCurrentThreadId()
    if ([AabPowerNative]::SetThreadExecutionState($flags) -eq 0) { throw 'SetThreadExecutionState failed.' }
    $held = $true
    $coverage = @{ mechanism = 'SetThreadExecutionState'; scope = 'host-idle'; system = ($mode -ne 'display'); display = ($mode -ne 'system'); manualSleep = 'not_prevented'; unlock = $false; screenSaver = 'not_prevented'; threadId = $threadId; pid = $PID }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $deadline = $clock.ElapsedMilliseconds + $ttlMs
    Send-Power @{ type = 'ready'; ok = $true; leaseId = $leaseId; coverage = $coverage }
    # Console.In.ReadLineAsync can run synchronously. A separate reader leaves
    # the assertion-owning thread free to enforce TTL even while stdin is open.
    [AabPowerNative]::StartInput()
    while ($true) {
        $remaining = $deadline - $clock.ElapsedMilliseconds
        [string]$line = $null
        if ($remaining -le 0 -or -not [AabPowerNative]::Input.TryTake([ref]$line, [int]$remaining)) { break }
        $message = $line | ConvertFrom-Json
        $requestId = $message.requestId
        if ($message.operation -eq 'release') { break }
        if ($message.operation -ne 'renew' -or $message.ttlMs -lt 1 -or $message.ttlMs -gt 300000) { throw 'Invalid power renewal.' }
        $deadline = $clock.ElapsedMilliseconds + [int]$message.ttlMs
        Send-Power @{ ok = $true; requestId = $requestId; coverage = $coverage }
        $requestId = $null
    }
} catch {
    Send-Power @{ ok = $false; error = 'power_windows_failed'; message = $_.Exception.Message; requestId = $requestId }
} finally {
    if ($held) {
        if ([AabPowerNative]::GetCurrentThreadId() -ne $threadId -or [AabPowerNative]::SetThreadExecutionState([uint32]2147483648) -eq 0) {
            Send-Power @{ ok = $false; error = 'power_windows_release_failed'; message = 'The original execution thread did not confirm release.'; requestId = $requestId }
        } else {
            Send-Power @{ ok = $true; type = 'released'; released = $true; requestId = $requestId }
        }
    }
}
