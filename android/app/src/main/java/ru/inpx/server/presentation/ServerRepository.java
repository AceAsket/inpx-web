package ru.inpx.server.presentation;

/**
 * Boundary for persistence, platform services and network probes. Methods run off the UI thread.
 */
public interface ServerRepository {
  DashboardState load() throws Exception;

  void start(boolean demo) throws Exception;

  void stop() throws Exception;

  void checkSources() throws Exception;

  SourceDraft source(String id) throws Exception;

  void saveSource(SourceDraft source) throws Exception;

  void removeSource(String id) throws Exception;

  void savePort(int port) throws Exception;

  void saveMode(String mode) throws Exception;

  PowerSettings power() throws Exception;

  void savePower(boolean awake, boolean boot, boolean stopOnBattery) throws Exception;
}
