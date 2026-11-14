package collectors

import "testing"

// fork: battery health (design / full-charge capacity, cycle count).

func TestLinuxBatteryHealthFromEnergy(t *testing.T) {
	root := t.TempDir()
	writeSupply(t, root, "BAT0", map[string]string{
		"type": "Battery", "present": "1", "capacity": "79", "status": "Not charging",
		// µWh: 66 Wh design, 52.8 Wh now → 80% health.
		"energy_full_design": "66000000", "energy_full": "52800000", "cycle_count": "312",
	})
	b := collectBatteryFromSysfs(root)
	if b == nil || !b.Present {
		t.Fatalf("expected present battery, got %+v", b)
	}
	if !eqIntPtr(b.DesignCapacityMwh, intPtr(66000)) {
		t.Errorf("design = %v, want 66000", derefInt(b.DesignCapacityMwh))
	}
	if !eqIntPtr(b.FullChargeCapacityMwh, intPtr(52800)) {
		t.Errorf("full = %v, want 52800", derefInt(b.FullChargeCapacityMwh))
	}
	if !eqIntPtr(b.CycleCount, intPtr(312)) {
		t.Errorf("cycles = %v, want 312", derefInt(b.CycleCount))
	}
}

func TestLinuxBatteryHealthFromCharge(t *testing.T) {
	root := t.TempDir()
	writeSupply(t, root, "BAT0", map[string]string{
		"type": "Battery", "present": "1", "status": "Discharging",
		// µAh at 11.55 V min design: 4000 mAh → 46200 mWh, 3500 mAh → 40425 mWh.
		"charge_full_design": "4000000", "charge_full": "3500000", "voltage_min_design": "11550000",
	})
	b := collectBatteryFromSysfs(root)
	if !eqIntPtr(b.DesignCapacityMwh, intPtr(46200)) {
		t.Errorf("design = %v, want 46200", derefInt(b.DesignCapacityMwh))
	}
	if !eqIntPtr(b.FullChargeCapacityMwh, intPtr(40425)) {
		t.Errorf("full = %v, want 40425", derefInt(b.FullChargeCapacityMwh))
	}
	if b.CycleCount != nil {
		t.Errorf("cycles = %v, want nil (not reported)", derefInt(b.CycleCount))
	}
}

func TestLinuxBatteryHealthChargeWithoutVoltageIsUnknown(t *testing.T) {
	root := t.TempDir()
	writeSupply(t, root, "BAT0", map[string]string{
		"type": "Battery", "present": "1", "charge_full_design": "4000000", "charge_full": "3500000",
	})
	b := collectBatteryFromSysfs(root)
	if b.DesignCapacityMwh != nil || b.FullChargeCapacityMwh != nil {
		t.Errorf("capacities must stay unknown without voltage, got %+v", b)
	}
}

func TestLinuxBatteryHealthZeroIsUnknown(t *testing.T) {
	root := t.TempDir()
	writeSupply(t, root, "BAT0", map[string]string{
		"type": "Battery", "present": "1",
		"energy_full_design": "0", "energy_full": "0", "cycle_count": "0",
	})
	b := collectBatteryFromSysfs(root)
	if b.DesignCapacityMwh != nil || b.FullChargeCapacityMwh != nil || b.CycleCount != nil {
		t.Errorf("zero readings must be omitted, got %+v", b)
	}
}

func TestPositiveIntPtr(t *testing.T) {
	if positiveIntPtr(0) != nil || positiveIntPtr(-5) != nil {
		t.Error("non-positive readings must be nil")
	}
	if got := positiveIntPtr(52799.6); got == nil || *got != 52800 {
		t.Errorf("positiveIntPtr(52799.6) = %v, want 52800", derefInt(got))
	}
}
