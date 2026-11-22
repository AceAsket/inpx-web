package ru.inpx.server.presentation;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class ServerMemoryTest {
  @Test
  public void autoRaisesLimitOnTypicalArm32DeviceAndOffersTheNextStepAfterAnOom() {
    ServerMemory normal = new ServerMemory(false, 1860, 0, 0, 0, 0, 0, false);
    ServerMemory failed = new ServerMemory(false, 1860, 0, 0, 0, 0, 512, true);
    assertEquals(512, normal.nextStartMiB());
    assertEquals(0, normal.suggestedMiB());
    assertEquals(768, failed.suggestedMiB());
  }

  @Test
  public void smallDeviceDoesNotOfferAnIncreaseAboveItsRamBudget() {
    ServerMemory failed = new ServerMemory(false, 780, 1024, 0, 0, 0, 384, true);
    assertEquals(384, failed.nextStartMiB());
    assertEquals(0, failed.suggestedMiB());
    assertEquals(512, new ServerMemory(false, 930, 0, 0, 0, 0, 384, true).suggestedMiB());
  }

  @Test
  public void alreadyRaisedLimitIsUsedForTheRetry() {
    ServerMemory failed = new ServerMemory(true, 3600, 1280, 0, 0, 0, 1024, true);
    assertEquals(1280, failed.suggestedMiB());
  }
}
