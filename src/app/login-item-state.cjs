'use strict';

function loginItemEnabled(settings, executablePath) {
  if (typeof settings?.executableWillLaunchAtLogin === 'boolean') {
    return settings.executableWillLaunchAtLogin;
  }
  if (Array.isArray(settings?.launchItems)) {
    const executable = String(executablePath || '').toLowerCase();
    return settings.launchItems.some(item =>
      item?.enabled && item.path?.toLowerCase() === executable);
  }
  return settings?.openAtLogin === true;
}

module.exports = { loginItemEnabled };
