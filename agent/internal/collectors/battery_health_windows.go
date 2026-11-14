//go:build windows

package collectors

import (
	"log/slog"
	"sync"
	"time"

	"github.com/yusufpapurcu/wmi"
)

// fork: battery health from the ACPI battery WMI classes in root\wmi.
// Capacities are reported in mWh. The values change over weeks, and a WMI query
// is far costlier than the GetSystemPowerStatus syscall the heartbeat makes, so
// they are refreshed in the background at most every batteryHealthTTL and the
// heartbeat only ever reads the cache. A wedged WMI provider therefore never
// delays a heartbeat: the refresh stays "in flight" and no second query is
// queued behind it (wmi.QueryNamespace holds a package-global lock).

const (
	batteryHealthTTL      = 6 * time.Hour
	batteryHealthRetryTTL = 30 * time.Minute
)

type wmiBatteryStaticData struct{ DesignedCapacity uint32 }
type wmiBatteryFullCharged struct{ FullChargedCapacity uint32 }
type wmiBatteryCycleCount struct{ CycleCount uint32 }

type batteryHealthSnapshot struct {
	design, full, cycles *int
}

var batteryHealthCache struct {
	mu        sync.Mutex
	snap      batteryHealthSnapshot
	nextFetch time.Time
	inFlight  bool
}

func applyPlatformBatteryHealth(info *BatteryInfo) {
	c := &batteryHealthCache
	c.mu.Lock()
	snap := c.snap
	if !c.inFlight && time.Now().After(c.nextFetch) {
		c.inFlight = true
		go refreshBatteryHealth()
	}
	c.mu.Unlock()
	info.DesignCapacityMwh = snap.design
	info.FullChargeCapacityMwh = snap.full
	info.CycleCount = snap.cycles
}

func refreshBatteryHealth() {
	snap, err := queryBatteryHealth()
	c := &batteryHealthCache
	c.mu.Lock()
	defer c.mu.Unlock()
	c.inFlight = false
	if err != nil {
		slog.Debug("battery health WMI query failed", "error", err.Error())
		c.nextFetch = time.Now().Add(batteryHealthRetryTTL)
		return
	}
	c.snap = snap
	c.nextFetch = time.Now().Add(batteryHealthTTL)
}

// queryBatteryHealth reads the first system battery. Cycle count is optional:
// many laptops do not implement BatteryCycleCount, which is not an error.
func queryBatteryHealth() (batteryHealthSnapshot, error) {
	var snap batteryHealthSnapshot
	var static []wmiBatteryStaticData
	if err := wmi.QueryNamespace("SELECT DesignedCapacity FROM BatteryStaticData", &static, `root\wmi`); err != nil {
		return snap, err
	}
	var full []wmiBatteryFullCharged
	if err := wmi.QueryNamespace("SELECT FullChargedCapacity FROM BatteryFullChargedCapacity", &full, `root\wmi`); err != nil {
		return snap, err
	}
	if len(static) > 0 {
		snap.design = positiveIntPtr(float64(static[0].DesignedCapacity))
	}
	if len(full) > 0 {
		snap.full = positiveIntPtr(float64(full[0].FullChargedCapacity))
	}
	var cycles []wmiBatteryCycleCount
	if err := wmi.QueryNamespace("SELECT CycleCount FROM BatteryCycleCount", &cycles, `root\wmi`); err == nil && len(cycles) > 0 {
		snap.cycles = positiveIntPtr(float64(cycles[0].CycleCount))
	}
	return snap, nil
}
