//go:build !windows

package collectors

// applyPlatformBatteryHealth is a no-op off Windows: Linux reads health inline
// from sysfs (linuxBatteryHealth), and macOS/BSD do not report it yet.
func applyPlatformBatteryHealth(*BatteryInfo) {}
