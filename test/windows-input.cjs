'use strict';
// Real Windows pointer input shared by the GUI regression runners.
//
// The suites used to compile P/Invoke through `powershell Add-Type` for every
// click. Hosts that deny the C# compiler to a nested PowerShell process made
// those runners fail for environmental reasons, so the compiled helper is
// preferred; the PowerShell path remains as a fallback for machines without it.
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const helper = path.resolve(__dirname, '../src/tools/input-helper.exe');

let availableCache;
function available() {
  return fs.existsSync(helper);
}

/** Whether this host lets us write real pointer input (some sessions do not). */
function injectionAvailable() {
  if (availableCache !== undefined) return availableCache;
  if (!available()) { availableCache = true; return availableCache; }
  try {
    execFileSync(helper, ['probe'], { windowsHide: true, timeout: 5000 });
    availableCache = true;
  } catch {
    availableCache = false;
  }
  return availableCache;
}

/** Current pointer position in physical pixels. */
function cursorPosition() {
  if (available()) {
    const [x, y] = execFileSync(helper, ['cursor'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim().split(',').map(Number);
    return { x, y };
  }
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  const [x, y] = value.split(',').map(Number);
  return { x, y };
}

/** Move the pointer without clicking. */
function setCursorPosition(x, y) {
  const px = Math.round(x), py = Math.round(y);
  if (available()) {
    execFileSync(helper, ['move', String(px), String(py)], { windowsHide: true, timeout: 5000 });
    return;
  }
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandHUDCursor {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
'@
[IslandHUDCursor]::SetCursorPos(${px}, ${py}) | Out-Null
`], { windowsHide: true, timeout: 5000 });
}

/** Click at a renderer coordinate (DIP); converted to physical pixels here. */
function clickAt(x, y) {
  const physical = require('electron').screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  const px = Math.round(physical.x), py = Math.round(physical.y);
  return new Promise((resolve, reject) => {
    if (available()) {
      execFile(helper, ['click', String(px), String(py)], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve());
      return;
    }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandHUDMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[IslandHUDMouse]::SetCursorPos(${px}, ${py}) | Out-Null
Start-Sleep -Milliseconds 120
[IslandHUDMouse]::SetCursorPos(${px - 18}, ${py}) | Out-Null
Start-Sleep -Milliseconds 80
[IslandHUDMouse]::SetCursorPos(${px}, ${py}) | Out-Null
Start-Sleep -Milliseconds 120
[IslandHUDMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[IslandHUDMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve());
  });
}

module.exports = { available, injectionAvailable, cursorPosition, setCursorPosition, clickAt };
