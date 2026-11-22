package ru.inpx.server.presentation;

public final class PowerSettings {
  public final boolean keepAwake, autoBoot, stopOnBattery, charging, batteryExempt;
  public final boolean lowPowerStandby, lowPowerExempt;

  public PowerSettings(
      boolean keepAwake,
      boolean autoBoot,
      boolean stopOnBattery,
      boolean charging,
      boolean batteryExempt,
      boolean lowPowerStandby,
      boolean lowPowerExempt) {
    this.keepAwake = keepAwake;
    this.autoBoot = autoBoot;
    this.stopOnBattery = stopOnBattery;
    this.charging = charging;
    this.batteryExempt = batteryExempt;
    this.lowPowerStandby = lowPowerStandby;
    this.lowPowerExempt = lowPowerExempt;
  }
}
