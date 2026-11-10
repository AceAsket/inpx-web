package ru.inpx.server.presentation;

import java.util.Arrays;

/** Memory shown in the dashboard, and allowed old-space limits for this device. */
public final class ServerMemory {
  private static final int[] LIMITS = {256, 384, 512, 768, 1024, 1280, 1536};
  public static final ServerMemory EMPTY = new ServerMemory(false, 0, 0, 0, 0, 0, 0, false);
  public final int deviceMiB, preferredMiB, activeMiB, autoMiB, rssMiB, heapMiB;
  public final boolean exhausted;
  private final int maximumMiB;

  public ServerMemory(
      boolean arm64, int deviceMiB, int preferredMiB, int activeMiB,
      int rssMiB, int heapMiB, int failedMiB, boolean exhausted) {
    this.deviceMiB = deviceMiB;
    this.activeMiB = activeMiB;
    this.rssMiB = rssMiB;
    this.heapMiB = heapMiB;
    this.exhausted = exhausted;
    int budget = Math.min(arm64 ? 1536 : 768, deviceMiB > 0 ? deviceMiB / 2 : 512);
    maximumMiB = Arrays.stream(LIMITS).filter(value -> value <= budget).max().orElse(256);
    autoMiB = Math.min(maximumMiB,
        arm64 ? (deviceMiB >= 2800 ? 1024 : deviceMiB >= 1500 ? 768 : 512)
            : (deviceMiB >= 1500 ? 512 : 384));
    this.preferredMiB =
        Arrays.stream(choices()).anyMatch(value -> value == preferredMiB) ? preferredMiB : 0;
    this.failedMiB = failedMiB;
  }

  private final int failedMiB;

  public int[] choices() {
    return Arrays.stream(LIMITS).filter(value -> value <= maximumMiB).toArray();
  }

  public int nextStartMiB() {
    return preferredMiB == 0 ? autoMiB : preferredMiB;
  }

  public int suggestedMiB() {
    if (!exhausted) return 0;
    if (nextStartMiB() > failedMiB && failedMiB > 0) return nextStartMiB();
    return Arrays.stream(choices()).filter(value -> value > Math.max(failedMiB, nextStartMiB()))
        .findFirst().orElse(0);
  }
}
