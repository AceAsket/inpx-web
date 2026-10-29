package ru.inpx.server.presentation;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** One immutable state for both touch and TV; no Android APIs or JSON in the presentation layer. */
public final class DashboardState {
  public enum Phase {
    LOADING,
    STOPPED,
    STARTING,
    RUNNING,
    STOPPING,
    ERROR
  }

  public final Phase phase;
  public final List<SourceInfo> sources;
  public final List<String> addresses;
  public final String detail, journal, uiMode;
  public final int preferredPort, activePort;
  public final boolean demo, restartRequired, checkingSources;
  public final long freeBytes;

  public DashboardState(
      Phase phase,
      List<SourceInfo> sources,
      List<String> addresses,
      String detail,
      String journal,
      String uiMode,
      int preferredPort,
      int activePort,
      boolean demo,
      boolean restartRequired,
      boolean checkingSources,
      long freeBytes) {
    this.phase = phase;
    this.sources = Collections.unmodifiableList(new ArrayList<>(sources));
    this.addresses = Collections.unmodifiableList(new ArrayList<>(addresses));
    this.detail = detail;
    this.journal = journal;
    this.uiMode = uiMode;
    this.preferredPort = preferredPort;
    this.activePort = activePort;
    this.demo = demo;
    this.restartRequired = restartRequired;
    this.checkingSources = checkingSources;
    this.freeBytes = freeBytes;
  }

  public static DashboardState initial() {
    return new DashboardState(
        Phase.LOADING,
        Collections.emptyList(),
        Collections.emptyList(),
        "Читаем настройки библиотеки…",
        "",
        "auto",
        12380,
        12380,
        false,
        false,
        false,
        0);
  }

  public boolean online() {
    return phase == Phase.RUNNING;
  }

  public boolean busy() {
    return phase == Phase.LOADING || phase == Phase.STARTING || phase == Phase.STOPPING;
  }

  public String url() {
    return addresses.isEmpty() ? "" : "http://" + addresses.get(0) + ":" + activePort;
  }

  public DashboardState withPhase(Phase next, String message) {
    return new DashboardState(
        next,
        sources,
        addresses,
        message,
        journal,
        uiMode,
        preferredPort,
        activePort,
        demo,
        restartRequired,
        checkingSources,
        freeBytes);
  }

  public DashboardState withSourceCheck(boolean checking) {
    return new DashboardState(
        phase,
        sources,
        addresses,
        detail,
        journal,
        uiMode,
        preferredPort,
        activePort,
        demo,
        restartRequired,
        checking,
        freeBytes);
  }

  /** Only structural changes rebuild views, so status polling preserves TV focus and scroll. */
  public String layoutKey() {
    StringBuilder key = new StringBuilder(uiMode);
    for (SourceInfo source : sources) {
      for (String value : new String[] {source.id, source.name, source.kind, source.location})
        key.append('|').append(value.length()).append(':').append(value);
    }
    return key.toString();
  }

  public static int port(String value) {
    try {
      int port = Integer.parseInt(value.trim());
      if (port >= 1024 && port <= 65535) return port;
    } catch (NumberFormatException ignored) {
    }
    throw new IllegalArgumentException("Порт должен быть от 1024 до 65535");
  }
}
