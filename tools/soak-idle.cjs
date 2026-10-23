'use strict';
// One finite idle run of the delivered EXE. No client UI or real profile is driven.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const exe = path.resolve(process.argv[2] || ''), out = path.resolve(process.argv[3] || '');
const durationHours = Number(process.argv[4] || 1);
if (!process.argv[2] || !process.argv[3] || !fs.existsSync(exe) || fs.existsSync(out)) throw new Error('Pass an existing candidate EXE and a new result directory');
if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24) throw new Error('Duration hours must be between 0 and 24');
fs.mkdirSync(out, { recursive: true });
const data = path.join(out, 'isolated-data'), sampleFile = path.join(out, 'samples.jsonl'), resultFile = path.join(out, 'idle-result.json');
fs.mkdirSync(path.join(data, 'empty-sessions'), { recursive: true });
const env = { ...process.env, ISLAND_HUD_TEST_ROOT: data, ISLAND_HUD_DSH_SESSIONS: path.join(data, 'empty-sessions') };
for (const key of Object.keys(env)) if (key !== 'ISLAND_HUD_TEST_ROOT' && (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ISLAND_')) || key === 'ISLAND_HUD_BRIDGE_FILE') delete env[key];
env.ISLAND_TEST_NO_SHORTCUTS = '1';
env.ISLAND_TEST_IDLE_MODE = '1';
const durationMs = durationHours * 3600000, periodMs = 30000, started = Date.now(), samples = [];
const warmupMs = Math.min(600000, durationMs / 6);
const minimumSamples = Math.max(2, Math.floor(durationMs / periodMs));
const sha256 = createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
const artifact = require('./artifact-manifest.cjs').verify(path.dirname(exe));
const child = spawn(exe, [], { env, windowsHide: true, stdio: 'ignore' });
let closing = false, settled = false, timer, finishTimer;
const base = { kind: 'packaged-idle-soak', requestedHours: durationHours, startedAt: new Date(started).toISOString(), exe, sha256, artifact,
  controllerPid: process.pid, applicationPid: child.pid, isolatedData: data, realClientVerification: false };
fs.writeFileSync(resultFile, JSON.stringify({ ...base, status: 'running' }, null, 2));
function ps(command, extra = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' + command],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...env, ...extra } }).replace(/^\uFEFF/, '').trim();
}
function sample() {
  const rows = JSON.parse(ps("$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $owned = [System.Collections.Generic.HashSet[int]]::new(); [void]$owned.Add([int]$env:ISLAND_HUD_SOAK_PID); do { $changed=$false; foreach($item in $processes) { if($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $changed=$true } } } while($changed); $items = @($processes | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p) { [pscustomobject]@{pid=$p.Id;name=$p.ProcessName;privateBytes=$p.PrivateMemorySize64;workingBytes=$p.WorkingSet64;handles=$p.HandleCount;threads=$p.Threads.Count;cpuSeconds=$p.TotalProcessorTime.TotalSeconds} } }); ConvertTo-Json -InputObject $items -Compress",
    { ISLAND_HUD_SOAK_PID: String(child.pid) }) || '[]');
  if (!rows.some(row => row.pid === child.pid)) throw new Error('The candidate main process disappeared');
  const entry = { elapsedMs: Date.now() - started, privateBytes: rows.reduce((sum, row) => sum + row.privateBytes, 0), processes: rows };
  samples.push(entry); fs.appendFileSync(sampleFile, JSON.stringify(entry) + '\n');
}
function finish(error) {
  if (settled) return;
  settled = true; closing = true; clearInterval(timer); clearTimeout(finishTimer);
  try { require('./artifact-manifest.cjs').verify(path.dirname(exe), artifact.sha256); } catch (changed) { error ||= changed; }
  const afterWarmup = samples.filter(row => row.elapsedMs >= warmupMs);
  const mean = list => list.reduce((sum, value) => sum + value, 0) / Math.max(1, list.length);
  const median = list => { const sorted = list.slice().sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 0; };
  const points = afterWarmup.map(row => ({ x: row.elapsedMs / 3600000, y: row.privateBytes / 1048576 }));
  const mx = mean(points.map(p => p.x)), my = mean(points.map(p => p.y));
  const denominator = points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
  const growthMiBPerHour = denominator ? points.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / denominator : 0;
  const windowMs = Math.min(600000, (durationMs - warmupMs) / 3);
  const firstWindow = afterWarmup.filter(row => row.elapsedMs < warmupMs + windowMs);
  const lastWindow = afterWarmup.filter(row => row.elapsedMs >= durationMs - windowMs);
  const first = median(firstWindow.map(row => row.privateBytes)), last = median(lastWindow.map(row => row.privateBytes));
  const growthMiB = (last - first) / 1048576;
  const elapsedMs = Date.now() - started;
  const passed = !error && elapsedMs >= durationMs && samples.length >= minimumSamples && growthMiBPerHour < 2 && growthMiB < 16;
  fs.writeFileSync(resultFile, JSON.stringify({ ...base, status: error ? 'failed' : passed ? 'passed' : 'needs-investigation',
    finishedAt: new Date().toISOString(), elapsedMs, samples: samples.length, growthMiBPerHour, medianGrowthMiB: growthMiB,
    medianWindows: { firstSamples: firstWindow.length, lastSamples: lastWindow.length, minutes: windowMs / 60000, overlap: false },
    processes: [...new Set(afterWarmup.flatMap(row => row.processes.map(p => p.pid)))].map(pid => {
      const values = afterWarmup.flatMap(row => { const p = row.processes.find(item => item.pid === pid); return p ? [{ t: row.elapsedMs / 3600000, ...p }] : []; });
      const mx = mean(values.map(p => p.t)), my = mean(values.map(p => p.privateBytes / 1048576));
      const denominator = values.reduce((sum, p) => sum + (p.t - mx) ** 2, 0);
      return { pid, name: values[0]?.name, samples: values.length, growthMiBPerHour: denominator ? values.reduce((sum, p) => sum + (p.t - mx) * (p.privateBytes / 1048576 - my), 0) / denominator : 0,
        handles: { first: values[0]?.handles, last: values.at(-1)?.handles }, threads: { first: values[0]?.threads, last: values.at(-1)?.threads }, cpuSeconds: values.at(-1)?.cpuSeconds - values[0]?.cpuSeconds };
    }),
    criteria: `${durationHours * 60} minutes, >=${minimumSamples} samples, after ${warmupMs / 60000}-minute warmup: linear private-memory slope <2 MiB/h and non-overlapping first/last ${windowMs / 60000}-minute median growth <16 MiB`,
    ...(error ? { error: error.message } : {}) }, null, 2));
  const quit = spawn(exe, ['--quit-for-maintenance'], { env, windowsHide: true, stdio: 'ignore' });
  quit.unref();
}
child.once('error', finish);
child.once('exit', code => { if (!closing) finish(new Error('Candidate exited early: ' + code)); });
setTimeout(() => {
  try {
    // Hide only windows belonging to this own test PID, keeping the app fully running.
    ps(`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class IslandHUDSoakWindow {
  public delegate bool Visitor(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor v, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  public static void Hide(uint pid) { EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h, out owner); if (owner == pid) ShowWindow(h, 0); return true; }, IntPtr.Zero); }
}
'@; [IslandHUDSoakWindow]::Hide([uint32]$env:ISLAND_HUD_SOAK_PID)`, { ISLAND_HUD_SOAK_PID: String(child.pid) });
    sample(); timer = setInterval(() => { try { sample(); } catch (error) { finish(error); } }, periodMs);
    finishTimer = setTimeout(() => { try { sample(); finish(); } catch (error) { finish(error); } }, Math.max(1, durationMs - (Date.now() - started)));
  } catch (error) { finish(error); }
}, 2500);
