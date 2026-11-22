package ru.inpx.server.presentation;

/** Read-only projection for the screen. Credentials and persisted SAF URIs never enter it. */
public final class SourceInfo {
  public final String id, name, kind, location, label, message;
  public final boolean online, cachedIndex, restartRequired;
  public final long indexBytes, indexUpdatedAt, checkedAt, lastSuccess;

  public SourceInfo(
      String id,
      String name,
      String kind,
      String location,
      String label,
      String message,
      boolean online,
      boolean cachedIndex,
      boolean restartRequired,
      long indexBytes,
      long indexUpdatedAt,
      long checkedAt,
      long lastSuccess) {
    this.id = id;
    this.name = name;
    this.kind = kind;
    this.location = location;
    this.label = label;
    this.message = message;
    this.online = online;
    this.cachedIndex = cachedIndex;
    this.restartRequired = restartRequired;
    this.indexBytes = indexBytes;
    this.indexUpdatedAt = indexUpdatedAt;
    this.checkedAt = checkedAt;
    this.lastSuccess = lastSuccess;
  }
}
